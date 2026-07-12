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
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import { Cause, Effect, Layer, Option, Schedule, Stream } from "effect";
import { makeDrainableWorker } from "@synara/shared/DrainableWorker";

import { parseCheckpointFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadMessageStart,
  checkpointRefForThreadTurn,
  checkpointRefForThreadTurnInManagedFamily,
  checkpointRefForThreadTurnLive,
  checkpointRefForThreadTurnStart,
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
import { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import { OrchestrationDispatchError } from "../Errors.ts";
import { isGitRepository } from "../../git/isRepo.ts";
import { withCheckpointFileRestoreInterlock } from "../checkpointFileRestoreInterlock.ts";

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.makeUnsafe(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
const FILE_RESTORE_TERMINAL_INITIAL_RETRY_SCHEDULE = Schedule.exponential("100 millis").pipe(
  Schedule.take(5),
);
const FILE_RESTORE_TERMINAL_EVENTUAL_RETRY_SCHEDULE = Schedule.spaced("1 second");

type FilesRestoreTerminalTarget = {
  readonly requestCommandId: CommandId;
  readonly messageId: MessageId;
};

type FilesRestoreFailureTerminalInput = {
  readonly threadId: ThreadId;
  readonly turnCount: number;
  readonly detail: string;
  readonly requiresWorkspaceReview: boolean;
  readonly createdAt: string;
  readonly filesRestore: FilesRestoreTerminalTarget;
};

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
  const pendingMessageStartByThread = new Map<ThreadId, MessageId>();
  // Coalesces live turn-diff recomputes: at most one queued + one in-flight per
  // thread. The flag is cleared when the worker starts processing the job so an
  // edit arriving during the git work re-schedules and captures the newest tree.
  const liveDiffScheduledThreads = new Set<ThreadId>();

  // Providers that stream their own unified diff (e.g. Codex) update the live
  // turn diff through ProviderRuntimeIngestion. For providers without that
  // capability (e.g. Claude) we derive the live diff from git here instead.
  const supportsLiveTurnDiffPatch = Effect.fnUntraced(function* (
    provider: ProviderRuntimeEvent["provider"],
  ) {
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

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly requiresWorkspaceReview?: boolean;
    readonly createdAt: string;
    readonly filesRestore?: {
      readonly requestCommandId: CommandId;
      readonly messageId: MessageId;
    };
  }) =>
    Effect.gen(function* () {
      const appendActivity = orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: serverCommandId("checkpoint-revert-failure"),
        threadId: input.threadId,
        activity: {
          id: EventId.makeUnsafe(crypto.randomUUID()),
          tone: "error",
          kind: "checkpoint.revert.failed",
          summary: "Checkpoint revert failed",
          payload: {
            turnCount: input.turnCount,
            detail: input.detail,
          },
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
      if (input.filesRestore) {
        yield* appendActivity.pipe(Effect.catch(() => Effect.void));
        yield* appendFilesRestoreFailureTerminalEventually(
          {
            threadId: input.threadId,
            turnCount: input.turnCount,
            detail: input.detail,
            requiresWorkspaceReview: input.requiresWorkspaceReview ?? false,
            createdAt: input.createdAt,
            filesRestore: input.filesRestore,
          },
          "checkpoint restore failure",
        );
        return;
      }

      yield* appendActivity;
    });

  const dispatchFilesRestoreFailureTerminal = (
    input: FilesRestoreFailureTerminalInput,
    commandId: CommandId,
  ) =>
    Effect.suspend(() =>
      orchestrationEngine.dispatch({
        type: "thread.checkpoint.files.restore.fail",
        commandId,
        requestCommandId: input.filesRestore.requestCommandId,
        threadId: input.threadId,
        messageId: input.filesRestore.messageId,
        turnCount: input.turnCount,
        detail: input.detail,
        requiresWorkspaceReview: input.requiresWorkspaceReview,
        createdAt: input.createdAt,
      }),
    ).pipe(Effect.asVoid);

  const appendFilesRestoreFailureTerminalEventually = (
    input: FilesRestoreFailureTerminalInput,
    _context: string,
  ) =>
    Effect.gen(function* () {
      const terminalCommandId = serverCommandId("checkpoint-files-restore-failed");
      yield* dispatchFilesRestoreFailureTerminal(input, terminalCommandId).pipe(
        Effect.retry(FILE_RESTORE_TERMINAL_EVENTUAL_RETRY_SCHEDULE),
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

  const resolveSessionRuntimeForThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
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

    const projectedSession = sessions.find((session) => session.threadId === thread.value.id);
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

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: Pick<OrchestrationThread, "projectId" | "envMode" | "worktreePath">;
    readonly project: OrchestrationProjectShell;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: [input.project],
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) {
      return undefined;
    }
    if (!isGitWorkspace(cwd)) {
      return undefined;
    }
    return cwd;
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
  }) {
    const fromCheckpointRef = checkpointRefForThreadTurnStart(input.threadId, input.turnId);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: fromCheckpointRef,
    });
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        checkpointRef: fromCheckpointRef,
      });
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
            Effect.map((diff) => parseCheckpointFilesFromUnifiedDiff(diff)),
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

  // Captures a real git checkpoint when a turn completes via a runtime event.
  const captureCheckpointFromTurnCompletion = Effect.fnUntraced(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
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

    // When a primary turn is active, only that turn may produce completion checkpoints.
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
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
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) {
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

    yield* captureAndDispatchCheckpoint({
      threadId: thread.id,
      turnId,
      thread,
      cwd: checkpointCwd,
      turnCount: nextTurnCount,
      status: checkpointStatusFromRuntime(event.payload.state),
      assistantMessageId: undefined,
      createdAt: event.createdAt,
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
      preferSessionRuntime: true,
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

    const files = parseCheckpointFilesFromUnifiedDiff(diff);
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

    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: thread.id,
      thread,
      project,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

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
      preferSessionRuntime: false,
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

  const hasPriorFilesRestoreSideEffect = Effect.fnUntraced(function* (
    threadId: ThreadId,
    beforeSequence: number,
  ) {
    const events = yield* Stream.runCollect(orchestrationEngine.readEvents(0)).pipe(
      Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
    );
    return events.some(
      (candidate) =>
        candidate.aggregateKind === "thread" &&
        candidate.aggregateId === threadId &&
        candidate.sequence < beforeSequence &&
        (candidate.type === "thread.checkpoint-files-restored" ||
          (candidate.type === "thread.checkpoint-files-restore-failed" &&
            candidate.payload.requiresWorkspaceReview)),
    );
  });

  const handleRevertRequested = Effect.fnUntraced(function* (
    event: Extract<
      OrchestrationEvent,
      {
        type: "thread.checkpoint-revert-requested" | "thread.checkpoint-files-restore-requested";
      }
    >,
  ) {
    const now = new Date().toISOString();
    let filesRestore:
      | {
          readonly requestCommandId: CommandId;
          readonly messageId: MessageId;
        }
      | undefined;
    if (event.type === "thread.checkpoint-files-restore-requested") {
      if (event.commandId === null) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: "File restore request is missing its command id.",
          requiresWorkspaceReview: true,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
      filesRestore = {
        requestCommandId: event.commandId,
        messageId: event.payload.messageId,
      };
    }
    const filesOnly = filesRestore !== undefined;

    const thread = yield* getThreadDetail(event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in projection state.",
        createdAt: now,
        ...(filesRestore ? { filesRestore } : {}),
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }
    if (thread.deletedAt !== null) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was deleted before the checkpoint restore could run.",
        createdAt: now,
        ...(filesRestore ? { filesRestore } : {}),
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.payload.threadId);
    if (Option.isNone(sessionRuntime)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "No active provider session with workspace cwd is bound to this thread.",
        createdAt: now,
        ...(filesRestore ? { filesRestore } : {}),
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }
    if (!isGitWorkspace(sessionRuntime.value.cwd)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Checkpoints are unavailable because this project is not a git repository.",
        createdAt: now,
        ...(filesRestore ? { filesRestore } : {}),
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
        ...(filesRestore ? { filesRestore } : {}),
      }).pipe(Effect.catch(() => Effect.void));
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
    const numberedTurnCheckpointRef =
      event.payload.turnCount === 0
        ? (earliestManagedBaselineRef ?? checkpointRefForThreadTurn(event.payload.threadId, 0))
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
          )?.checkpointRef;
    const targetCheckpointRef = filesRestore
      ? checkpointRefForThreadMessageStart(event.payload.threadId, filesRestore.messageId)
      : numberedTurnCheckpointRef;
    const legacyFilesRestoreFallbackRef =
      filesRestore &&
      numberedTurnCheckpointRef &&
      !(yield* hasPriorFilesRestoreSideEffect(event.payload.threadId, event.sequence))
        ? numberedTurnCheckpointRef
        : null;

    if (!targetCheckpointRef) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
        createdAt: now,
        ...(filesRestore ? { filesRestore } : {}),
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const restoreTargetCheckpointRef = (checkpointRef: CheckpointRef, fallbackToHead: boolean) =>
      withCheckpointFileRestoreInterlock(
        checkpointStore.restoreCheckpoint({
          cwd: sessionRuntime.value.cwd,
          checkpointRef,
          fallbackToHead,
        }),
      );

    let restored = yield* restoreTargetCheckpointRef(
      targetCheckpointRef,
      !filesOnly && event.payload.turnCount === 0,
    );
    if (
      !restored &&
      filesRestore &&
      legacyFilesRestoreFallbackRef !== null &&
      legacyFilesRestoreFallbackRef !== targetCheckpointRef
    ) {
      // Older histories predate message-start checkpoint refs. Before any
      // successful file-only undo, the persisted numbered turn checkpoint is
      // still the best known message-start baseline; after one undo it is no
      // longer safe because sequential undo must preserve the post-undo state.
      restored = yield* restoreTargetCheckpointRef(legacyFilesRestoreFallbackRef, false);
    }
    if (!restored) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
        createdAt: now,
        ...(filesRestore ? { filesRestore } : {}),
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    // Invalidate the workspace entry cache so the @-mention file picker
    // reflects the reverted filesystem state.
    clearWorkspaceIndexCache(sessionRuntime.value.cwd);

    // The diff-card action restores the immutable baseline captured for that
    // exact user message. This remains correct after earlier file-only undos.
    if (filesRestore) {
      const completeCommandId = serverCommandId("checkpoint-files-restore-complete");
      yield* Effect.suspend(() =>
        orchestrationEngine.dispatch({
          type: "thread.checkpoint.files.restore.complete",
          commandId: completeCommandId,
          requestCommandId: filesRestore.requestCommandId,
          threadId: event.payload.threadId,
          messageId: filesRestore.messageId,
          turnCount: event.payload.turnCount,
          createdAt: now,
        }),
      ).pipe(
        Effect.retry(FILE_RESTORE_TERMINAL_INITIAL_RETRY_SCHEDULE),
        Effect.catch((error) =>
          appendFilesRestoreFailureTerminalEventually(
            {
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
              detail: `File restore changed files, but Synara could not persist the success terminal: ${error.message}`,
              requiresWorkspaceReview: true,
              createdAt: now,
              filesRestore,
            },
            "checkpoint file restore success terminal fallback",
          ),
        ),
      );
      return;
    }

    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    if (rolledBackTurns > 0) {
      yield* providerService.rollbackConversation({
        threadId: sessionRuntime.value.threadId,
        numTurns: rolledBackTurns,
      });
    }

    const staleCheckpointRefs = thread.checkpoints
      .filter((checkpoint) => checkpoint.checkpointTurnCount > event.payload.turnCount)
      .map((checkpoint) => checkpoint.checkpointRef);

    if (staleCheckpointRefs.length > 0) {
      yield* checkpointStore.deleteCheckpointRefs({
        cwd: sessionRuntime.value.cwd,
        checkpointRefs: staleCheckpointRefs,
      });
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });

  const failInterruptedFileRestoresOnStart = Effect.fnUntraced(function* () {
    const events = yield* Stream.runCollect(orchestrationEngine.readEvents(0)).pipe(
      Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
    );
    type RestoreState = {
      prepared?: Extract<OrchestrationEvent, { type: "thread.checkpoint-files-restore-prepared" }>;
      request?: Extract<OrchestrationEvent, { type: "thread.checkpoint-files-restore-requested" }>;
      reconciliation?: Extract<
        OrchestrationEvent,
        { type: "thread.checkpoint-files-restore-reconciliation-requested" }
      >;
      terminal: boolean;
    };
    const restoreStates = new Map<CommandId, RestoreState>();
    const stateFor = (requestCommandId: CommandId) => {
      const existing = restoreStates.get(requestCommandId);
      if (existing) return existing;
      const created: RestoreState = { terminal: false };
      restoreStates.set(requestCommandId, created);
      return created;
    };

    for (const event of events) {
      if (event.type === "thread.checkpoint-files-restore-prepared") {
        stateFor(event.payload.requestCommandId).prepared = event;
        continue;
      }
      if (event.type === "thread.checkpoint-files-restore-requested" && event.commandId !== null) {
        stateFor(event.commandId).request = event;
        continue;
      }
      if (event.type === "thread.checkpoint-files-restore-reconciliation-requested") {
        stateFor(event.payload.requestCommandId).reconciliation = event;
        continue;
      }
      if (
        event.type === "thread.checkpoint-files-restored" ||
        event.type === "thread.checkpoint-files-restore-failed" ||
        event.type === "thread.checkpoint-files-restore-reviewed"
      ) {
        stateFor(event.payload.requestCommandId).terminal = true;
      }
    }

    const now = new Date().toISOString();
    yield* Effect.forEach(
      restoreStates.entries(),
      ([requestCommandId, state]) => {
        if (state.terminal) return Effect.void;
        const source = state.request ?? state.reconciliation ?? state.prepared;
        if (!source) return Effect.void;
        const preparedOnly = state.request === undefined && state.prepared !== undefined;
        return appendFilesRestoreFailureTerminalEventually(
          {
            threadId: source.payload.threadId,
            turnCount: source.payload.turnCount,
            detail: preparedOnly
              ? "File restore confirmation did not finish before Synara restarted. No restore was run."
              : state.request
                ? "File restore did not finish before Synara restarted. No automatic retry was run; inspect the working tree before continuing."
                : "Synara restarted before file restore acceptance could be confirmed. No restore was replayed; inspect the working tree before continuing.",
            requiresWorkspaceReview: !preparedOnly,
            createdAt: now,
            filesRestore: {
              requestCommandId,
              messageId: source.payload.messageId,
            },
          },
          "checkpoint startup interrupted file restore reconciliation",
        );
      },
      { concurrency: 1 },
    );
  });

  const readFileRestoreEventState = Effect.fnUntraced(function* (requestCommandId: CommandId) {
    const events = yield* Stream.runCollect(orchestrationEngine.readEvents(0)).pipe(
      Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
    );
    let requested = false;
    let terminal = false;
    for (const event of events) {
      if (
        event.type === "thread.checkpoint-files-restore-prepared" &&
        event.payload.requestCommandId === requestCommandId
      ) {
        requested = true;
        continue;
      }
      if (
        event.type === "thread.checkpoint-files-restore-requested" &&
        event.commandId === requestCommandId
      ) {
        requested = true;
        continue;
      }
      if (
        (event.type === "thread.checkpoint-files-restored" ||
          event.type === "thread.checkpoint-files-restore-failed" ||
          event.type === "thread.checkpoint-files-restore-reviewed") &&
        event.payload.requestCommandId === requestCommandId
      ) {
        terminal = true;
      }
    }
    return { requested, terminal } as const;
  });

  const processDomainEvent = Effect.fnUntraced(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-files-restore-reconciliation-requested") {
      const state = yield* readFileRestoreEventState(event.payload.requestCommandId);
      if (!state.terminal) {
        yield* appendFilesRestoreFailureTerminalEventually(
          {
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: state.requested
              ? "Synara found a file restore request without a durable terminal event. No restore was replayed; inspect the working tree before continuing."
              : "Synara could not confirm that the file restore was accepted. No restore was replayed; inspect the working tree before continuing.",
            requiresWorkspaceReview: true,
            createdAt: new Date().toISOString(),
            filesRestore: {
              requestCommandId: event.payload.requestCommandId,
              messageId: event.payload.messageId,
            },
          },
          "checkpoint explicit file restore reconciliation",
        );
      }
      return;
    }

    if (
      event.type === "thread.checkpoint-revert-requested" ||
      event.type === "thread.checkpoint-files-restore-requested"
    ) {
      if (event.type === "thread.checkpoint-files-restore-requested" && event.commandId !== null) {
        const state = yield* readFileRestoreEventState(event.commandId);
        if (state.terminal) {
          return;
        }
      }
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: errorMessage(error),
            ...(event.type === "thread.checkpoint-files-restore-requested"
              ? { requiresWorkspaceReview: true }
              : {}),
            createdAt: new Date().toISOString(),
            ...(event.type === "thread.checkpoint-files-restore-requested" &&
            event.commandId !== null
              ? {
                  filesRestore: {
                    requestCommandId: event.commandId,
                    messageId: event.payload.messageId,
                  },
                }
              : {}),
          }),
        ),
      );
      return;
    }

    // When ProviderRuntimeIngestion creates a placeholder checkpoint (status "missing")
    // from a turn.diff.updated runtime event, capture the real git checkpoint to
    // replace it. The providerService.streamEvents PubSub does not reliably deliver
    // turn.completed runtime events to this reactor (shared subscription), so
    // reacting to the domain event is the reliable path.
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
      // Clear the coalescing flag before the git work so edits arriving during
      // it re-schedule and snapshot the newest tree.
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

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.gen(function* () {
    yield* failInterruptedFileRestoresOnStart().pipe(
      Effect.catchCause((cause) =>
        Effect.die(
          new Error(
            `Failed to reconcile interrupted file restores before checkpoint startup: ${Cause.pretty(cause)}`,
          ),
        ),
      ),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested" &&
          event.type !== "thread.checkpoint-files-restore-requested" &&
          event.type !== "thread.checkpoint-files-restore-reconciliation-requested" &&
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
            // Coalesce first (cheap) so bursts of edits collapse to one recompute.
            if (liveDiffScheduledThreads.has(event.threadId)) {
              return;
            }
            // Skip providers that stream their own live diff (handled elsewhere).
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
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
);
