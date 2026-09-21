import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ProviderSession,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import { Cause, Deferred, Effect, Fiber, Layer, Option, Schedule, Stream } from "effect";
import { makeDrainableWorker, startDrainableWorkerProducers } from "@synara/shared/DrainableWorker";

import { parseCheckpointFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadMessageStart,
  checkpointRefForThreadRevertRescue,
  checkpointRefForThreadTurn,
  checkpointRefForThreadTurnInManagedFamily,
  checkpointRefForThreadTurnLive,
  checkpointRefForThreadTurnStart,
  checkpointRefForThreadTurnStartInManagedFamily,
  isManagedCheckpointRefForThread,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { clearWorkspaceIndexCache } from "../../workspaceEntries.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { TurnCheckpointCoordinator } from "../Services/TurnCheckpointCoordinator.ts";
import { CheckpointInvariantError, type CheckpointStoreError } from "../../checkpointing/Errors.ts";
import { OrchestrationDispatchError } from "../Errors.ts";
import {
  CHECKPOINT_REVERT_FAILED_ACTIVITY_KIND,
  checkpointRevertActiveTurnDetail,
  threadHasInFlightTurn,
} from "../commandInvariants.ts";
import { isGitRepository } from "../../git/isRepo.ts";
import { resolveProviderSessionThread } from "../providerSessionThread.ts";

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

const CHECKPOINT_REACTOR_CAPACITY = 256;

const REVERT_LEASE_ACQUIRE_TIMEOUT_MS = 15_000;

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.makeUnsafe(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function providerSessionHasInFlightTurn(session: ProviderSession | undefined): boolean {
  return (
    session?.status === "connecting" ||
    session?.status === "running" ||
    (session?.status !== "error" && session?.status !== "closed" && session?.activeTurnId != null)
  );
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const ASSISTANT_MESSAGE_ID_RETRY_DELAY_MS = 20;
const ASSISTANT_MESSAGE_ID_RETRY_ATTEMPTS = 6;
const REVERT_FAILURE_ACTIVITY_MAX_RETRIES = 3;

const REVERT_COMPLETE_MAX_RETRIES = 3;

const revertRescueCheckpointRef = (threadId: ThreadId): CheckpointRef =>
  checkpointRefForThreadRevertRescue(threadId, crypto.randomUUID());

function resolveExistingAssistantMessageIdForTurn(
  thread:
    | {
        readonly messages: ReadonlyArray<{
          readonly id: MessageId;
          readonly role: string;
          readonly turnId: TurnId | null;
        }>;
      }
    | undefined,
  turnId: TurnId,
  assistantMessageId: MessageId | undefined,
): MessageId | undefined {
  if (!thread || assistantMessageId === undefined) {
    return undefined;
  }
  return thread.messages.some(
    (entry) =>
      entry.id === assistantMessageId && entry.role === "assistant" && entry.turnId === turnId,
  )
    ? assistantMessageId
    : undefined;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const receiptBus = yield* RuntimeReceiptBus;
  const turnCheckpointCoordinator = yield* TurnCheckpointCoordinator;
  const pendingMessageStartByThread = new Map<ThreadId, MessageId>();
  // coalesces live turn-diff recomputes: at most one queued + one in-flight per thread; flag cleared when the worker starts so an edit mid-git-work re-schedules
  const liveDiffScheduledThreads = new Set<ThreadId>();
  // a scaffolding turn (git init, create-next-app) turns the folder into a repo mid-turn — no turn-start baseline; expected, must not surface as a failure
  const turnsStartedWithoutGitWorkspace = new Map<ThreadId, TurnId>();

  // providers that stream their own diff (Codex) update via ingestion; providers without it (Claude) derive the live diff from git here
  const supportsLiveTurnDiffPatch = Effect.fnUntraced(function* (
    provider: ProviderRuntimeEvent["provider"],
  ) {
    const capabilities = yield* providerService
      .getCapabilities(provider)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    return capabilities?.supportsLiveTurnDiffPatch === true;
  });

  // wait briefly for ingestion to persist the final assistant message id when completion wins the subscriber race
  const resolveAssistantMessageIdForTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly assistantMessageId: MessageId | undefined;
  }) {
    const currentThreadOption = yield* projectionSnapshotQuery.getThreadDetailById(input.threadId);
    const currentThread = Option.getOrUndefined(currentThreadOption);
    const knownInputAssistantMessageId = resolveExistingAssistantMessageIdForTurn(
      currentThread,
      input.turnId,
      input.assistantMessageId,
    );
    if (knownInputAssistantMessageId !== undefined) {
      return knownInputAssistantMessageId;
    }

    for (let attempt = 0; attempt < ASSISTANT_MESSAGE_ID_RETRY_ATTEMPTS; attempt += 1) {
      const threadOption = yield* projectionSnapshotQuery.getThreadDetailById(input.threadId);
      const thread = Option.getOrUndefined(threadOption);
      const candidateAssistantMessageId =
        resolveExistingAssistantMessageIdForTurn(
          thread,
          input.turnId,
          thread?.latestTurn?.turnId === input.turnId
            ? (thread.latestTurn.assistantMessageId ?? undefined)
            : undefined,
        ) ??
        thread?.messages
          .toReversed()
          .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id;

      if (candidateAssistantMessageId !== undefined) {
        return candidateAssistantMessageId;
      }

      if (attempt < ASSISTANT_MESSAGE_ID_RETRY_ATTEMPTS - 1) {
        yield* Effect.sleep(`${ASSISTANT_MESSAGE_ID_RETRY_DELAY_MS} millis`);
      }
    }

    // return undefined rather than a synthetic id — clients scope the card by turnId so null is safe; a synthetic id could collide with a real one
    return undefined;
  });

  // anchor a revert failure on a turn the transcript still renders — clients drop turn-less activities once a thread has turn-stamped messages
  const resolveRevertFailureTurnId = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
  }) {
    const thread = yield* getThreadDetail(input.threadId);
    if (!thread) {
      return null;
    }
    const targetCheckpoint = thread.checkpoints.find(
      (checkpoint) => checkpoint.checkpointTurnCount === input.turnCount,
    );
    if (targetCheckpoint) {
      return targetCheckpoint.turnId;
    }
    const latestCheckpoint = thread.checkpoints.reduce<(typeof thread.checkpoints)[number] | null>(
      (latest, checkpoint) =>
        latest === null || checkpoint.checkpointTurnCount > latest.checkpointTurnCount
          ? checkpoint
          : latest,
      null,
    );
    return latestCheckpoint?.turnId ?? thread.latestTurn?.turnId ?? null;
  });

  const appendRevertFailureActivity = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const turnId = yield* resolveRevertFailureTurnId({
      threadId: input.threadId,
      turnCount: input.turnCount,
    });
    yield* orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: serverCommandId("checkpoint-revert-failure"),
        threadId: input.threadId,
        activity: {
          id: EventId.makeUnsafe(crypto.randomUUID()),
          tone: "error",
          kind: CHECKPOINT_REVERT_FAILED_ACTIVITY_KIND,
          summary: "Checkpoint revert failed",
          payload: {
            turnCount: input.turnCount,
            detail: input.detail,
          },
          turnId,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      })
      .pipe(
        Effect.retry(
          Schedule.addDelay(Schedule.recurs(REVERT_FAILURE_ACTIVITY_MAX_RETRIES), () =>
            Effect.succeed("100 millis"),
          ),
        ),
      );
  });

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-capture-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: "checkpoint.capture.failed",
        summary: "Checkpoint capture failed",
        payload: {
          detail: input.detail,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const resolveSessionRuntimeForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.catch(() => Effect.succeed(Option.none())));
    if (Option.isNone(thread)) {
      return Option.none();
    }

    const sessions = yield* providerService.listSessions();

    const findSessionWithCwd = (
      session: (typeof sessions)[number] | undefined,
    ): Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }> => {
      if (!session?.cwd) {
        return Option.none();
      }
      return Option.some({ threadId: session.threadId, cwd: session.cwd });
    };

    const providerThread = yield* resolveProviderSessionThread(
      projectionSnapshotQuery,
      thread.value.id,
    );
    const sessionThreadId = providerThread?.id ?? thread.value.id;
    const projectedSession = sessions.find((session) => session.threadId === sessionThreadId);
    const fromProjected = findSessionWithCwd(projectedSession);
    if (Option.isSome(fromProjected)) {
      return fromProjected;
    }

    return Option.none();
  });

  const isGitWorkspace = (cwd: string) => isGitRepository(cwd);

  const getThreadDetail = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<OrchestrationThread | undefined> {
    return Option.getOrUndefined(
      yield* projectionSnapshotQuery
        .getThreadDetailById(threadId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none()))),
    );
  });

  const getProjectShell = Effect.fnUntraced(function* (
    projectId: ProjectId,
  ): Effect.fn.Return<OrchestrationProjectShell | undefined> {
    return Option.getOrUndefined(
      yield* projectionSnapshotQuery
        .getProjectShellById(projectId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none()))),
    );
  });

  // prefer the active session cwd, fall back to thread/project config — every checkpoint path shares this policy: mixed sources would diff two different checkouts
  const resolveCheckpointWorkspace = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: Pick<OrchestrationThread, "projectId" | "envMode" | "worktreePath">;
    readonly project: OrchestrationProjectShell;
  }) {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const cwd =
      Option.match(fromSession, {
        onNone: () => undefined,
        onSome: (runtime) => runtime.cwd,
      }) ??
      resolveThreadWorkspaceCwd({
        thread: input.thread,
        projects: [input.project],
      });

    if (!cwd) {
      return undefined;
    }
    return { cwd, isGitRepository: isGitWorkspace(cwd) } as const;
  });

  const resolveCheckpointCwd = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: Pick<OrchestrationThread, "projectId" | "envMode" | "worktreePath">;
    readonly project: OrchestrationProjectShell;
  }) {
    const workspace = yield* resolveCheckpointWorkspace(input);
    return workspace?.isGitRepository ? workspace.cwd : undefined;
  });

  const captureAndDispatchCheckpoint = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
    // the workspace only became a git repo while this turn ran — no baseline could have been captured
    readonly workspaceInitializedDuringTurn: boolean;
  }) {
    const fromCheckpointRef = checkpointRefForThreadTurnStart(input.threadId, input.turnId);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: fromCheckpointRef,
    });
    if (!fromCheckpointExists) {
      if (input.workspaceInitializedDuringTurn) {
        yield* Effect.logDebug(
          "checkpoint capture has no pre-turn baseline: workspace became a git repository during the turn",
          {
            threadId: input.threadId,
            turnId: input.turnId,
            checkpointRef: fromCheckpointRef,
          },
        );
      } else {
        yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
          threadId: input.threadId,
          turnId: input.turnId,
          checkpointRef: fromCheckpointRef,
        });
      }
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });

    // invalidate the workspace entry cache so the @-mention picker sees files created/deleted this turn
    clearWorkspaceIndexCache(input.cwd);

    const checkpointStatus = fromCheckpointExists ? input.status : ("missing" as const);

    const files = fromCheckpointExists
      ? yield* checkpointStore
          .diffCheckpoints({
            cwd: input.cwd,
            fromCheckpointRef,
            toCheckpointRef: targetCheckpointRef,
            fallbackFromToHead: false,
            ignoreWhitespace: false,
          })
          .pipe(
            Effect.flatMap((diff) => parseCheckpointFilesFromUnifiedDiff(diff)),
            Effect.tapError((error) =>
              appendCaptureFailureActivity({
                threadId: input.threadId,
                turnId: input.turnId,
                detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
                createdAt: input.createdAt,
              }),
            ),
            Effect.catch((error) =>
              Effect.logWarning("failed to derive checkpoint file summary", {
                threadId: input.threadId,
                turnId: input.turnId,
                turnCount: input.turnCount,
                detail: error.message,
              }).pipe(Effect.as([])),
            ),
          )
      : input.workspaceInitializedDuringTurn
        ? []
        : yield* appendCaptureFailureActivity({
            threadId: input.threadId,
            turnId: input.turnId,
            detail: "Checkpoint captured, but the turn start baseline is unavailable.",
            createdAt: input.createdAt,
          }).pipe(Effect.as([]));

    const assistantMessageId = yield* resolveAssistantMessageIdForTurn({
      threadId: input.threadId,
      turnId: input.turnId,
      assistantMessageId:
        input.assistantMessageId ??
        input.thread.messages
          .toReversed()
          .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: checkpointStatus,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: checkpointStatus,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: checkpointStatus,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const ensureLegacyBaselineCheckpoint = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly turnCount: number;
    readonly createdAt: string;
  }) {
    const legacyBaselineRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);
    const legacyBaselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: legacyBaselineRef,
    });
    if (legacyBaselineExists) {
      return;
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: legacyBaselineRef,
    });
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId: input.threadId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: legacyBaselineRef,
      createdAt: input.createdAt,
    });
  });

  const captureCheckpointFromTurnCompletion = Effect.fnUntraced(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  ) {
    const turnId = toTurnId(event.turnId);
    if (!turnId) {
      return;
    }

    const thread = yield* getThreadDetail(event.threadId);
    if (!thread) {
      yield* Effect.logDebug("turn-completion checkpoint skipped: thread not found", {
        threadId: event.threadId,
        turnId,
      });
      return;
    }
    const project = yield* getProjectShell(thread.projectId);
    if (!project) {
      yield* Effect.logDebug("turn-completion checkpoint skipped: project not found", {
        threadId: thread.id,
        turnId,
        projectId: thread.projectId,
      });
      return;
    }

    // while a primary turn is active, only that turn may produce completion checkpoints
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
      yield* Effect.logDebug("turn-completion checkpoint skipped: turn is not the active turn", {
        threadId: thread.id,
        turnId,
        activeTurnId: thread.session.activeTurnId,
      });
      return;
    }

    // only skip when a real checkpoint already exists — ingestion may insert "missing" placeholders that must not prevent real capture
    if (
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
      )
    ) {
      return;
    }

    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: thread.id,
      thread,
      project,
    });
    if (!checkpointCwd) {
      yield* Effect.logDebug(
        "turn-completion checkpoint skipped: no git workspace to capture from",
        {
          threadId: thread.id,
          turnId,
          projectId: thread.projectId,
        },
      );
      return;
    }

    // reuse a placeholder's turn count instead of incrementing past it
    const existingPlaceholder = thread.checkpoints.find(
      (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
    );
    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const nextTurnCount = existingPlaceholder
      ? existingPlaceholder.checkpointTurnCount
      : currentTurnCount + 1;

    const workspaceInitializedDuringTurn =
      turnsStartedWithoutGitWorkspace.get(thread.id) === turnId;
    turnsStartedWithoutGitWorkspace.delete(thread.id);

    yield* captureAndDispatchCheckpoint({
      threadId: thread.id,
      turnId,
      thread,
      cwd: checkpointCwd,
      turnCount: nextTurnCount,
      status: checkpointStatusFromRuntime(event.payload.state),
      assistantMessageId: undefined,
      createdAt: event.createdAt,
      workspaceInitializedDuringTurn,
    });
  });

  // snapshots the working tree into a throwaway ref (temp index — real index/worktree untouched) and diffs against the turn-start baseline; the terminal turn.completed capture stays authoritative
  const captureLiveTurnDiff = Effect.fnUntraced(function* (
    event: Extract<ProviderRuntimeEvent, { type: "item.completed" }>,
  ) {
    const turnId = toTurnId(event.turnId);
    if (!turnId) {
      return;
    }

    const thread = yield* getThreadDetail(event.threadId);
    if (!thread) {
      return;
    }
    const project = yield* getProjectShell(thread.projectId);
    if (!project) {
      return;
    }

    // only the active primary turn may emit live diffs
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
      return;
    }

    // never override a real checkpoint already captured by the terminal path
    const existingForTurn = thread.checkpoints.find((checkpoint) => checkpoint.turnId === turnId);
    if (existingForTurn && existingForTurn.status !== "missing") {
      return;
    }

    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: thread.id,
      thread,
      project,
    });
    if (!checkpointCwd) {
      return;
    }

    const fromCheckpointRef = checkpointRefForThreadTurnStart(thread.id, turnId);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: fromCheckpointRef,
    });
    if (!baselineExists) {
      // no baseline yet — the terminal capture produces the authoritative diff; skip rather than guess
      return;
    }

    const liveCheckpointRef = checkpointRefForThreadTurnLive(thread.id, turnId);
    yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: liveCheckpointRef,
    });
    const diff = yield* checkpointStore
      .diffCheckpoints({
        cwd: checkpointCwd,
        fromCheckpointRef,
        toCheckpointRef: liveCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      })
      .pipe(Effect.catch(() => Effect.succeed("")));
    yield* checkpointStore
      .deleteCheckpointRefs({ cwd: checkpointCwd, checkpointRefs: [liveCheckpointRef] })
      .pipe(Effect.catch(() => Effect.void));

    const files = yield* parseCheckpointFilesFromUnifiedDiff(diff);
    if (files.length === 0) {
      return;
    }

    // align the placeholder turn count with the terminal capture so both resolve to the same entry
    const maxTurnCount = thread.checkpoints.reduce(
      (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
      0,
    );
    const checkpointTurnCount = existingForTurn
      ? existingForTurn.checkpointTurnCount
      : maxTurnCount + 1;

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: serverCommandId("checkpoint-live-turn-diff"),
      threadId: thread.id,
      turnId,
      completedAt: event.createdAt,
      // a provider-diff ref keeps the projector treating this as a live placeholder, not an interrupted turn
      checkpointRef: CheckpointRef.makeUnsafe(`provider-diff:${event.eventId}`),
      status: "missing",
      files,
      assistantMessageId: undefined,
      checkpointTurnCount,
      createdAt: event.createdAt,
    });
  });

  // the real filesystem checkpoint must only come from terminal turn.completed — an in-progress diff update would freeze an intermediate tree as final
  const captureCheckpointFromPlaceholder = Effect.fnUntraced(function* (
    event: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
  ) {
    if (event.payload.status === "missing") {
      yield* Effect.logDebug("checkpoint placeholder left unresolved until turn completion", {
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        checkpointTurnCount: event.payload.checkpointTurnCount,
      });
    }
  });

  const ensurePreTurnBaselineFromTurnStart = Effect.fnUntraced(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>,
  ) {
    const turnId = toTurnId(event.turnId);
    if (!turnId) {
      return;
    }

    const thread = yield* getThreadDetail(event.threadId);
    if (!thread) {
      return;
    }
    const project = yield* getProjectShell(thread.projectId);
    if (!project) {
      return;
    }

    const workspace = yield* resolveCheckpointWorkspace({
      threadId: thread.id,
      thread,
      project,
    });
    if (!workspace) {
      turnsStartedWithoutGitWorkspace.delete(thread.id);
      return;
    }
    if (!workspace.isGitRepository) {
      // nothing to snapshot yet — remember the turn so completion doesn't report the necessarily-missing baseline as a failure
      turnsStartedWithoutGitWorkspace.set(thread.id, turnId);
      yield* Effect.logDebug(
        "checkpoint turn start baseline skipped: workspace is not a git repository",
        {
          threadId: thread.id,
          turnId,
          cwd: workspace.cwd,
        },
      );
      return;
    }
    turnsStartedWithoutGitWorkspace.delete(thread.id);
    const checkpointCwd = workspace.cwd;

    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId: thread.id,
    });
    const messageId =
      pendingMessageStartByThread.get(thread.id) ??
      Option.match(pendingTurnStart, {
        onNone: () => undefined,
        onSome: (pending) => pending.messageId,
      });
    const turnStartCheckpointRef = checkpointRefForThreadTurnStart(thread.id, turnId);
    let hasTurnStartBaseline = false;
    if (messageId !== undefined) {
      const messageStartCheckpointRef = checkpointRefForThreadMessageStart(thread.id, messageId);
      const copyMessageStartBaseline = checkpointStore.copyCheckpointRef({
        cwd: checkpointCwd,
        fromCheckpointRef: messageStartCheckpointRef,
        toCheckpointRef: turnStartCheckpointRef,
      });
      let copied = yield* copyMessageStartBaseline;
      if (!copied) {
        // startup and domain-event backup paths can leave the baseline missing — capture with first-writer-wins before aliasing the turn-start ref
        yield* checkpointStore.captureCheckpoint({
          cwd: checkpointCwd,
          checkpointRef: messageStartCheckpointRef,
          skipIfExists: true,
        });
        copied = yield* copyMessageStartBaseline;
      }
      hasTurnStartBaseline = copied;
      pendingMessageStartByThread.delete(thread.id);
      if (!copied) {
        yield* Effect.logWarning("checkpoint turn start baseline alias missing message baseline", {
          threadId: thread.id,
          turnId,
          messageId,
        });
      }
    }
    if (!hasTurnStartBaseline) {
      const existingTurnStartBaseline = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: turnStartCheckpointRef,
      });
      if (!existingTurnStartBaseline) {
        yield* checkpointStore.captureCheckpoint({
          cwd: checkpointCwd,
          checkpointRef: turnStartCheckpointRef,
        });
      }
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    yield* ensureLegacyBaselineCheckpoint({
      threadId: thread.id,
      cwd: checkpointCwd,
      turnCount: currentTurnCount,
      createdAt: event.createdAt,
    });
  });

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fnUntraced(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const thread = yield* getThreadDetail(threadId);
    if (!thread) {
      return;
    }
    const project = yield* getProjectShell(thread.projectId);
    if (!project) {
      return;
    }

    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      project,
    });
    if (!checkpointCwd) {
      return;
    }

    if (event.type === "thread.turn-start-requested") {
      pendingMessageStartByThread.set(threadId, event.payload.messageId);
      // backup for startup paths bypassing the pre-send hook, which remains the deterministic path
      const messageStartCheckpointRef = checkpointRefForThreadMessageStart(
        threadId,
        event.payload.messageId,
      );
      const messageStartCheckpointExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: messageStartCheckpointRef,
      });
      if (!messageStartCheckpointExists) {
        yield* checkpointStore.captureCheckpoint({
          cwd: checkpointCwd,
          checkpointRef: messageStartCheckpointRef,
          skipIfExists: true,
        });
      }
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    yield* ensureLegacyBaselineCheckpoint({
      threadId,
      cwd: checkpointCwd,
      turnCount: currentTurnCount,
      createdAt: event.occurredAt,
    });
  });

  const handleRevertRequestedWithoutLease = Effect.fnUntraced(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
    sessionThreadId: ThreadId,
  ) {
    const now = new Date().toISOString();

    const thread = yield* getThreadDetail(event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in projection state.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const relevantThreadIds =
      sessionThreadId === event.payload.threadId
        ? [event.payload.threadId]
        : [event.payload.threadId, sessionThreadId];
    const [commandReadModel, pendingTurnStarts, providerSessions] = yield* Effect.all([
      orchestrationEngine.getReadModel(),
      Effect.forEach(relevantThreadIds, (threadId) =>
        projectionTurnRepository.getPendingTurnStartByThreadId({ threadId }),
      ),
      providerService.listSessions(),
    ]);
    const commandThread = commandReadModel.threads.find(
      (entry) => entry.id === event.payload.threadId,
    );
    const sessionCommandThread = commandReadModel.threads.find(
      (entry) => entry.id === sessionThreadId,
    );
    const providerSession = providerSessions.find(
      (session) => session.threadId === sessionThreadId,
    );
    const currentThread = commandThread ?? thread;
    const hasPendingNonTerminalTurnStart = pendingTurnStarts.some(
      (pendingTurnStart, index) =>
        Option.isSome(pendingTurnStart) &&
        commandReadModel.threads.find((entry) => entry.id === relevantThreadIds[index])?.session
          ?.status !== "error",
    );
    if (
      threadHasInFlightTurn(currentThread) ||
      (sessionCommandThread !== undefined && threadHasInFlightTurn(sessionCommandThread)) ||
      hasPendingNonTerminalTurnStart ||
      providerSessionHasInFlightTurn(providerSession)
    ) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: checkpointRevertActiveTurnDetail(event.payload.threadId),
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    // requiring a live session would make revert fail after idle stop/restart though checkpoints and the binding survive
    const project = yield* getProjectShell(thread.projectId);
    const checkpointCwd = project
      ? yield* resolveCheckpointCwd({
          threadId: event.payload.threadId,
          thread,
          project,
        })
      : undefined;
    if (!checkpointCwd) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail:
          event.payload.scope === "files"
            ? "No git workspace is available for file Undo."
            : "No git workspace is available for this thread's checkpoints.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    if (event.payload.scope === "files") {
      const isUndoableCheckpoint = (checkpoint: (typeof thread.checkpoints)[number]) =>
        checkpoint.status === "ready" &&
        checkpoint.files.length > 0 &&
        isManagedCheckpointRefForThread(checkpoint.checkpointRef, event.payload.threadId);
      const targetCheckpoint = thread.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
      );
      if (!targetCheckpoint || !isUndoableCheckpoint(targetCheckpoint)) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: `File changes for turn ${event.payload.turnCount} are unavailable or already undone.`,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
      const latestUndoableTurnCount = thread.checkpoints.reduce(
        (latest, checkpoint) =>
          isUndoableCheckpoint(checkpoint)
            ? Math.max(latest, checkpoint.checkpointTurnCount)
            : latest,
        0,
      );
      if (targetCheckpoint.checkpointTurnCount !== latestUndoableTurnCount) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: "Undo newer file changes before undoing this turn.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      const turnStartCheckpointRef =
        checkpointRefForThreadTurnStartInManagedFamily(
          targetCheckpoint.checkpointRef,
          event.payload.threadId,
          targetCheckpoint.turnId,
        ) ?? checkpointRefForThreadTurnStart(event.payload.threadId, targetCheckpoint.turnId);
      const hasTurnStartCheckpoint = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: turnStartCheckpointRef,
      });
      const previousCheckpointRef =
        event.payload.turnCount === 1
          ? (checkpointRefForThreadTurnInManagedFamily(
              targetCheckpoint.checkpointRef,
              event.payload.threadId,
              0,
            ) ?? checkpointRefForThreadTurn(event.payload.threadId, 0))
          : thread.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount - 1,
            )?.checkpointRef;
      const fromCheckpointRef = hasTurnStartCheckpoint
        ? turnStartCheckpointRef
        : previousCheckpointRef;

      if (!fromCheckpointRef) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: `Starting checkpoint for turn ${event.payload.turnCount} is unavailable.`,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      const reversed = yield* checkpointStore.reverseCheckpointDiff({
        cwd: checkpointCwd,
        fromCheckpointRef,
        toCheckpointRef: targetCheckpoint.checkpointRef,
      });
      if (!reversed) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: `Filesystem checkpoints for turn ${event.payload.turnCount} are unavailable.`,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: targetCheckpoint.checkpointRef,
      });
      yield* Effect.forEach(
        thread.checkpoints.filter(
          (checkpoint) =>
            checkpoint.checkpointTurnCount > targetCheckpoint.checkpointTurnCount &&
            isManagedCheckpointRefForThread(checkpoint.checkpointRef, event.payload.threadId),
        ),
        (checkpoint) => {
          const laterTurnStartCheckpointRef =
            checkpointRefForThreadTurnStartInManagedFamily(
              checkpoint.checkpointRef,
              event.payload.threadId,
              checkpoint.turnId,
            ) ?? checkpointRefForThreadTurnStart(event.payload.threadId, checkpoint.turnId);
          return Effect.all([
            checkpointStore.copyCheckpointRef({
              cwd: checkpointCwd,
              fromCheckpointRef: targetCheckpoint.checkpointRef,
              toCheckpointRef: checkpoint.checkpointRef,
            }),
            checkpointStore.copyCheckpointRef({
              cwd: checkpointCwd,
              fromCheckpointRef: targetCheckpoint.checkpointRef,
              toCheckpointRef: laterTurnStartCheckpointRef,
            }),
          ]).pipe(Effect.asVoid);
        },
        { discard: true },
      );

      clearWorkspaceIndexCache(checkpointCwd);
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: serverCommandId("checkpoint-files-undone"),
        threadId: event.payload.threadId,
        turnId: targetCheckpoint.turnId,
        completedAt: targetCheckpoint.completedAt,
        checkpointRef: targetCheckpoint.checkpointRef,
        status: targetCheckpoint.status,
        files: [],
        ...(targetCheckpoint.assistantMessageId
          ? { assistantMessageId: targetCheckpoint.assistantMessageId }
          : {}),
        checkpointTurnCount: targetCheckpoint.checkpointTurnCount,
        preserveLatestTurn: true,
        checkpointRevertTurnCount: event.payload.turnCount,
        createdAt: now,
      });
      return;
    }

    const earliestManagedBaselineRef = thread.checkpoints
      .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
      .map((checkpoint) =>
        checkpointRefForThreadTurnInManagedFamily(
          checkpoint.checkpointRef,
          event.payload.threadId,
          0,
        ),
      )
      .find((checkpointRef) => checkpointRef !== null);
    const targetCheckpointRef =
      event.payload.turnCount === 0
        ? (earliestManagedBaselineRef ?? checkpointRefForThreadTurn(event.payload.threadId, 0))
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
          )?.checkpointRef;

    if (!targetCheckpointRef) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    // cheap read before any write — a missing checkpoint refuses while worktree and conversation are still untouched
    const missingTargetCheckpointDetail = yield* checkpointStore
      .hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: targetCheckpointRef,
      })
      .pipe(
        Effect.map((exists) =>
          exists
            ? null
            : `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
        ),
        Effect.catch((error) =>
          Effect.succeed(
            `Filesystem checkpoint for turn ${event.payload.turnCount} could not be verified: ${error.message}`,
          ),
        ),
      );
    if (missingTargetCheckpointDetail !== null) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: missingTargetCheckpointDetail,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    // a revert mutates two systems that can't commit together — snapshot the pre-revert worktree so failures can restore it
    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    const rescueCheckpointRef = revertRescueCheckpointRef(event.payload.threadId);
    const rescueCaptureFailure = yield* checkpointStore
      .captureCheckpoint({ cwd: checkpointCwd, checkpointRef: rescueCheckpointRef })
      .pipe(
        Effect.as(null),
        Effect.catch((error) =>
          Effect.succeed(
            `The pre-revert workspace snapshot could not be captured, so the revert was refused: ${error.message}`,
          ),
        ),
      );
    if (rescueCaptureFailure !== null) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: rescueCaptureFailure,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const discardRescueCheckpoint = checkpointStore
      .deleteCheckpointRefs({ cwd: checkpointCwd, checkpointRefs: [rescueCheckpointRef] })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("checkpoint revert rescue ref cleanup failed", {
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            rescueCheckpointRef,
            detail: error.message,
          }),
        ),
      );

    // returns null on success; otherwise the rescue ref is the only remaining copy of the pre-revert tree and must survive
    const restoreRescueCheckpoint = (rescueRef: CheckpointRef) =>
      checkpointStore.restoreCheckpoint({ cwd: checkpointCwd, checkpointRef: rescueRef }).pipe(
        Effect.map((restored) => (restored ? null : "the rescue snapshot was no longer available")),
        Effect.catch((error) => Effect.succeed(error.message)),
      );

    // three outcomes not two: restoreCheckpoint does a read-only lookup before writing, so `false` proves untouched while a failure can land halfway; collapsing them discarded the only copy of a half-rewritten workspace
    const restoreOutcome = yield* checkpointStore
      .restoreCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: targetCheckpointRef,
      })
      .pipe(
        Effect.map((restored) =>
          restored ? ({ kind: "restored" } as const) : ({ kind: "unavailable" } as const),
        ),
        Effect.catch((error) => Effect.succeed({ kind: "failed", detail: error.message } as const)),
      );

    if (restoreOutcome.kind === "unavailable") {
      yield* discardRescueCheckpoint;
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Filesystem checkpoint became unavailable for turn ${event.payload.turnCount} during the revert.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    if (restoreOutcome.kind === "failed") {
      const compensationFailure = yield* restoreRescueCheckpoint(rescueCheckpointRef);
      if (compensationFailure === null) {
        clearWorkspaceIndexCache(checkpointCwd);
        yield* discardRescueCheckpoint;
      }
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail:
          compensationFailure === null
            ? `Filesystem restore failed and the workspace was put back: ${restoreOutcome.detail}`
            : `Filesystem restore failed and the workspace could not be put back (${compensationFailure}). The pre-revert snapshot is kept at ${rescueCheckpointRef}. Restore error: ${restoreOutcome.detail}`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    clearWorkspaceIndexCache(checkpointCwd);

    if (rolledBackTurns > 0) {
      const conversationRollbackFailure = yield* providerService
        .rollbackConversation({
          threadId: sessionThreadId,
          numTurns: rolledBackTurns,
        })
        .pipe(
          Effect.as(null),
          Effect.catch((error) => Effect.succeed(error.message)),
        );
      if (conversationRollbackFailure !== null) {
        const compensationFailure = yield* restoreRescueCheckpoint(rescueCheckpointRef);
        if (compensationFailure === null) {
          clearWorkspaceIndexCache(checkpointCwd);
          yield* discardRescueCheckpoint;
        }
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail:
            compensationFailure === null
              ? `Conversation rollback failed and the workspace was put back: ${conversationRollbackFailure}`
              : `Conversation rollback failed and the workspace could not be put back (${compensationFailure}). The pre-revert snapshot is kept at ${rescueCheckpointRef}. Provider error: ${conversationRollbackFailure}`,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
    }

    const completionFailure = yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        // stable across retries — if persistence committed but the response was lost, the receipt makes the retry idempotent
        commandId: CommandId.makeUnsafe(`server:checkpoint-revert-complete:${event.eventId}`),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.retry(
          Schedule.addDelay(Schedule.recurs(REVERT_COMPLETE_MAX_RETRIES), () =>
            Effect.succeed("100 millis"),
          ),
        ),
        Effect.as(null),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
    if (completionFailure !== null) {
      // both systems already moved — the snapshot is the only way back, so it's deliberately kept and named in the activity
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail:
          `${completionFailure} The workspace${rolledBackTurns > 0 ? " and the conversation were" : " was"} already reverted; ` +
          `the pre-revert snapshot is kept at ${rescueCheckpointRef}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    // domain state is authoritative — refs drop only once the completion commits; deleting earlier destroys what a retry needs when dispatch fails
    const staleCheckpointRefs = thread.checkpoints
      .filter((checkpoint) => checkpoint.checkpointTurnCount > event.payload.turnCount)
      .map((checkpoint) => checkpoint.checkpointRef);

    yield* checkpointStore
      .deleteCheckpointRefs({
        cwd: checkpointCwd,
        checkpointRefs: [...staleCheckpointRefs, rescueCheckpointRef],
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("checkpoint revert ref cleanup failed after completion", {
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
          }),
        ),
      );
  });

  const handleRevertRequested = (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) =>
    Effect.gen(function* () {
      const providerThread = yield* resolveProviderSessionThread(
        projectionSnapshotQuery,
        event.payload.threadId,
      );
      const sessionThreadId = providerThread?.id ?? event.payload.threadId;

      // the lease is shared with checkpoint capture which can park on a slow git command — bound only acquisition (the revert itself runs to completion) via a child fiber + handshake race
      const leaseAcquired = yield* Deferred.make<void>();
      const leaseReleased = yield* Deferred.make<void>();
      const leaseFiber = yield* Effect.forkChild(
        turnCheckpointCoordinator.withThreadLease(
          sessionThreadId,
          Deferred.succeed(leaseAcquired, undefined).pipe(
            Effect.andThen(Deferred.await(leaseReleased)),
          ),
        ),
        { startImmediately: true },
      );

      const acquired = yield* Deferred.await(leaseAcquired).pipe(
        Effect.timeoutOption(REVERT_LEASE_ACQUIRE_TIMEOUT_MS),
      );
      if (Option.isNone(acquired)) {
        yield* Fiber.interrupt(leaseFiber).pipe(Effect.ignore);
        return yield* new CheckpointInvariantError({
          operation: "thread revert",
          detail: `Undo could not start because another checkpoint operation held this thread for more than ${Math.round(
            REVERT_LEASE_ACQUIRE_TIMEOUT_MS / 1000,
          )}s. Try again in a moment.`,
        });
      }

      return yield* handleRevertRequestedWithoutLease(event, sessionThreadId).pipe(
        Effect.ensuring(
          Deferred.succeed(leaseReleased, undefined).pipe(
            Effect.andThen(Fiber.join(leaseFiber)),
            Effect.ignore,
          ),
        ),
      );
    });

  const processDomainEvent = Effect.fnUntraced(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: new Date().toISOString(),
          }),
        ),
      );
      return;
    }

    // placeholders stay unresolved until turn.completed captures the real checkpoint; this hook only logs them — settlement comes from the session status transition
    if (event.type === "thread.turn-diff-completed") {
      yield* captureCheckpointFromPlaceholder(event);
    }
  });

  const processRuntimeEvent = Effect.fnUntraced(function* (event: ProviderRuntimeEvent) {
    if (event.type === "turn.started") {
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "item.completed") {
      // clear the coalescing flag before the git work so edits arriving during it re-schedule
      liveDiffScheduledThreads.delete(event.threadId);
      yield* captureLiveTurnDiff(event);
      return;
    }

    if (event.type === "turn.completed") {
      const turnId = toTurnId(event.turnId);
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          appendCaptureFailureActivity({
            threadId: event.threadId,
            turnId,
            detail: error.message,
            createdAt: new Date().toISOString(),
          }).pipe(Effect.catch(() => Effect.void)),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<void, CheckpointStoreError | OrchestrationDispatchError, never> =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely, {
    capacity: CHECKPOINT_REACTOR_CAPACITY,
  });

  const start: CheckpointReactorShape["start"] = startDrainableWorkerProducers(
    worker,
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (
            event.type !== "thread.turn-start-requested" &&
            event.type !== "thread.message-sent" &&
            event.type !== "thread.checkpoint-revert-requested" &&
            event.type !== "thread.turn-diff-completed"
          ) {
            return Effect.void;
          }
          return worker.enqueue({ source: "domain", event });
        }),
      );

      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) => {
          if (event.type === "turn.started" || event.type === "turn.completed") {
            return worker.enqueue({ source: "runtime", event });
          }
          if (event.type === "item.completed" && event.payload.itemType === "file_change") {
            return Effect.gen(function* () {
              // coalesce first (cheap) so bursts collapse to one recompute; skip providers streaming their own diff
              if (liveDiffScheduledThreads.has(event.threadId)) {
                return;
              }
              if (yield* supportsLiveTurnDiffPatch(event.provider)) {
                return;
              }
              liveDiffScheduledThreads.add(event.threadId);
              yield* worker.enqueue({ source: "runtime", event });
            });
          }
          return Effect.void;
        }),
      );
    }),
  );

  return {
    start,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
);
