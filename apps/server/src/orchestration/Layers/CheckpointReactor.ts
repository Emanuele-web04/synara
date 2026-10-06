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
import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Schedule,
  ServiceMap,
  Stream,
} from "effect";
import { makeKeyedDrainableWorker } from "@synara/shared/KeyedDrainableWorker";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CHECKPOINT_RUNTIME_CONSUMER,
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
  ProviderRuntimeEventRepository,
} from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { ProviderRuntimeEventRepositoryLive } from "../../persistence/Layers/ProviderRuntimeEvents.ts";
import { OrchestrationEventDeliveryRepository } from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { OrchestrationEventDeliveryRepositoryLive } from "../../persistence/Layers/OrchestrationEventDeliveries.ts";
import { isProviderKind } from "@synara/shared/providerInstances";

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
import { canonicalImportPath, findImportGitWorkspace } from "../projectImportPaths.ts";
import { resolveProviderSessionThread } from "../providerSessionThread.ts";

class PinnedCheckpointWorkspace extends ServiceMap.Service<
  PinnedCheckpointWorkspace,
  { readonly cwd: string | undefined; readonly isGitRepository: boolean }
>()("synara/checkpoint/PinnedWorkspace") {}

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

function isBaselineEligibleMessage(
  event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>,
): boolean {
  return event.payload.role === "user" && !event.payload.streaming && event.payload.turnId === null;
}

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
  const sql = yield* SqlClient.SqlClient;
  const pendingMessageStartByThread = new Map<ThreadId, MessageId>();
  // Turns that started in a workspace that was not yet a git repository. A
  // scaffolding turn (`git init`, create-next-app, ...) turns the folder into a
  // repo mid-turn, so the completion capture finds no turn-start baseline. That
  // is expected for such turns and must not surface as a capture failure.
  const turnsStartedWithoutGitWorkspace = new Map<ThreadId, TurnId>();

  // Providers that stream their own unified diff (e.g. Codex) update the live
  // turn diff through ProviderRuntimeIngestion. For providers without that
  // capability (e.g. Claude) we derive the live diff from git here instead.
  const supportsLiveTurnDiffPatch = Effect.fnUntraced(function* (
    provider: ProviderRuntimeEvent["provider"],
  ) {
    if (!isProviderKind(provider)) {
      return false;
    }
    const capabilities = yield* providerService
      .getCapabilities(provider)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    return capabilities?.supportsLiveTurnDiffPatch === true;
  });

  // Wait a short time for ProviderRuntimeIngestion to persist the final
  // assistant message id when turn completion wins the subscriber race.
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

    // No real assistant MessageId could be resolved for this turn: return
    // undefined rather than a synthetic fallback. Clients scope the diff
    // card by turnId, so a null assistantMessageId is safe; a synthetic id
    // could collide with a real MessageId from another turn.
    return undefined;
  });

  // Anchors a revert failure on a turn the transcript still renders: clients
  // drop turn-less activities once a thread has turn-stamped messages, which
  // made every revert failure invisible.
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
    readonly commandId?: CommandId;
  }) {
    if (input.commandId) {
      const accepted =
        yield* sql`SELECT 1 FROM orchestration_command_receipts WHERE command_id = ${input.commandId} AND aggregate_kind = 'thread' AND aggregate_id = ${input.threadId} AND status = 'accepted'`.pipe(
          Effect.orDie,
        );
      if (accepted.length) return;
    }
    const turnId = yield* resolveRevertFailureTurnId({
      threadId: input.threadId,
      turnCount: input.turnCount,
    });
    yield* orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: input.commandId ?? serverCommandId("checkpoint-revert-failure"),
        threadId: input.threadId,
        activity: {
          id: EventId.makeUnsafe(input.commandId ?? crypto.randomUUID()),
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
    readonly commandId?: CommandId;
  }) =>
    Effect.gen(function* () {
      if (input.commandId) {
        const accepted =
          yield* sql`SELECT 1 FROM orchestration_command_receipts WHERE command_id = ${input.commandId} AND aggregate_kind = 'thread' AND aggregate_id = ${input.threadId} AND status = 'accepted'`.pipe(
            Effect.orDie,
          );
        if (accepted.length) return;
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: input.commandId ?? serverCommandId("checkpoint-capture-failure"),
        threadId: input.threadId,
        activity: {
          id: EventId.makeUnsafe(input.commandId ?? crypto.randomUUID()),
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

  const getThreadDetail = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<OrchestrationThread | undefined> {
    const projected = yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.orDie);
    if (Option.isSome(projected)) return projected.value;
    // A committed thread may precede its deferred detail projection. Retain its
    // native checkpoint work using the engine's committed command model.
    const committed = yield* orchestrationEngine.getReadModel();
    return committed.threads.find((thread) => thread.id === threadId && thread.deletedAt === null);
  });

  const getProjectShell = Effect.fnUntraced(function* (
    projectId: ProjectId,
  ): Effect.fn.Return<OrchestrationProjectShell | undefined> {
    const projected = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.orDie);
    if (Option.isSome(projected)) return projected.value;
    const committed = yield* orchestrationEngine.getReadModel();
    return committed.projects.find(
      (project) => project.id === projectId && project.deletedAt === null,
    );
  });

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  //
  // Every checkpoint path (baseline, completion, revert) shares this single
  // policy: a worktree thread whose baseline resolved through the workspace
  // while its completion snapshot resolved through the session cwd would diff
  // two different checkouts.
  const resolveCheckpointWorkspace = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: Pick<OrchestrationThread, "projectId" | "envMode" | "worktreePath">;
    readonly project: OrchestrationProjectShell;
  }) {
    const pinned = yield* Effect.serviceOption(PinnedCheckpointWorkspace);
    if (Option.isSome(pinned)) {
      return pinned.value.cwd === undefined
        ? undefined
        : ({ cwd: pinned.value.cwd, isGitRepository: pinned.value.isGitRepository } as const);
    }
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
    const physicalCwd = yield* Effect.tryPromise(() => canonicalImportPath(cwd)).pipe(Effect.orDie);
    const gitWorkspace = yield* Effect.tryPromise(() => findImportGitWorkspace(physicalCwd)).pipe(
      Effect.orDie,
    );
    return { cwd: physicalCwd, isGitRepository: gitWorkspace !== null } as const;
  });

  const resolveCheckpointCwd = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: Pick<OrchestrationThread, "projectId" | "envMode" | "worktreePath">;
    readonly project: OrchestrationProjectShell;
  }) {
    const workspace = yield* resolveCheckpointWorkspace(input);
    return workspace?.isGitRepository ? workspace.cwd : undefined;
  });

  // Shared tail for both capture paths: creates the git checkpoint ref, diffs
  // it against the previous turn, then dispatches the domain events to update
  // the orchestration read model.
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
    readonly commandId?: CommandId;
    // The workspace only became a git repository while this turn ran, so no
    // turn-start baseline could have been captured.
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

    // Invalidate the workspace entry cache so the @-mention file picker
    // reflects files created or deleted during this turn.
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
      commandId: input.commandId ?? serverCommandId("checkpoint-turn-diff-complete"),
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

  // Captures a real git checkpoint when a turn completes via a runtime event.
  const captureCheckpointFromTurnCompletion = Effect.fnUntraced(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  ) {
    const turnId = toTurnId(event.turnId);
    if (!turnId) {
      return;
    }

    const commandId = CommandId.makeUnsafe(
      `server:checkpoint-native-complete:${encodeURIComponent(event.threadId)}:${encodeURIComponent(turnId)}`,
    );
    const completed = yield* sql`SELECT 1 FROM orchestration_command_receipts AS receipt
      WHERE receipt.command_id = ${commandId} AND receipt.aggregate_kind = 'thread'
        AND receipt.aggregate_id = ${event.threadId} AND receipt.status = 'accepted'
        AND EXISTS (SELECT 1 FROM orchestration_events AS outcome
          WHERE outcome.command_id = receipt.command_id AND outcome.event_type = 'thread.turn-diff-completed'
            AND json_extract(outcome.payload_json, '$.turnId') = ${turnId})`.pipe(Effect.orDie);
    // The receipt survives undo deleting the checkpoint projection/ref. A
    // blocked different workspace can keep this already completed raw row
    // below the global acknowledgement cursor until the next restart.
    if (completed.length) return;
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

    // When a primary turn is active, only that turn may produce completion checkpoints.
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
      yield* Effect.logDebug("turn-completion checkpoint skipped: turn is not the active turn", {
        threadId: thread.id,
        turnId,
        activeTurnId: thread.session.activeTurnId,
      });
      return;
    }

    // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
    // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
    // before this reactor runs; those must not prevent real git capture.
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

    // If a placeholder checkpoint exists for this turn, reuse its turn count
    // instead of incrementing past it.
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
      commandId,
    });
  });

  // Derives a live turn diff from git while a turn is still running, for providers
  // that do not stream their own unified diff (e.g. Claude). Snapshots the working
  // tree into a throwaway ref (isolated temp index — the real index/worktree are
  // untouched), diffs it against the turn-start baseline, and dispatches a
  // provider-diff placeholder so the "files changed" strip shows live +N/-M.
  //
  // The terminal git checkpoint from `turn.completed` stays authoritative: it
  // captures with a real ref and status "ready", which the projector refuses to
  // let a later "missing" placeholder overwrite.
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

    // Only the active primary turn may emit live diffs.
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
      return;
    }

    // Never override a real (non-placeholder) checkpoint already captured for
    // this turn by the terminal turn.completed path.
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
      // No baseline yet: the terminal capture on turn.completed still produces
      // the authoritative diff, so skip the live preview rather than guess.
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

    // Align the placeholder turn count with the eventual terminal capture so
    // both resolve to the same checkpoint entry (see captureCheckpointFromTurnCompletion).
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
      // A provider-diff ref keeps the projector treating this as a live
      // placeholder (turn stays "running") instead of an interrupted turn.
      checkpointRef: CheckpointRef.makeUnsafe(`provider-diff:${event.eventId}`),
      status: "missing",
      files,
      assistantMessageId: undefined,
      checkpointTurnCount,
      createdAt: event.createdAt,
    });
  });

  // Captures a real git checkpoint when a placeholder checkpoint (status "missing")
  // is detected via a domain event.
  //
  // Placeholders from turn.diff.updated remain placeholders. The real filesystem
  // checkpoint for a turn must only be captured from the terminal turn.completed
  // event; otherwise an in-progress diff update can freeze an intermediate tree
  // as the final checkpoint for the turn.
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
      // Nothing to snapshot yet. Remember the turn so its completion capture
      // does not report the (necessarily) missing baseline as a failure when
      // the turn itself initializes the repository.
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
        // Startup and domain-event backup paths can still leave the message
        // baseline missing. Capture it with first-writer-wins semantics before
        // aliasing the provider turn-start ref.
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
    if (event.type === "thread.message-sent" && !isBaselineEligibleMessage(event)) return;

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
      // Backup capture for startup paths that bypass ProviderCommandReactor's
      // pre-send hook, while the pre-send hook remains the deterministic path.
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

    // Both scopes resolve the workspace the same way: prefer a live provider
    // session cwd, fall back to the thread/project workspace. Requiring a live
    // session here would make revert fail after an idle stop or a restart, even
    // though the checkpoints and the provider binding both survive that.
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

    // Cheap read before any write: a missing checkpoint refuses the revert
    // while the worktree and the conversation are both still untouched, so no
    // rescue snapshot has to be captured only to be rolled straight back.
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

    // A revert mutates two systems that cannot be committed together: the
    // worktree and the provider's conversation. Snapshot the pre-revert
    // worktree first so failures can restore it.
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

    // Puts the workspace back where the revert found it. Returns null on
    // success, otherwise why the pre-revert tree could not be reinstated — at
    // which point the rescue ref is the only remaining copy of it and must
    // survive.
    const restoreRescueCheckpoint = (rescueRef: CheckpointRef) =>
      checkpointStore.restoreCheckpoint({ cwd: checkpointCwd, checkpointRef: rescueRef }).pipe(
        Effect.map((restored) => (restored ? null : "the rescue snapshot was no longer available")),
        Effect.catch((error) => Effect.succeed(error.message)),
      );

    // Three outcomes, not two: `restoreCheckpoint` resolves the target commit
    // with a read-only lookup before it issues a single writing command, so
    // `false` is proof that the workspace was never touched, while a failure can
    // land anywhere — including halfway through rewriting the tree. Collapsing
    // them into one string made the caller discard the rescue snapshot in both
    // cases, destroying the only copy of a workspace it had just half-rewritten.
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

    // Invalidate the workspace entry cache so the @-mention file picker
    // reflects the reverted filesystem state.
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
        // Stable across retries: if persistence committed but the response was
        // lost, the command receipt makes the retry idempotent instead of
        // reverting a second time.
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
      // Both systems already moved, so the snapshot is deliberately kept: it is
      // the only way back to the pre-revert worktree. Name it in the activity,
      // otherwise the ref survives with nothing pointing a human at it.
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

    // Domain state is authoritative, so refs are dropped only once the
    // completion has committed. Deleting them earlier would destroy the
    // checkpoints a retry needs when the dispatch is the step that fails.
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

      // The per-thread lease is shared with checkpoint capture, which can park
      // on a slow git command or be held by a turn that never settles. Bound
      // only the acquisition — once the lease is held the revert itself must
      // run to completion — by parking the lease in a child fiber and racing a
      // timeout against the handshake.
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

      return yield* withPinnedWorkspaceLease(
        handleRevertRequestedWithoutLease(event, sessionThreadId),
      ).pipe(
        Effect.ensuring(
          Deferred.succeed(leaseReleased, undefined).pipe(
            Effect.andThen(Fiber.join(leaseFiber)),
            Effect.ignore,
          ),
        ),
      );
    });

  const withPinnedWorkspaceLease = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const pinned = yield* Effect.serviceOption(PinnedCheckpointWorkspace);
      return yield* Option.isSome(pinned) && pinned.value.cwd !== undefined
        ? turnCheckpointCoordinator.withWorkspaceLease(pinned.value.cwd, effect)
        : effect;
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

    // Placeholder checkpoints (status "missing") from turn.diff.updated stay
    // unresolved until the terminal turn.completed runtime event captures the real
    // git checkpoint; this hook only logs them. Turn settlement itself does not
    // depend on this reactor — the projector settles latestTurn from the session
    // status transition.
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

  type WorkspaceLane = {
    readonly key: string;
    runtimeFrom: number;
    domainFrom: number;
    runtimeFence: number;
    domainFence: number;
    continuation: boolean;
  };
  const runtimeRepository = yield* ProviderRuntimeEventRepository;
  const deliveries = yield* OrchestrationEventDeliveryRepository;
  const domainConsumer = "checkpoint-reactor.domain.v1";
  const claimOwner = `checkpoint:${crypto.randomUUID()}`;
  const lanes = new Map<string, WorkspaceLane>();
  // Payloads stay in their durable journals. These pulses carry no event identity.
  const wake = yield* Queue.sliding<void>(1);
  const acknowledge = yield* Queue.sliding<void>(1);
  let runtimeScanned = 0;
  let domainScanned = 0;
  let runtimeFence = 0;
  let domainFence = 0;
  let started = false;
  let stopping = false;
  const fatal = yield* Deferred.make<never, unknown>();
  const stopped = yield* Deferred.make<void>();
  let adoptionFence = 0;
  let runtimeAdoptionFence = 0;
  let rescanRequested = false;
  let rescanInProgress = false;
  let workspaceConfigurationSequence = 0;
  const nativeConsumer = "checkpoint-reactor.runtime-outcomes.v1";
  type WorkspaceSelection = {
    readonly key: string;
    readonly cwd: string | undefined;
    readonly isGitRepository: boolean;
  };
  const keys = new Map<string, WorkspaceSelection>();
  const runtimeRelevant = (event: ProviderRuntimeEvent) =>
    event.type === "turn.started" ||
    event.type === "turn.completed" ||
    (event.type === "item.completed" && event.payload.itemType === "file_change");
  const domainRelevant = (event: OrchestrationEvent) =>
    event.type === "thread.turn-start-requested" ||
    (event.type === "thread.message-sent" && isBaselineEligibleMessage(event)) ||
    event.type === "thread.checkpoint-revert-requested" ||
    event.type === "thread.turn-diff-completed";
  const observeWorkspaceConfiguration = (event: OrchestrationEvent) => {
    if (event.sequence <= workspaceConfigurationSequence) return;
    if (
      (event.type === "thread.meta-updated" &&
        (event.payload.worktreePath !== undefined ||
          event.payload.workingDirectory !== undefined ||
          event.payload.envMode !== undefined)) ||
      (event.type === "project.meta-updated" && event.payload.workspaceRoot !== undefined) ||
      event.type === "thread.session-set"
    ) {
      workspaceConfigurationSequence = event.sequence;
      keys.clear();
      rescanRequested = true;
      Queue.offerUnsafe(wake, undefined);
    }
  };
  const workspaceForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const cached = keys.get(threadId);
    // A turn may initialize Git after its start row. Recheck missing Git until
    // discovered; each operation then keeps its captured classification/cwd.
    if (cached !== undefined && cached.isGitRepository) return cached;
    const thread = yield* getThreadDetail(threadId);
    const project = thread ? yield* getProjectShell(thread.projectId) : undefined;
    const workspace =
      thread && project
        ? yield* resolveCheckpointWorkspace({ threadId, thread, project })
        : undefined;
    const key = workspace
      ? yield* turnCheckpointCoordinator.resolveWorkspaceIdentity(workspace.cwd)
      : `thread:${threadId}`;
    const selected = {
      key,
      cwd: workspace?.cwd,
      isGitRepository: workspace?.isGitRepository ?? false,
    };
    if (cached !== undefined && cached.key !== key) {
      rescanRequested = true;
      Queue.offerUnsafe(wake, undefined);
    }
    // This lookup cache is bounded independently of workspace admission.
    if (keys.size >= CHECKPOINT_REACTOR_CAPACITY) keys.delete(keys.keys().next().value!);
    keys.set(threadId, selected);
    return selected;
  });
  const workspaceKey = (threadId: ThreadId) =>
    workspaceForThread(threadId).pipe(Effect.map((workspace) => workspace.key));
  const eventThread = (event: OrchestrationEvent) => ThreadId.makeUnsafe(event.aggregateId);
  const readDomainPage = (from: number, through: number, limit = 32) =>
    Stream.runCollect(orchestrationEngine.readEventsThrough(from, through, limit));
  const processDurableDomain = Effect.fnUntraced(function* (event: OrchestrationEvent) {
    if (event.type !== "thread.checkpoint-revert-requested") {
      yield* withPinnedWorkspaceLease(processInputSafely({ source: "domain", event }));
      return;
    }
    const input = { consumerName: domainConsumer, eventSequence: event.sequence };
    // The stable completion receipt proves an older undo already committed,
    // including the crash window between domain commit and delivery completion.
    const receipt = yield* sql`SELECT 1 FROM orchestration_command_receipts AS receipt
      WHERE receipt.command_id = ${`server:checkpoint-revert-complete:${event.eventId}`}
        AND receipt.aggregate_kind = 'thread' AND receipt.aggregate_id = ${event.payload.threadId}
        AND receipt.status = 'accepted'
        AND EXISTS (SELECT 1 FROM orchestration_events AS outcome
          WHERE outcome.command_id = receipt.command_id AND outcome.event_type = 'thread.reverted'
            AND json_extract(outcome.payload_json, '$.turnCount') = ${event.payload.turnCount})`.pipe(
      Effect.orDie,
    );
    if (receipt.length) return;
    const previous = yield* deliveries.getDelivery(input).pipe(Effect.orDie);
    if (Option.isSome(previous)) {
      const delivery = previous.value;
      if (delivery.state === "uncertain" || delivery.state === "dead") {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: delivery.lastError ?? "Checkpoint revert outcome is uncertain.",
          createdAt: delivery.updatedAt,
          commandId: CommandId.makeUnsafe(`server:checkpoint-revert-outcome:${event.eventId}`),
        });
      }
      if (delivery.state === "inflight" && delivery.claimOwner !== claimOwner) {
        // Undo can mutate files before its domain completion commits. Never
        // repeat that mutation after an ambiguous crash or cancelled lease.
        const detail =
          "Checkpoint revert was interrupted before its durable outcome was recorded; inspect the workspace before requesting another revert.";
        yield* deliveries
          .markTerminalFailure({
            ...input,
            expectedClaimOwner: delivery.claimOwner!,
            state: "uncertain",
            error: detail,
            updatedAt: new Date().toISOString(),
          })
          .pipe(Effect.orDie);
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail,
          createdAt: new Date().toISOString(),
          commandId: CommandId.makeUnsafe(`server:checkpoint-revert-outcome:${event.eventId}`),
        });
      }
      return;
    }
    const now = new Date().toISOString();
    const claimed = yield* deliveries
      .claim({
        ...input,
        threadId: event.payload.threadId,
        claimOwner,
        claimedAt: now,
        claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      .pipe(Effect.orDie);
    if (Option.isNone(claimed)) return;
    if (event.sequence <= adoptionFence && event.metadata.checkpointRuntimeSequence === undefined) {
      const detail =
        "A legacy checkpoint revert has no durable completion evidence; inspect the workspace before requesting another revert.";
      yield* deliveries
        .markTerminalFailure({
          ...input,
          expectedClaimOwner: claimOwner,
          state: "uncertain",
          error: detail,
          updatedAt: now,
        })
        .pipe(Effect.orDie);
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail,
        createdAt: now,
        commandId: CommandId.makeUnsafe(`server:checkpoint-revert-outcome:${event.eventId}`),
      });
      return;
    }
    yield* processDomainEvent(event);
    const completed = yield* deliveries
      .complete({ ...input, claimOwner, completedAt: new Date().toISOString() })
      .pipe(Effect.orDie);
    if (!completed)
      return yield* Effect.die(new Error("Checkpoint revert lost durable delivery ownership"));
  });
  const processNativeCompletion = Effect.fnUntraced(function* (
    sequence: number,
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  ) {
    const input = { consumerName: nativeConsumer, eventSequence: sequence };
    const previous = yield* deliveries.getDelivery(input).pipe(Effect.orDie);
    const commandId = `server:checkpoint-native-complete:${encodeURIComponent(event.threadId)}:${encodeURIComponent(event.turnId ?? "")}`;
    const receipt = yield* sql`SELECT 1 FROM orchestration_command_receipts AS receipt
      WHERE receipt.command_id = ${commandId} AND receipt.aggregate_kind = 'thread'
        AND receipt.aggregate_id = ${event.threadId} AND receipt.status = 'accepted'
        AND EXISTS (SELECT 1 FROM orchestration_events AS outcome
          WHERE outcome.command_id = receipt.command_id AND outcome.event_type = 'thread.turn-diff-completed'
            AND json_extract(outcome.payload_json, '$.turnId') = ${event.turnId ?? ""})`.pipe(
      Effect.orDie,
    );
    if (receipt.length) return;
    if (Option.isSome(previous)) {
      if (previous.value.state === "uncertain" || previous.value.state === "dead") {
        yield* appendCaptureFailureActivity({
          threadId: event.threadId,
          turnId: toTurnId(event.turnId),
          detail: previous.value.lastError ?? "Native checkpoint outcome is uncertain.",
          createdAt: previous.value.updatedAt,
          commandId: CommandId.makeUnsafe(`server:checkpoint-native-outcome:${sequence}`),
        });
      }
      if (previous.value.state !== "inflight" || previous.value.claimOwner === claimOwner) return;
    }
    const now = new Date().toISOString();
    const claimed = Option.isSome(previous)
      ? previous
      : yield* deliveries
          .claim({
            ...input,
            threadId: event.threadId,
            claimOwner,
            claimedAt: now,
            claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          })
          .pipe(Effect.orDie);
    if (Option.isNone(claimed)) return;
    const uncertain = (detail: string) =>
      deliveries
        .markTerminalFailure({
          ...input,
          expectedClaimOwner: claimed.value.claimOwner!,
          state: "uncertain",
          error: detail,
          updatedAt: new Date().toISOString(),
        })
        .pipe(
          Effect.orDie,
          Effect.andThen(
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId: toTurnId(event.turnId),
              detail,
              createdAt: now,
              commandId: CommandId.makeUnsafe(`server:checkpoint-native-outcome:${sequence}`),
            }),
          ),
        );
    if (Option.isSome(previous)) {
      yield* uncertain(
        "Native checkpoint capture was interrupted before its durable outcome was recorded; the workspace was not recaptured during recovery.",
      );
      return;
    }
    if (sequence <= runtimeAdoptionFence) {
      const thread = yield* getThreadDetail(event.threadId);
      const checkpoint = thread?.checkpoints.find(
        (checkpoint) =>
          checkpoint.turnId === event.turnId &&
          isManagedCheckpointRefForThread(checkpoint.checkpointRef, event.threadId),
      );
      const pinned = yield* Effect.serviceOption(PinnedCheckpointWorkspace);
      const cwd = Option.isSome(pinned) ? pinned.value.cwd : undefined;
      const proven =
        checkpoint && cwd
          ? yield* checkpointStore
              .hasCheckpointRef({ cwd, checkpointRef: checkpoint.checkpointRef })
              .pipe(Effect.orDie)
          : false;
      if (!proven) {
        yield* uncertain(
          "A previously accepted native completion has no immutable checkpoint outcome; the current workspace was not recaptured during upgrade recovery.",
        );
        return;
      }
    }
    let successful = true;
    // An adopted legacy row may only keep its proven existing snapshot. A
    // missing projection/ref becomes uncertain above; neither path captures
    // today's working tree as the outcome of a previously accepted turn.
    yield* (
      sequence <= runtimeAdoptionFence ? Effect.void : captureCheckpointFromTurnCompletion(event)
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        successful = false;
        return uncertain(
          `Native checkpoint capture did not record a complete outcome: ${Cause.pretty(cause)}`,
        );
      }),
    );
    if (successful) {
      const completedAt = new Date().toISOString();
      // Native sequence identities are not domain sequence identities. Complete
      // the outcome without advancing an orchestration-domain consumer cursor.
      const completed = yield* sql`UPDATE orchestration_event_deliveries
        SET state = 'succeeded', claim_owner = NULL, claimed_at = NULL,
          claim_expires_at = NULL, completed_at = ${completedAt}, updated_at = ${completedAt}
        WHERE consumer_name = ${nativeConsumer} AND event_sequence = ${sequence}
          AND state = 'inflight' AND claim_owner = ${claimOwner}
        RETURNING event_sequence`.pipe(Effect.orDie);
      if (completed.length !== 1)
        return yield* Effect.die(new Error("Native checkpoint lost durable delivery ownership"));
    }
  });
  const failSource = (cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause) && stopping
      ? Effect.void
      : Effect.logError("checkpoint reactor stopped after source failure", {
          cause: Cause.pretty(cause),
        }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              stopping = true;
            }),
          ),
          Effect.andThen(Deferred.succeed(stopped, undefined)),
          Effect.andThen(Deferred.failCause(fatal, cause)),
          Effect.asVoid,
        );
  const processLane = (lane: WorkspaceLane) =>
    Effect.gen(function* () {
      lane.continuation = false;
      let processed = 0;
      let refreshFences = true;
      // Each workspace owns the complete checkpoint/undo operation, including its
      // existing session lease. Ready peers receive a permit after 32 source rows.
      while (processed < 32 && !stopping) {
        if (refreshFences) {
          // Reading runtime first, then domain, observes every commit cut that
          // preceded the native snapshot. Repeat after a slow Git operation.
          lane.runtimeFence = Math.max(
            lane.runtimeFence,
            yield* runtimeRepository.getHighWaterSequence.pipe(Effect.orDie),
          );
          lane.domainFence = Math.max(
            lane.domainFence,
            yield* orchestrationEngine.getEventHighWaterSequence.pipe(Effect.orDie),
          );
          refreshFences = false;
        }
        const domainPage =
          lane.domainFrom < lane.domainFence
            ? yield* readDomainPage(lane.domainFrom, lane.domainFence, 1).pipe(Effect.orDie)
            : [];
        const nextDomain = domainPage[0];
        if (nextDomain) observeWorkspaceConfiguration(nextDomain);
        if (
          nextDomain &&
          (!domainRelevant(nextDomain) ||
            (yield* workspaceKey(eventThread(nextDomain))) !== lane.key)
        ) {
          lane.domainFrom = nextDomain.sequence;
          processed++;
          continue;
        }
        const cut = nextDomain?.metadata.checkpointRuntimeSequence;
        const runtimeThrough =
          cut === undefined ? lane.runtimeFence : Math.max(lane.runtimeFence, cut);
        const runtimePage =
          lane.runtimeFrom < runtimeThrough
            ? yield* runtimeRepository
                .readAfter({
                  sequenceExclusive: lane.runtimeFrom,
                  throughSequenceInclusive: runtimeThrough,
                  limit: 1,
                  checkpointRelevantOnly: true,
                })
                .pipe(Effect.orDie)
            : [];
        const nextRuntime = runtimePage[0];
        if (
          nextRuntime &&
          (nextDomain === undefined || cut === undefined || nextRuntime.sequence <= cut)
        ) {
          const selectedWorkspace = runtimeRelevant(nextRuntime.event)
            ? yield* workspaceForThread(nextRuntime.event.threadId)
            : undefined;
          if (selectedWorkspace?.key === lane.key) {
            let supersededLiveDiff = false;
            if (nextRuntime.event.type === "item.completed") {
              // A burst keeps only its newest file notification before native
              // terminal completion. Edits arriving during Git remain trailing
              // work; no per-event payload queue or per-thread pending map grows.
              const newer = yield* sql`SELECT 1 FROM provider_runtime_events AS later
              WHERE later.thread_id = ${nextRuntime.event.threadId}
                AND later.sequence > ${nextRuntime.sequence} AND later.sequence <= ${runtimeThrough}
                AND later.event_type = 'item.completed'
                AND json_extract(later.event_json, '$.payload.itemType') = 'file_change'
                AND NOT EXISTS (SELECT 1 FROM provider_runtime_events AS terminal
                  WHERE terminal.thread_id = later.thread_id
                    AND terminal.event_type = 'turn.completed'
                    AND terminal.sequence > ${nextRuntime.sequence} AND terminal.sequence < later.sequence)
              LIMIT 1`.pipe(Effect.orDie);
              supersededLiveDiff =
                newer.length > 0 || (yield* supportsLiveTurnDiffPatch(nextRuntime.event.provider));
            }
            if (!supersededLiveDiff) {
              const work =
                nextRuntime.event.type === "turn.completed"
                  ? processNativeCompletion(nextRuntime.sequence, nextRuntime.event)
                  : nextRuntime.sequence <= runtimeAdoptionFence
                    ? Effect.void
                    : processInputSafely({ source: "runtime", event: nextRuntime.event });
              refreshFences = true;
              yield* withPinnedWorkspaceLease(work).pipe(
                Effect.provideService(PinnedCheckpointWorkspace, {
                  cwd: selectedWorkspace.cwd,
                  isGitRepository: selectedWorkspace.isGitRepository,
                }),
              );
            }
          }
          lane.runtimeFrom = nextRuntime.sequence;
        } else if (nextDomain) {
          // Every native checkpoint row through the atomic domain commit cut has
          // settled in this workspace before the domain mutation may run.
          const selectedWorkspace = domainRelevant(nextDomain)
            ? yield* workspaceForThread(eventThread(nextDomain))
            : undefined;
          if (selectedWorkspace?.key === lane.key) {
            refreshFences = true;
            yield* processDurableDomain(nextDomain).pipe(
              Effect.provideService(PinnedCheckpointWorkspace, {
                cwd: selectedWorkspace.cwd,
                isGitRepository: selectedWorkspace.isGitRepository,
              }),
            );
          }
          lane.domainFrom = nextDomain.sequence;
        } else {
          lane.runtimeFrom = Math.max(lane.runtimeFrom, runtimeThrough);
          lane.domainFrom = Math.max(lane.domainFrom, lane.domainFence);
          break;
        }
        processed++;
      }
      // There may be deleted runtime rows below the fence. Empty pages, rather
      // than arithmetic sequence adjacency, establish their settled range.
      if (
        !stopping &&
        (lane.runtimeFrom < lane.runtimeFence || lane.domainFrom < lane.domainFence)
      ) {
        lane.continuation = true;
      } else {
        lanes.delete(lane.key);
      }
      Queue.offerUnsafe(acknowledge, undefined);
      Queue.offerUnsafe(wake, undefined);
    }).pipe(Effect.raceFirst(Deferred.await(stopped)), Effect.catchCause(failSource));
  const worker = yield* makeKeyedDrainableWorker(processLane, {
    key: (lane) => lane.key,
    concurrency: 4,
    capacity: CHECKPOINT_REACTOR_CAPACITY,
    shouldContinue: (lane) => lane.continuation && !stopping,
  });
  const admit = Effect.fnUntraced(function* (
    source: "runtime" | "domain",
    sequence: number,
    threadId: ThreadId,
  ) {
    const key = yield* workspaceKey(threadId);
    const existing = lanes.get(key);
    if (existing) {
      existing.runtimeFence = Math.max(
        existing.runtimeFence,
        runtimeFence,
        source === "runtime" ? sequence : 0,
      );
      existing.domainFence = Math.max(
        existing.domainFence,
        domainFence,
        source === "domain" ? sequence : 0,
      );
      return;
    }
    // Admission belongs to this source reader, never the runtime observer.
    // At capacity it suspends with only the current bounded page retained.
    while (lanes.size >= CHECKPOINT_REACTOR_CAPACITY && !stopping) yield* Effect.sleep("1 millis");
    if (stopping) return;
    const lane: WorkspaceLane = {
      key,
      runtimeFrom: runtimeScanned,
      domainFrom: domainScanned,
      // Inspect both durable snapshots before executing either source. A native
      // event must not pass a domain fence merely because its observer ran first.
      runtimeFence: Math.max(runtimeFence, source === "runtime" ? sequence : 0),
      domainFence: Math.max(domainFence, source === "domain" ? sequence : 0),
      continuation: false,
    };
    lanes.set(key, lane);
    if (!(yield* worker.enqueue(lane)))
      return yield* Effect.die(new Error("Checkpoint workspace admission closed"));
  });
  const scan = Effect.gen(function* () {
    if (rescanRequested) {
      rescanRequested = false;
      rescanInProgress = true;
      // Configuration changes can move pending inputs to another workspace.
      // Re-read only unacknowledged rows; outcome claims prevent double work.
      runtimeScanned = yield* runtimeRepository
        .getConsumerCursor(CHECKPOINT_RUNTIME_CONSUMER)
        .pipe(Effect.orDie);
      const state = yield* deliveries.getConsumerState(domainConsumer).pipe(Effect.orDie);
      domainScanned = Option.isSome(state) ? state.value.lastAckedSequence : 0;
      rescanInProgress = false;
    }
    runtimeFence = Math.max(
      runtimeFence,
      yield* runtimeRepository.getHighWaterSequence.pipe(Effect.orDie),
    );
    domainFence = Math.max(
      domainFence,
      yield* orchestrationEngine.getEventHighWaterSequence.pipe(Effect.orDie),
    );
    // Alternate bounded pages so neither durable source monopolizes admission.
    const runtimePage = yield* runtimeRepository
      .readAfter({
        sequenceExclusive: runtimeScanned,
        throughSequenceInclusive: runtimeFence,
        limit: 32,
        checkpointRelevantOnly: true,
      })
      .pipe(Effect.orDie);
    for (const row of runtimePage) {
      if (runtimeRelevant(row.event)) yield* admit("runtime", row.sequence, row.event.threadId);
      runtimeScanned = row.sequence;
    }
    if (runtimePage.length < 32) runtimeScanned = runtimeFence;
    const domainPage = yield* readDomainPage(domainScanned, domainFence).pipe(Effect.orDie);
    for (const event of domainPage) {
      observeWorkspaceConfiguration(event);
      if (domainRelevant(event)) yield* admit("domain", event.sequence, eventThread(event));
      domainScanned = event.sequence;
    }
    if (domainPage.length < 32) domainScanned = domainFence;
    Queue.offerUnsafe(acknowledge, undefined);
    if (runtimeScanned < runtimeFence || domainScanned < domainFence)
      Queue.offerUnsafe(wake, undefined);
    yield* Effect.yieldNow;
  });
  const pumpAcknowledgements = Effect.gen(function* () {
    if (rescanRequested || rescanInProgress) return;
    let runtimeThrough = runtimeScanned;
    let domainThrough = domainScanned;
    for (const lane of lanes.values()) {
      runtimeThrough = Math.min(runtimeThrough, lane.runtimeFrom);
      domainThrough = Math.min(domainThrough, lane.domainFrom);
    }
    const runtimeCursor = yield* runtimeRepository
      .getConsumerCursor(CHECKPOINT_RUNTIME_CONSUMER)
      .pipe(Effect.orDie);
    const rows = yield* runtimeRepository
      .readAfter({
        sequenceExclusive: runtimeCursor,
        throughSequenceInclusive: runtimeThrough,
        limit: 32,
      })
      .pipe(Effect.orDie);
    if (rows.length) {
      yield* runtimeRepository
        .advanceConsumerCursorThrough({
          consumerName: CHECKPOINT_RUNTIME_CONSUMER,
          throughSequence: rows[rows.length - 1]!.sequence,
          updatedAt: new Date().toISOString(),
        })
        .pipe(Effect.orDie);
      // Individual outcome claims are needed only while another workspace pins
      // the global prefix. Once ACK is durable, those raw rows cannot replay.
      const acknowledged = yield* runtimeRepository
        .getConsumerCursor(CHECKPOINT_RUNTIME_CONSUMER)
        .pipe(Effect.orDie);
      yield* sql`DELETE FROM orchestration_event_deliveries
        WHERE consumer_name = ${nativeConsumer} AND event_sequence <= ${acknowledged}`.pipe(
        Effect.orDie,
      );
      if (rows.length === 32) Queue.offerUnsafe(acknowledge, undefined);
    }
    const state = yield* deliveries.getConsumerState(domainConsumer).pipe(Effect.orDie);
    const cursor = Option.isSome(state) ? state.value.lastAckedSequence : 0;
    const events = yield* readDomainPage(cursor, domainThrough).pipe(Effect.orDie);
    for (const event of events)
      yield* deliveries
        .advanceCursor({
          consumerName: domainConsumer,
          eventSequence: event.sequence,
          updatedAt: new Date().toISOString(),
        })
        .pipe(Effect.orDie);
    if (events.length === 32) Queue.offerUnsafe(acknowledge, undefined);
  });
  const drain = Effect.gen(function* () {
    if (!started) return;
    while (true) {
      Queue.offerUnsafe(wake, undefined);
      const runtimeHighWater = yield* runtimeRepository.getHighWaterSequence.pipe(Effect.orDie);
      const domainHighWater = yield* orchestrationEngine.getEventHighWaterSequence.pipe(
        Effect.orDie,
      );
      yield* worker.drain;
      if (
        runtimeScanned >= runtimeHighWater &&
        domainScanned >= domainHighWater &&
        lanes.size === 0
      ) {
        // Persist the settled prefix before callers dispose this producer scope.
        yield* pumpAcknowledgements;
        const runtimeCursor = yield* runtimeRepository
          .getConsumerCursor(CHECKPOINT_RUNTIME_CONSUMER)
          .pipe(Effect.orDie);
        const state = yield* deliveries.getConsumerState(domainConsumer).pipe(Effect.orDie);
        if (
          (runtimeCursor >= runtimeScanned || runtimeScanned === 0) &&
          Option.isSome(state) &&
          state.value.lastAckedSequence >= domainScanned
        )
          return;
      }
      yield* Effect.sleep("1 millis");
    }
  }).pipe(Effect.raceFirst(Deferred.await(fatal)), Effect.orDie);
  const start: CheckpointReactorShape["start"] = Effect.gen(function* () {
    if (started) return;
    const highWater = yield* orchestrationEngine.getEventHighWaterSequence.pipe(Effect.orDie);
    const now = new Date().toISOString();
    const runtimeAdoptionConsumer = "checkpoint-reactor.runtime-adoption.v1";
    const domainAdoptionConsumer = "checkpoint-reactor.domain-adoption.v1";
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existingRuntimeConsumer =
            yield* sql`SELECT 1 FROM provider_runtime_event_consumers WHERE consumer_name = ${CHECKPOINT_RUNTIME_CONSUMER}`;
          const ingestionCursor = yield* runtimeRepository.getConsumerCursor(
            PROVIDER_RUNTIME_INGESTION_CONSUMER,
          );
          const previousState = yield* deliveries.getConsumerState(domainConsumer);
          // These immutable registration cuts survive a second crash during first
          // adoption. Neither journal's ACK pump advances them.
          yield* sql`INSERT INTO orchestration_consumer_state (consumer_name, last_acked_sequence, created_at, updated_at)
        VALUES (${runtimeAdoptionConsumer}, ${existingRuntimeConsumer.length ? 0 : ingestionCursor}, ${now}, ${now}) ON CONFLICT (consumer_name) DO NOTHING`;
          yield* sql`INSERT INTO orchestration_consumer_state (consumer_name, last_acked_sequence, created_at, updated_at)
        VALUES (${domainAdoptionConsumer}, ${Option.isSome(previousState) ? 0 : highWater}, ${now}, ${now}) ON CONFLICT (consumer_name) DO NOTHING`;
          yield* sql`INSERT INTO provider_runtime_event_consumers (consumer_name, last_acked_sequence, created_at, updated_at)
        VALUES (${CHECKPOINT_RUNTIME_CONSUMER}, 0, ${now}, ${now}) ON CONFLICT (consumer_name) DO NOTHING`;
          yield* sql`INSERT INTO orchestration_consumer_state (consumer_name, last_acked_sequence, created_at, updated_at)
        VALUES (${domainConsumer}, 0, ${now}, ${now}) ON CONFLICT (consumer_name) DO NOTHING`;
          yield* sql`INSERT INTO orchestration_consumer_state (consumer_name, last_acked_sequence, created_at, updated_at)
        VALUES (${nativeConsumer}, 0, ${now}, ${now}) ON CONFLICT (consumer_name) DO NOTHING`;
        }),
      )
      .pipe(Effect.orDie);
    const runtimeAdoption = yield* deliveries
      .getConsumerState(runtimeAdoptionConsumer)
      .pipe(Effect.orDie);
    const domainAdoption = yield* deliveries
      .getConsumerState(domainAdoptionConsumer)
      .pipe(Effect.orDie);
    runtimeAdoptionFence = Option.isSome(runtimeAdoption)
      ? runtimeAdoption.value.lastAckedSequence
      : 0;
    adoptionFence = Option.isSome(domainAdoption) ? domainAdoption.value.lastAckedSequence : 0;
    runtimeScanned = yield* runtimeRepository
      .getConsumerCursor(CHECKPOINT_RUNTIME_CONSUMER)
      .pipe(Effect.orDie);
    const state = yield* deliveries.getConsumerState(domainConsumer).pipe(Effect.orDie);
    domainScanned = Option.isSome(state) ? state.value.lastAckedSequence : 0;
    workspaceConfigurationSequence = domainScanned;
    started = true;
    yield* Effect.forkScoped(
      Effect.forever(Queue.take(acknowledge).pipe(Effect.andThen(pumpAcknowledgements))).pipe(
        Effect.catchCause(failSource),
      ),
    );
    yield* Effect.forkScoped(
      Effect.forever(Queue.take(wake).pipe(Effect.andThen(scan))).pipe(
        Effect.catchCause(failSource),
      ),
    );
    // Register eager subscriptions before capturing the replay fence.
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
    yield* Effect.forkScoped(
      Stream.runForEach(domainEvents, (event) =>
        Effect.sync(() => {
          keys.delete(event.aggregateId);
          observeWorkspaceConfiguration(event);
          domainFence = Math.max(domainFence, event.sequence);
          Queue.offerUnsafe(wake, undefined);
        }),
      ).pipe(Effect.catchCause(failSource)),
    );
    const runtimeEvents = providerService.streamPersistedEvents;
    if (runtimeEvents) {
      yield* Effect.forkScoped(
        Stream.runForEach(runtimeEvents, (row) =>
          Effect.sync(() => {
            runtimeFence = Math.max(runtimeFence, row.sequence);
            Queue.offerUnsafe(wake, undefined);
          }),
        ).pipe(Effect.catchCause(failSource)),
      );
    } else {
      // Compatibility services without durable publication use the same journal.
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) =>
          runtimeRelevant(event)
            ? runtimeRepository.append(event).pipe(
                Effect.tap((row) =>
                  Effect.sync(() => {
                    runtimeFence = Math.max(runtimeFence, row.sequence);
                    Queue.offerUnsafe(wake, undefined);
                  }),
                ),
              )
            : Effect.void,
        ).pipe(Effect.catchCause(failSource)),
      );
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopping = true;
      }).pipe(Effect.andThen(Deferred.succeed(stopped, undefined)), Effect.asVoid),
    );
    Queue.offerUnsafe(wake, undefined);
    // Recovery proceeds in workspace lanes. Starting the observer never waits
    // for another workspace's Git operation or its admission reservation.
  });
  return { start, drain } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
  Layer.provide(ProviderRuntimeEventRepositoryLive),
  Layer.provide(OrchestrationEventDeliveryRepositoryLive),
);
