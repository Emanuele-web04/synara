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
  Semaphore,
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
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
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
import {
  canonicalImportPath,
  findImportGitWorkspace,
  importPathIdentity,
} from "../projectImportPaths.ts";
import { resolveProviderSessionThread } from "../providerSessionThread.ts";

class PinnedCheckpointWorkspace extends ServiceMap.Service<
  PinnedCheckpointWorkspace,
  {
    readonly cwd: string | undefined;
    readonly isGitRepository: boolean;
    readonly identity?: string | undefined;
  }
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
// Background ACKs coalesce for this window; drain still flushes synchronously.
const CHECKPOINT_ACK_INTERVAL_MS = 50;

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

  // A notice is advisory: its failure must never reach failSource and stop
  // every workspace. Interruption still propagates.
  const catchNoticeFailure = <A, E, R>(notice: Effect.Effect<A, E, R>) =>
    notice.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning(
              "Checkpoint failure notice could not be published; durable settlement is retained",
              { cause: Cause.pretty(cause) },
            ),
      ),
    );
  const noticeThreadExists = (threadId: ThreadId) =>
    orchestrationEngine
      .getReadModel()
      .pipe(
        Effect.map((model) =>
          model.threads.some((thread) => thread.id === threadId && thread.deletedAt == null),
        ),
      );
  const appendRevertFailureActivity = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
    readonly commandId?: CommandId;
    readonly resolvedTurnId?: TurnId | null;
  }) {
    if (!(yield* noticeThreadExists(input.threadId))) return;
    if (input.commandId) {
      const accepted =
        yield* sql`SELECT 1 FROM orchestration_command_receipts WHERE command_id = ${input.commandId} AND aggregate_kind = 'thread' AND aggregate_id = ${input.threadId} AND status = 'accepted'`.pipe(
          Effect.orDie,
        );
      if (accepted.length) return;
    }
    const turnId =
      input.resolvedTurnId !== undefined
        ? input.resolvedTurnId
        : yield* resolveRevertFailureTurnId({
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
  }, catchNoticeFailure);

  const appendCheckpointIssueActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
    readonly baselineUnavailable?: true;
    readonly commandId?: CommandId;
  }) =>
    Effect.gen(function* () {
      if (!(yield* noticeThreadExists(input.threadId))) return;
      if (input.commandId) {
        const accepted =
          yield* sql`SELECT 1 FROM orchestration_command_receipts WHERE command_id = ${input.commandId} AND aggregate_kind = 'thread' AND aggregate_id = ${input.threadId} AND status = 'accepted'`.pipe(
            Effect.orDie,
          );
        if (accepted.length) return;
      }
      let messageId: MessageId | undefined;
      let activityId = EventId.makeUnsafe(input.commandId ?? crypto.randomUUID());
      if (input.baselineUnavailable && input.turnId !== null) {
        const thread = yield* getThreadDetail(input.threadId);
        const turn = yield* projectionTurnRepository
          .getByTurnId({ threadId: input.threadId, turnId: input.turnId })
          .pipe(Effect.catch(() => Effect.succeed(Option.none())));
        messageId =
          Option.getOrNull(turn)?.pendingMessageId ??
          thread?.messages.find(
            (message) => message.role === "user" && message.turnId === input.turnId,
          )?.id;
        // Native children inherit their parent's workspace, without an independent
        // pre-send owner. Keep actual capture failures and owned skips actionable.
        if (thread?.parentThreadId && messageId === undefined) return;
        if (
          thread?.activities.some(
            (activity) =>
              activity.kind === "checkpoint.baseline.skipped" &&
              (activity.turnId === input.turnId ||
                (messageId !== undefined &&
                  typeof activity.payload === "object" &&
                  activity.payload !== null &&
                  "messageId" in activity.payload &&
                  activity.payload.messageId === messageId)),
          )
        )
          return;
        activityId = EventId.makeUnsafe(
          `checkpoint-baseline-skipped:${
            messageId === undefined
              ? checkpointRefForThreadTurnStart(input.threadId, input.turnId)
              : checkpointRefForThreadMessageStart(input.threadId, messageId)
          }`,
        );
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId:
          input.commandId ??
          serverCommandId(
            input.baselineUnavailable
              ? "checkpoint-baseline-unavailable"
              : "checkpoint-capture-failure",
          ),
        threadId: input.threadId,
        activity: {
          id: activityId,
          tone: input.baselineUnavailable ? "info" : "error",
          kind: input.baselineUnavailable
            ? "checkpoint.baseline.skipped"
            : "checkpoint.capture.failed",
          summary: input.baselineUnavailable
            ? "Checkpoint baseline unavailable for this turn"
            : "Checkpoint capture failed",
          payload: {
            detail: input.detail,
            ...(messageId === undefined ? {} : { messageId }),
          },
          turnId: input.turnId,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    }).pipe(catchNoticeFailure);

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
    readonly observedCwd?: { readonly source: string; readonly physical: string };
  }) {
    const pinned = yield* Effect.serviceOption(PinnedCheckpointWorkspace);
    if (Option.isSome(pinned)) {
      return pinned.value.cwd === undefined
        ? undefined
        : ({
            cwd: pinned.value.cwd,
            isGitRepository: pinned.value.isGitRepository,
            sourceCwd: pinned.value.cwd,
            identity: pinned.value.identity ?? importPathIdentity(pinned.value.cwd),
          } as const);
    }
    const fromSession =
      input.observedCwd === undefined
        ? yield* resolveSessionRuntimeForThread(input.threadId)
        : Option.none();
    const cwd =
      input.observedCwd?.source ??
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
    const physicalCwd =
      input.observedCwd?.physical ??
      (yield* Effect.tryPromise(() => canonicalImportPath(cwd)).pipe(Effect.orDie));
    const gitWorkspace = yield* Effect.tryPromise(() => findImportGitWorkspace(physicalCwd)).pipe(
      Effect.orDie,
    );
    return {
      cwd: physicalCwd,
      isGitRepository: gitWorkspace !== null,
      sourceCwd: cwd,
      identity: importPathIdentity(gitWorkspace?.worktree ?? gitWorkspace?.root ?? physicalCwd),
    } as const;
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

    const fromCheckpointExists = yield* aliasTurnStartBaseline({
      cwd: input.cwd,
      threadId: input.threadId,
      turnId: input.turnId,
    });
    if (fromCheckpointExists) {
      yield* ensureLegacyBaselineCheckpoint({
        threadId: input.threadId,
        cwd: input.cwd,
        turnCount: input.turnCount - 1,
        createdAt: input.createdAt,
        fromCheckpointRef,
      });
    }
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
              appendCheckpointIssueActivity({
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
        : yield* appendCheckpointIssueActivity({
            threadId: input.threadId,
            turnId: input.turnId,
            baselineUnavailable: true,
            detail:
              "The initial workspace state is unavailable for this turn, so checkpoint diff and file undo are unavailable. The completed checkpoint was captured successfully.",
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
    readonly fromCheckpointRef: CheckpointRef;
  }) {
    // Only turn zero is a baseline. Missing completed checkpoints cannot be
    // reconstructed from a later working tree or from a later turn's baseline.
    if (input.turnCount !== 0) return;
    const legacyBaselineRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);
    const legacyBaselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: legacyBaselineRef,
    });
    if (legacyBaselineExists) {
      return;
    }

    const copied = yield* checkpointStore.copyCheckpointRef({
      cwd: input.cwd,
      fromCheckpointRef: input.fromCheckpointRef,
      toCheckpointRef: legacyBaselineRef,
    });
    if (!copied) return;
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId: input.threadId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: legacyBaselineRef,
      createdAt: input.createdAt,
    });
  });

  // Restart may resume with completion or a file-change event, without another
  // turn.started. Recover only an already captured source ref bound to this
  // durable turn; a missing baseline never permits a working-tree snapshot.
  const aliasTurnStartBaseline = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly cwd: string;
    readonly pendingMessageId?: MessageId;
  }) {
    const turnStartCheckpointRef = checkpointRefForThreadTurnStart(input.threadId, input.turnId);
    if (
      yield* checkpointStore.hasCheckpointRef({
        cwd: input.cwd,
        checkpointRef: turnStartCheckpointRef,
      })
    ) {
      return true;
    }
    const persistedTurn = yield* projectionTurnRepository.getByTurnId({
      threadId: input.threadId,
      turnId: input.turnId,
    });
    const messageId = Option.getOrNull(persistedTurn)?.pendingMessageId ?? input.pendingMessageId;
    if (messageId === undefined) return false;
    return yield* checkpointStore.copyCheckpointRef({
      cwd: input.cwd,
      fromCheckpointRef: checkpointRefForThreadMessageStart(input.threadId, messageId),
      toCheckpointRef: turnStartCheckpointRef,
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
    const baselineExists = yield* aliasTurnStartBaseline({
      cwd: checkpointCwd,
      threadId: thread.id,
      turnId,
    });
    if (!baselineExists) {
      // No matching captured baseline: skip the live preview and let terminal
      // capture report the unavailable diff rather than guess.
      return;
    }
    yield* ensureLegacyBaselineCheckpoint({
      threadId: thread.id,
      cwd: checkpointCwd,
      turnCount: thread.checkpoints
        .filter((checkpoint) => checkpoint.turnId !== turnId)
        .reduce((max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount), 0),
      createdAt: event.createdAt,
      fromCheckpointRef,
    });

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
    const hasTurnStartBaseline = yield* aliasTurnStartBaseline({
      cwd: checkpointCwd,
      threadId: thread.id,
      turnId,
      ...(messageId !== undefined ? { pendingMessageId: messageId } : {}),
    });
    if (!hasTurnStartBaseline) {
      yield* Effect.logWarning("checkpoint turn start baseline alias missing message baseline", {
        threadId: thread.id,
        turnId,
        messageId,
      });
    }
    pendingMessageStartByThread.delete(thread.id);
    // Once turn.started is observable, the provider may already have edited.
    // Missing refs stay missing; only pre-dispatch owners may snapshot a baseline.
    if (!hasTurnStartBaseline) return;

    const currentTurnCount = thread.checkpoints
      .filter((checkpoint) => checkpoint.turnId !== turnId)
      .reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
    yield* ensureLegacyBaselineCheckpoint({
      threadId: thread.id,
      cwd: checkpointCwd,
      turnCount: currentTurnCount,
      createdAt: event.createdAt,
      fromCheckpointRef: turnStartCheckpointRef,
    });
  });

  const rememberPendingMessageStart = (
    event: Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>,
  ) =>
    Effect.sync(() => {
      pendingMessageStartByThread.set(event.payload.threadId, event.payload.messageId);
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

      // A later managed completion with no exact baseline can include unknown
      // overlapping edits. Refuse before reverse-patching or rewriting its refs.
      for (const checkpoint of thread.checkpoints) {
        if (
          checkpoint.checkpointTurnCount <= targetCheckpoint.checkpointTurnCount ||
          !isManagedCheckpointRefForThread(checkpoint.checkpointRef, event.payload.threadId)
        )
          continue;
        const laterStartRef =
          checkpointRefForThreadTurnStartInManagedFamily(
            checkpoint.checkpointRef,
            event.payload.threadId,
            checkpoint.turnId,
          ) ?? checkpointRefForThreadTurnStart(event.payload.threadId, checkpoint.turnId);
        if (
          yield* checkpointStore.hasCheckpointRef({
            cwd: checkpointCwd,
            checkpointRef: laterStartRef,
          })
        )
          continue;
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail:
            "File Undo is unavailable because a later turn has no exact initial checkpoint. Revert the thread to this checkpoint instead.",
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
        ? pinned.value.identity !== undefined
          ? turnCheckpointCoordinator.withWorkspaceIdentityLease(pinned.value.identity, effect)
          : turnCheckpointCoordinator.withWorkspaceLease(pinned.value.cwd, effect)
        : effect;
    });

  const processDomainEvent = Effect.fnUntraced(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested") {
      yield* rememberPendingMessageStart(event);
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
          appendCheckpointIssueActivity({
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
  const eventStore = yield* OrchestrationEventStore;
  const runtimeRepository = yield* ProviderRuntimeEventRepository;
  const deliveries = yield* OrchestrationEventDeliveryRepository;
  const domainConsumer = "checkpoint-reactor.domain.v1";
  const legacyDomainConsumer = "checkpoint-reactor.domain-recovery.v1";
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
  let startupDomainFence = 0;
  let startupRuntimeFence = 0;
  let legacyDomainFrom = 0;
  let runtimeAdoptionFence = 0;
  let startupIngestionFence = 0;
  let rescanRequested = false;
  let rescanInProgress = false;
  let workspaceConfigurationSequence = 0;
  const nativeConsumer = "checkpoint-reactor.runtime-outcomes.v1";
  type WorkspaceSelection = {
    readonly key: string;
    readonly cwd: string | undefined;
    readonly isGitRepository: boolean;
    readonly projectId: ProjectId | undefined;
    readonly fallbackCwd: string | undefined;
    readonly sourceCwd: string | undefined;
    readonly classifiedAt: number;
  };
  const keys = new Map<string, WorkspaceSelection>();
  const changedWorkspaceThreads = new Set<string>();
  const changedSessionThreads = new Set<string>();
  const runtimeRelevant = (event: ProviderRuntimeEvent) =>
    event.type === "turn.started" ||
    event.type === "turn.completed" ||
    (event.type === "item.completed" && event.payload.itemType === "file_change");
  const domainRelevant = (event: OrchestrationEvent) =>
    (event.sequence > startupDomainFence && event.type === "thread.turn-start-requested") ||
    event.type === "thread.checkpoint-revert-requested" ||
    event.type === "thread.turn-diff-completed";
  const observeWorkspaceConfiguration = (event: OrchestrationEvent) => {
    if (event.sequence <= workspaceConfigurationSequence) return;
    if (
      event.type === "thread.meta-updated" &&
      (event.payload.worktreePath !== undefined ||
        event.payload.workingDirectory !== undefined ||
        event.payload.envMode !== undefined)
    ) {
      workspaceConfigurationSequence = event.sequence;
      if (keys.has(event.aggregateId)) changedWorkspaceThreads.add(event.aggregateId);
    } else if (event.type === "project.meta-updated" && event.payload.workspaceRoot !== undefined) {
      workspaceConfigurationSequence = event.sequence;
      for (const [threadId, workspace] of keys) {
        if (workspace.projectId === event.aggregateId) changedWorkspaceThreads.add(threadId);
      }
    } else if (event.type === "thread.session-set") {
      workspaceConfigurationSequence = event.sequence;
      if (keys.has(event.aggregateId)) changedSessionThreads.add(event.aggregateId);
    }
  };
  const publishWorkspaceSelection = (
    threadId: ThreadId,
    selected: WorkspaceSelection,
    expectedConfiguration: number,
  ) => {
    // A lookup/cut can yield while configuration observers invalidate its cwd.
    // Keep that newer invalidation intact; the current row retains its selected
    // identity, but a later input must resolve again. Unrelated configuration
    // updates conservatively discard a usable cache result too.
    if (expectedConfiguration !== workspaceConfigurationSequence) return;
    const cached = keys.get(threadId);
    changedWorkspaceThreads.delete(threadId);
    changedSessionThreads.delete(threadId);
    if (cached !== undefined && cached.key !== selected.key) {
      rescanRequested = true;
      Queue.offerUnsafe(wake, undefined);
    }
    // This lookup cache is bounded independently of workspace admission.
    if (keys.size >= CHECKPOINT_REACTOR_CAPACITY && !keys.has(threadId)) {
      const oldest = keys.keys().next().value!;
      keys.delete(oldest);
      changedWorkspaceThreads.delete(oldest);
      changedSessionThreads.delete(oldest);
    }
    keys.set(threadId, selected);
  };
  const workspaceForThread = Effect.fnUntraced(function* (threadId: ThreadId, publish = true) {
    const configuration = workspaceConfigurationSequence;
    const cached = keys.get(threadId);
    let observedCwd: { readonly source: string; readonly physical: string } | undefined;
    // A turn may initialize Git after its start row. Recheck missing Git until
    // discovered; each operation then keeps its captured classification/cwd.
    if (
      cached !== undefined &&
      (cached.isGitRepository || Date.now() - cached.classifiedAt < 1_000) &&
      !changedWorkspaceThreads.has(threadId)
    ) {
      if (!changedSessionThreads.has(threadId)) return cached;
      const session = yield* resolveSessionRuntimeForThread(threadId);
      const candidateCwd = Option.isSome(session) ? session.value.cwd : cached.fallbackCwd;
      if (candidateCwd === cached.sourceCwd) {
        if (publish) publishWorkspaceSelection(threadId, cached, configuration);
        return cached;
      }
      const physicalCwd =
        candidateCwd === undefined
          ? undefined
          : yield* Effect.tryPromise(() => canonicalImportPath(candidateCwd)).pipe(Effect.orDie);
      if (candidateCwd !== undefined && physicalCwd !== undefined)
        observedCwd = { source: candidateCwd, physical: physicalCwd };
      if (physicalCwd === cached.cwd) {
        const selected = { ...cached, sourceCwd: candidateCwd };
        if (publish) publishWorkspaceSelection(threadId, selected, configuration);
        return selected;
      }
    }
    const thread = yield* getThreadDetail(threadId);
    const project = thread ? yield* getProjectShell(thread.projectId) : undefined;
    const workspace =
      thread && project
        ? yield* resolveCheckpointWorkspace({
            threadId,
            thread,
            project,
            ...(observedCwd === undefined ? {} : { observedCwd }),
          })
        : undefined;
    const key = workspace?.identity ?? `thread:${threadId}`;
    const selected = {
      key,
      cwd: workspace?.cwd,
      sourceCwd: workspace?.sourceCwd,
      isGitRepository: workspace?.isGitRepository ?? false,
      classifiedAt: Date.now(),
      projectId: thread?.projectId,
      fallbackCwd:
        thread && project ? resolveThreadWorkspaceCwd({ thread, projects: [project] }) : undefined,
    };
    if (publish) publishWorkspaceSelection(threadId, selected, configuration);
    return selected;
  });
  const eventThread = (event: OrchestrationEvent) => ThreadId.makeUnsafe(event.aggregateId);
  const domainEventTypes: ReadonlyArray<OrchestrationEvent["type"]> = [
    "thread.turn-start-requested",
    "thread.checkpoint-revert-requested",
    "thread.turn-diff-completed",
    "thread.meta-updated",
    "project.meta-updated",
    "thread.session-set",
  ];
  const readDomainPage = (from: number, through: number) =>
    Stream.runCollect(
      eventStore.readFromSequence(from, 32, through, { eventTypes: domainEventTypes }),
    );
  // A matching accepted receipt/outcome is immutable evidence. Settle an
  // interrupted delivery by its observed owner/state without replaying work.
  const settleProvenDelivery = (consumerName: string, eventSequence: number, threadId: ThreadId) =>
    Effect.gen(function* () {
      const previous = yield* deliveries
        .getDelivery({ consumerName, eventSequence })
        .pipe(Effect.orDie);
      if (Option.isNone(previous)) return;
      const delivery = previous.value;
      if (delivery.threadId !== threadId)
        return yield* Effect.die(new Error("Checkpoint receipt does not match delivery identity"));
      if (delivery.state === "succeeded") return;
      const now = new Date().toISOString();
      const completed = yield* sql`UPDATE orchestration_event_deliveries
      SET state = 'succeeded', claim_owner = NULL, claimed_at = NULL, claim_expires_at = NULL, completed_at = ${now}, updated_at = ${now}, last_error = NULL
      WHERE consumer_name = ${consumerName} AND event_sequence = ${eventSequence} AND thread_id = ${threadId}
        AND state = ${delivery.state} AND claim_owner IS ${delivery.claimOwner}
      RETURNING event_sequence`.pipe(Effect.orDie);
      if (completed.length !== 1)
        return yield* Effect.die(
          new Error("Checkpoint receipt settlement lost delivery ownership"),
        );
    });
  const processDurableDomain = Effect.fnUntraced(function* (event: OrchestrationEvent) {
    if (event.type !== "thread.checkpoint-revert-requested") {
      // An unavailable range can be rediscovered by a peer lane after its
      // bounded settlement. Its durable marker forbids any late capture.
      const unavailable = yield* deliveries
        .getDelivery({ consumerName: domainConsumer, eventSequence: event.sequence })
        .pipe(Effect.orDie);
      if (Option.isSome(unavailable)) return;
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
    if (receipt.length)
      return yield* settleProvenDelivery(domainConsumer, event.sequence, event.payload.threadId);
    if (event.sequence <= adoptionFence) {
      const failure = yield* sql`SELECT 1 FROM orchestration_events AS outcome
        WHERE outcome.aggregate_kind = 'thread' AND outcome.stream_id = ${event.payload.threadId} AND outcome.event_type = 'thread.activity-appended'
          AND outcome.sequence > ${event.sequence}
          AND json_extract(outcome.payload_json, '$.activity.kind') = 'checkpoint.revert.failed'
          AND json_extract(outcome.payload_json, '$.activity.payload.turnCount') = ${event.payload.turnCount}
          AND NOT EXISTS (SELECT 1 FROM orchestration_events AS next
            WHERE next.aggregate_kind = 'thread' AND next.stream_id = outcome.stream_id AND next.event_type = 'thread.checkpoint-revert-requested'
              AND next.sequence > ${event.sequence} AND next.sequence < outcome.sequence)
        LIMIT 1`.pipe(Effect.orDie);
      if (failure.length) {
        yield* settleProvenDelivery(domainConsumer, event.sequence, event.payload.threadId);
        return;
      }
    }
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
    if (event.sequence <= adoptionFence) {
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
    // CP ACK belongs exclusively to the settled minimum of workspace lanes.
    // The generic delivery adapter may advance its consumer per row.
    const completedAt = new Date().toISOString();
    const completed = yield* sql`UPDATE orchestration_event_deliveries
      SET state = 'succeeded', claim_owner = NULL, claimed_at = NULL,
        claim_expires_at = NULL, completed_at = ${completedAt}, updated_at = ${completedAt}
      WHERE consumer_name = ${domainConsumer} AND event_sequence = ${event.sequence}
        AND state = 'inflight' AND claim_owner = ${claimOwner}
      RETURNING event_sequence`.pipe(Effect.orDie);
    if (completed.length !== 1)
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
    if (receipt.length)
      return yield* settleProvenDelivery(nativeConsumer, sequence, event.threadId);
    if (Option.isSome(previous)) {
      if (previous.value.state === "uncertain" || previous.value.state === "dead") {
        yield* appendCheckpointIssueActivity({
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
            appendCheckpointIssueActivity({
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
    const historical = sequence <= Math.max(runtimeAdoptionFence, startupRuntimeFence);
    if (historical) {
      const thread = yield* getThreadDetail(event.threadId);
      const checkpoint = thread?.checkpoints.find(
        (checkpoint) =>
          checkpoint.turnId === event.turnId &&
          checkpoint.status !== "missing" &&
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
        // Ingestion acceptance is not proof of a new Git snapshot. It does
        // prove this legacy row was handled; non-Git, undone and deliberately
        // skipped turns must not acquire a fresh error merely because this
        // consumer is new. Only a missing placeholder proves an interruption.
        const interrupted = thread?.checkpoints.some(
          (checkpoint) => checkpoint.turnId === event.turnId && checkpoint.status === "missing",
        );
        if (sequence > startupIngestionFence || interrupted) {
          yield* uncertain(
            "A native completion present before checkpoint startup has no immutable checkpoint outcome; the current workspace was not recaptured during recovery.",
          );
          return;
        }
        yield* Effect.logDebug(
          "Accepted legacy native checkpoint history adopted without recapture",
        );
      }
    }
    let successful = true;
    // An adopted legacy row may only keep its proven existing snapshot. A
    // missing projection/ref becomes uncertain above; neither path captures
    // today's working tree as the outcome of a previously accepted turn.
    yield* (historical ? Effect.void : captureCheckpointFromTurnCompletion(event)).pipe(
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
  type UnavailableWorkspace = {
    readonly threadId: ThreadId;
    readonly ready: Deferred.Deferred<void, unknown>;
    replayOnRecovery: boolean;
    readonly observedWorkspaceClock: number;
    runtimePin: number;
    domainPin: number;
    runtimeFrom: number;
    domainFrom: number;
    runtimeThrough: number;
    domainThrough: number;
  };
  const unavailableWorkspaces = new Map<string, UnavailableWorkspace>();
  let workspaceClock = 0;
  let evictedWorkspaceClock = 0;
  const workspaceWorkClocks = new Map<string, number>();
  const recordWorkspaceWork = (key: string) => {
    if (unavailableWorkspaces.size === 0) return;
    workspaceWorkClocks.set(key, ++workspaceClock);
    if (workspaceWorkClocks.size > CHECKPOINT_REACTOR_CAPACITY) {
      workspaceWorkClocks.delete(workspaceWorkClocks.keys().next().value!);
      evictedWorkspaceClock = workspaceClock;
    }
  };
  const definitiveWorkspaceFailure = (cause: Cause.Cause<unknown>) => {
    let error = Cause.squash(cause);
    for (let depth = 0; depth < 8 && typeof error === "object" && error !== null; depth++) {
      if (
        "code" in error &&
        (error.code === "ENOENT" ||
          error.code === "ENOTDIR" ||
          error.code === "EACCES" ||
          error.code === "EPERM")
      )
        return true;
      error = "cause" in error ? error.cause : undefined;
    }
    return false;
  };
  const invalidateNonGitCompletion = (event: ProviderRuntimeEvent) => {
    if (event.type === "turn.completed" && keys.get(event.threadId)?.isGitRepository === false)
      keys.delete(event.threadId);
  };

  // Failed identity recovery has its own bounded read-only execution budget;
  // it cannot occupy normal workspace workers or decode 256 pages in parallel.
  const recoverySlots = yield* Semaphore.make(2);
  const claimUnavailableRow = (
    source: "runtime" | "domain",
    sequence: number,
    threadId: ThreadId,
  ) =>
    Effect.gen(function* () {
      const input = {
        consumerName: source === "runtime" ? nativeConsumer : domainConsumer,
        eventSequence: sequence,
      };
      const previous = yield* deliveries.getDelivery(input).pipe(Effect.orDie);
      if (Option.isSome(previous) && previous.value.state !== "retry") return previous;
      const now = new Date().toISOString();
      return yield* deliveries
        .claim({
          ...input,
          threadId,
          claimOwner,
          claimedAt: now,
          claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
        .pipe(Effect.orDie);
    });
  const settleUnavailableRow = (
    source: "runtime" | "domain",
    sequence: number,
    event: ProviderRuntimeEvent | OrchestrationEvent,
  ) =>
    Effect.gen(function* () {
      const threadId =
        source === "runtime"
          ? (event as ProviderRuntimeEvent).threadId
          : eventThread(event as OrchestrationEvent);
      if (source === "runtime" && event.type === "turn.completed") {
        const native = event as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;
        const receipt = yield* sql`SELECT 1 FROM orchestration_command_receipts AS receipt
          WHERE receipt.command_id = ${`server:checkpoint-native-complete:${encodeURIComponent(threadId)}:${encodeURIComponent(native.turnId ?? "")}`}
            AND receipt.aggregate_kind = 'thread' AND receipt.aggregate_id = ${threadId} AND receipt.status = 'accepted'
            AND EXISTS (SELECT 1 FROM orchestration_events AS outcome WHERE outcome.command_id = receipt.command_id
              AND outcome.event_type = 'thread.turn-diff-completed' AND json_extract(outcome.payload_json, '$.turnId') = ${native.turnId ?? ""})`.pipe(
          Effect.orDie,
        );
        if (receipt.length) return yield* settleProvenDelivery(nativeConsumer, sequence, threadId);
      }
      if (source === "domain" && event.type === "thread.checkpoint-revert-requested") {
        const revert = event as Extract<
          OrchestrationEvent,
          { type: "thread.checkpoint-revert-requested" }
        >;
        const receipt = yield* sql`SELECT 1 FROM orchestration_command_receipts AS receipt
          WHERE receipt.command_id = ${`server:checkpoint-revert-complete:${revert.eventId}`}
            AND receipt.aggregate_kind = 'thread' AND receipt.aggregate_id = ${threadId} AND receipt.status = 'accepted'
            AND EXISTS (SELECT 1 FROM orchestration_events AS outcome WHERE outcome.command_id = receipt.command_id
              AND outcome.event_type = 'thread.reverted' AND json_extract(outcome.payload_json, '$.turnCount') = ${revert.payload.turnCount})`.pipe(
          Effect.orDie,
        );
        if (receipt.length) return yield* settleProvenDelivery(domainConsumer, sequence, threadId);
      }
      const input = {
        consumerName: source === "runtime" ? nativeConsumer : domainConsumer,
        eventSequence: sequence,
      };
      const claimed = yield* claimUnavailableRow(source, sequence, threadId);
      if (Option.isNone(claimed))
        return yield* Effect.die(
          new Error("Unavailable checkpoint could not establish durable settlement ownership"),
        );
      if (claimed.value.state === "succeeded") return;
      const detail =
        claimed.value.claimOwner !== null && claimed.value.claimOwner !== claimOwner
          ? "A previous checkpoint attempt has no recorded outcome. It was not replayed after workspace resolution failed; inspect the workspace before requesting another operation."
          : (claimed.value.lastError ??
            "Workspace identity was unavailable before checkpoint admission. This pending operation was not applied, and will not be replayed after workspace access recovers. Request a new operation after inspecting the workspace.");
      const now = new Date().toISOString();
      if (claimed.value.state === "inflight") {
        const settled = yield* deliveries
          .markTerminalFailure({
            ...input,
            expectedClaimOwner: claimed.value.claimOwner!,
            state: "uncertain",
            error: detail,
            updatedAt: now,
          })
          .pipe(Effect.orDie);
        if (!settled)
          return yield* Effect.die(
            new Error("Unavailable checkpoint lost durable settlement ownership"),
          );
      }
      if (source === "domain" && event.type === "thread.checkpoint-revert-requested") {
        const revert = event as Extract<
          OrchestrationEvent,
          { type: "thread.checkpoint-revert-requested" }
        >;
        const model = yield* orchestrationEngine.getReadModel();
        const thread = model.threads.find((entry) => entry.id === threadId);
        yield* appendRevertFailureActivity({
          threadId,
          turnCount: revert.payload.turnCount,
          detail,
          createdAt: now,
          resolvedTurnId:
            thread?.checkpoints.find(
              (entry) => entry.checkpointTurnCount === revert.payload.turnCount,
            )?.turnId ??
            thread?.latestTurn?.turnId ??
            null,
          commandId: CommandId.makeUnsafe(`server:checkpoint-revert-outcome:${revert.eventId}`),
        });
      } else if (!(source === "domain" && event.type === "thread.turn-diff-completed")) {
        yield* appendCheckpointIssueActivity({
          threadId,
          turnId: source === "runtime" ? toTurnId((event as ProviderRuntimeEvent).turnId) : null,
          detail,
          createdAt: now,
          commandId: CommandId.makeUnsafe(
            source === "runtime" && event.type === "turn.completed"
              ? `server:checkpoint-native-outcome:${sequence}`
              : `server:checkpoint-unavailable:${source}:${sequence}`,
          ),
        });
      }
    });
  const recoverUnavailableWorkspace = (pending: UnavailableWorkspace) =>
    Effect.gen(function* () {
      // Read-only retries may discover the identity for future inputs. Peers can
      // already have edited an alias, so none of this pending range may mutate.
      const configuration = workspaceConfigurationSequence;
      let recovered: WorkspaceSelection | undefined;
      // A transient lookup failure gets a longer, still bounded retry window;
      // only after it is exhausted does the range settle as uncertain.
      for (let attempt = 0; !stopping && attempt < (pending.replayOnRecovery ? 6 : 3); attempt++) {
        yield* Effect.sleep(50 * (attempt + 1));
        const resolved = yield* workspaceForThread(pending.threadId, false).pipe(
          Effect.timeoutOption(pending.replayOnRecovery ? 1_000 : 200),
          Effect.exit,
        );
        if (resolved._tag === "Success" && Option.isSome(resolved.value)) {
          recovered = resolved.value.value;
          break;
        }
        if (resolved._tag === "Failure" && definitiveWorkspaceFailure(resolved.cause))
          pending.replayOnRecovery = false;
      }
      if (stopping) return;
      if (pending.replayOnRecovery && recovered !== undefined) {
        // Transient latency is not proof that an operation is lost. Resume its
        // durable range unless a peer has already touched this physical checkout
        // while its identity was unknown (or bounded evidence was evicted).
        const unsafeAlias =
          (workspaceWorkClocks.get(recovered.key) ?? 0) > pending.observedWorkspaceClock ||
          evictedWorkspaceClock > pending.observedWorkspaceClock;
        if (!unsafeAlias) {
          publishWorkspaceSelection(pending.threadId, recovered, configuration);
          unavailableWorkspaces.delete(pending.threadId);
          if (unavailableWorkspaces.size === 0) workspaceWorkClocks.clear();
          rescanRequested = true;
          Queue.offerUnsafe(wake, undefined);
          return;
        }
      }
      pending.replayOnRecovery = false;
      // Admission may be behind the journals while lookup waits. Fence both
      // durable sources once, before exposing the recovered identity, so rows
      // committed during that wait cannot become fresh work after a peer Undo.
      // Later admissions can extend the pending range; do not chase high-water
      // on every settlement page or retain a continuously active thread forever.
      const cuts = yield* sql
        .withTransaction(
          sql<{ runtimeSequence: number; domainSequence: number }>`SELECT
            COALESCE((SELECT MAX(sequence) FROM provider_runtime_events), 0) AS runtimeSequence,
            COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS domainSequence`,
        )
        .pipe(Effect.orDie);
      if (cuts.length !== 1)
        return yield* Effect.die(new Error("Checkpoint recovery could not establish durable cuts"));
      pending.runtimeThrough = Math.max(pending.runtimeThrough, cuts[0]!.runtimeSequence);
      pending.domainThrough = Math.max(pending.domainThrough, cuts[0]!.domainSequence);
      if (recovered !== undefined)
        publishWorkspaceSelection(pending.threadId, recovered, configuration);
      while (!stopping) {
        const runtimeThrough = pending.runtimeThrough;
        const domainThrough = pending.domainThrough;
        const runtimePage = yield* runtimeRepository
          .readAfter({
            sequenceExclusive: pending.runtimeFrom,
            throughSequenceInclusive: runtimeThrough,
            limit: 32,
            checkpointRelevantOnly: true,
          })
          .pipe(Effect.orDie);
        for (const row of runtimePage) {
          if (row.event.threadId === pending.threadId)
            yield* settleUnavailableRow("runtime", row.sequence, row.event);
          pending.runtimeFrom = row.sequence;
        }
        if (runtimePage.length < 32) pending.runtimeFrom = runtimeThrough;
        const domainPage = yield* readDomainPage(pending.domainFrom, domainThrough).pipe(
          Effect.orDie,
        );
        for (const event of domainPage) {
          if (event.aggregateId === pending.threadId && domainRelevant(event))
            yield* settleUnavailableRow("domain", event.sequence, event);
          pending.domainFrom = event.sequence;
        }
        if (domainPage.length < 32) pending.domainFrom = domainThrough;
        if (
          pending.runtimeFrom >= pending.runtimeThrough &&
          pending.domainFrom >= pending.domainThrough
        ) {
          unavailableWorkspaces.delete(pending.threadId);
          Queue.offerUnsafe(acknowledge, undefined);
          Queue.offerUnsafe(wake, undefined);
          return;
        }
        yield* Effect.yieldNow;
      }
    }).pipe(
      recoverySlots.withPermits(1),
      Effect.raceFirst(Deferred.await(stopped)),
      Effect.catchCause(failSource),
    );
  const selectWorkspace = (
    threadId: ThreadId,
    source: "runtime" | "domain",
    sequence: number,
    floor: { runtimeFrom: number; domainFrom: number },
  ) =>
    Effect.gen(function* () {
      let pending = unavailableWorkspaces.get(threadId);
      let created = false;
      if (pending === undefined) {
        const selected = yield* workspaceForThread(threadId).pipe(
          Effect.timeout("200 millis"),
          Effect.exit,
        );
        // Resolution yields: another lane may have established a conservative
        // unavailable range while this attempt was waiting on projection/I/O.
        pending = unavailableWorkspaces.get(threadId);
        if (pending === undefined && selected._tag === "Success") return selected.value;
        if (selected._tag === "Failure" && Cause.hasInterruptsOnly(selected.cause))
          return yield* Effect.failCause(selected.cause);
        while (
          pending === undefined &&
          unavailableWorkspaces.size >= CHECKPOINT_REACTOR_CAPACITY &&
          !stopping
        ) {
          yield* Effect.sleep("1 millis");
          pending = unavailableWorkspaces.get(threadId);
        }
        if (stopping) return undefined;
        if (pending === undefined) {
          // Only cursors are retained. Claim before any peer can pass this row.
          pending = {
            threadId,
            ready: Deferred.makeUnsafe<void, unknown>(),
            replayOnRecovery:
              selected._tag === "Failure" && !definitiveWorkspaceFailure(selected.cause),
            observedWorkspaceClock: workspaceClock,
            runtimePin: floor.runtimeFrom,
            domainPin: floor.domainFrom,
            runtimeFrom: floor.runtimeFrom,
            domainFrom: floor.domainFrom,
            runtimeThrough: runtimeFence,
            domainThrough: domainFence,
          };
          unavailableWorkspaces.set(threadId, pending);
          created = true;
          yield* (
            pending.replayOnRecovery ? Effect.void : claimUnavailableRow(source, sequence, threadId)
          ).pipe(
            Effect.catchCause((cause) =>
              Deferred.failCause(pending!.ready, cause).pipe(
                Effect.andThen(Effect.failCause(cause)),
              ),
            ),
          );
          yield* Deferred.succeed(pending.ready, undefined);
          yield* Effect.logWarning(
            pending.replayOnRecovery
              ? "Checkpoint workspace lookup delayed; durable work retained for retry"
              : "checkpoint workspace unavailable; pending operations will not be replayed",
            { operation: "workspace resolution" },
          );
        }
      }
      if (!created) {
        yield* Deferred.await(pending.ready);
        if (!pending.replayOnRecovery) yield* claimUnavailableRow(source, sequence, threadId);
        // If the old recovery finished during the claim, keep the new row
        // pinned and schedule another bounded settlement pass.
        const current = unavailableWorkspaces.get(threadId);
        if (current !== undefined) pending = current;
        else {
          unavailableWorkspaces.set(threadId, pending);
          created = true;
        }
        pending.runtimePin = Math.min(pending.runtimePin, floor.runtimeFrom);
        pending.domainPin = Math.min(pending.domainPin, floor.domainFrom);
        pending.runtimeFrom = Math.min(pending.runtimeFrom, floor.runtimeFrom);
        pending.domainFrom = Math.min(pending.domainFrom, floor.domainFrom);
      }
      pending.runtimeThrough = Math.max(
        pending.runtimeThrough,
        runtimeFence,
        source === "runtime" ? sequence : 0,
      );
      pending.domainThrough = Math.max(
        pending.domainThrough,
        domainFence,
        source === "domain" ? sequence : 0,
      );
      if (created) yield* Effect.forkScoped(recoverUnavailableWorkspace(pending));
      return undefined;
    });
  const processLane = (lane: WorkspaceLane) =>
    Effect.gen(function* () {
      lane.continuation = false;
      let processed = 0;
      let refreshFences = true;
      let domainPage: ReadonlyArray<OrchestrationEvent> = [];
      let domainIndex = 0;
      let runtimePage: ReadonlyArray<
        import("../../persistence/Services/ProviderRuntimeEvents.ts").PersistedProviderRuntimeEvent
      > = [];
      let runtimeIndex = 0;
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
        if (domainIndex >= domainPage.length && lane.domainFrom < lane.domainFence) {
          domainPage = yield* readDomainPage(lane.domainFrom, lane.domainFence).pipe(Effect.orDie);
          domainIndex = 0;
          if (domainPage.length === 0) lane.domainFrom = lane.domainFence;
        }
        const nextDomain = domainPage[domainIndex];
        if (nextDomain) observeWorkspaceConfiguration(nextDomain);
        const domainWorkspace =
          nextDomain && domainRelevant(nextDomain)
            ? yield* selectWorkspace(eventThread(nextDomain), "domain", nextDomain.sequence, lane)
            : undefined;
        if (nextDomain && (!domainRelevant(nextDomain) || domainWorkspace?.key !== lane.key)) {
          lane.domainFrom = nextDomain.sequence;
          domainIndex++;
          processed++;
          continue;
        }
        const cut = nextDomain?.metadata.checkpointRuntimeSequence;
        const runtimeThrough =
          cut === undefined ? lane.runtimeFence : Math.max(lane.runtimeFence, cut);
        if (runtimeIndex >= runtimePage.length && lane.runtimeFrom < runtimeThrough) {
          runtimePage = yield* runtimeRepository
            .readAfter({
              sequenceExclusive: lane.runtimeFrom,
              throughSequenceInclusive: runtimeThrough,
              limit: 32,
              checkpointRelevantOnly: true,
            })
            .pipe(Effect.orDie);
          runtimeIndex = 0;
          if (runtimePage.length === 0) lane.runtimeFrom = runtimeThrough;
        }
        const nextRuntime = runtimePage[runtimeIndex];
        if (
          nextRuntime &&
          (nextDomain === undefined || cut === undefined || nextRuntime.sequence <= cut)
        ) {
          const selectedWorkspace = runtimeRelevant(nextRuntime.event)
            ? yield* selectWorkspace(
                nextRuntime.event.threadId,
                "runtime",
                nextRuntime.sequence,
                lane,
              )
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
                  : nextRuntime.sequence <= Math.max(runtimeAdoptionFence, startupRuntimeFence)
                    ? Effect.void
                    : deliveries
                        .getDelivery({
                          consumerName: nativeConsumer,
                          eventSequence: nextRuntime.sequence,
                        })
                        .pipe(
                          Effect.orDie,
                          Effect.flatMap((unavailable) =>
                            Option.isSome(unavailable)
                              ? Effect.void
                              : processInputSafely({ source: "runtime", event: nextRuntime.event }),
                          ),
                        );
              refreshFences = true;
              yield* withPinnedWorkspaceLease(
                Effect.sync(() => recordWorkspaceWork(lane.key)).pipe(Effect.andThen(work)),
              ).pipe(
                Effect.provideService(PinnedCheckpointWorkspace, {
                  cwd: selectedWorkspace.cwd,
                  identity: selectedWorkspace.cwd === undefined ? undefined : selectedWorkspace.key,
                  isGitRepository: selectedWorkspace.isGitRepository,
                }),
              );
            }
          }
          lane.runtimeFrom = nextRuntime.sequence;
          runtimeIndex++;
        } else if (nextDomain) {
          // Every native checkpoint row through the atomic domain commit cut has
          // settled in this workspace before the domain mutation may run.
          const selectedWorkspace = domainWorkspace;
          if (selectedWorkspace?.key === lane.key) {
            refreshFences = true;
            recordWorkspaceWork(lane.key);
            yield* processDurableDomain(nextDomain).pipe(
              Effect.provideService(PinnedCheckpointWorkspace, {
                cwd: selectedWorkspace.cwd,
                identity: selectedWorkspace.cwd === undefined ? undefined : selectedWorkspace.key,
                isGitRepository: selectedWorkspace.isGitRepository,
              }),
            );
          }
          lane.domainFrom = nextDomain.sequence;
          domainIndex++;
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
    const selected = yield* selectWorkspace(threadId, source, sequence, {
      runtimeFrom: runtimeScanned,
      domainFrom: domainScanned,
    });
    if (selected === undefined) return;
    const key = selected.key;
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
    if (legacyDomainFrom < adoptionFence) {
      const events = yield* Stream.runCollect(
        eventStore.readFromSequence(legacyDomainFrom, 32, adoptionFence, {
          eventTypes: ["thread.checkpoint-revert-requested"],
        }),
      ).pipe(Effect.orDie);
      for (const event of events) yield* processDurableDomain(event);
      const through = events.length < 32 ? adoptionFence : events[events.length - 1]!.sequence;
      yield* sql`UPDATE orchestration_consumer_state SET last_acked_sequence = ${through}, updated_at = ${new Date().toISOString()}
        WHERE consumer_name = ${legacyDomainConsumer} AND last_acked_sequence = ${legacyDomainFrom}`.pipe(
        Effect.orDie,
      );
      legacyDomainFrom = through;
      if (legacyDomainFrom < adoptionFence) Queue.offerUnsafe(wake, undefined);
    }
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
    for (const pending of unavailableWorkspaces.values()) {
      runtimeThrough = Math.min(runtimeThrough, pending.runtimePin);
      domainThrough = Math.min(domainThrough, pending.domainPin);
    }
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const runtimeCursor = yield* runtimeRepository.getConsumerCursor(
            CHECKPOINT_RUNTIME_CONSUMER,
          );
          const rows = yield* sql<{
            sequence: number | null;
          }>`SELECT MAX(sequence) AS sequence FROM provider_runtime_events WHERE sequence > ${runtimeCursor} AND sequence <= ${runtimeThrough}`;
          const runtimeTarget = rows[0]?.sequence;
          if (runtimeTarget !== undefined && runtimeTarget !== null) {
            const advanced = yield* runtimeRepository.advanceConsumerCursorThrough({
              consumerName: CHECKPOINT_RUNTIME_CONSUMER,
              throughSequence: runtimeTarget,
              updatedAt: new Date().toISOString(),
            });
            if (!advanced)
              return yield* Effect.die(new Error("Checkpoint runtime ACK lost its stored target"));
            yield* sql`DELETE FROM orchestration_event_deliveries WHERE consumer_name = ${nativeConsumer} AND event_sequence <= ${runtimeTarget}`;
          }
          const state = yield* deliveries.getConsumerState(domainConsumer);
          const cursor = Option.isSome(state) ? state.value.lastAckedSequence : 0;
          const domainRows = yield* sql<{
            sequence: number | null;
          }>`SELECT MAX(sequence) AS sequence FROM orchestration_events WHERE sequence > ${cursor} AND sequence <= ${domainThrough}`;
          const target = domainRows[0]?.sequence;
          if (target !== undefined && target !== null) {
            yield* sql`UPDATE orchestration_consumer_state SET last_acked_sequence = ${target}, updated_at = ${new Date().toISOString()}
          WHERE consumer_name = ${domainConsumer} AND last_acked_sequence = ${cursor}
            AND NOT EXISTS (SELECT 1 FROM orchestration_event_deliveries WHERE consumer_name = ${domainConsumer}
              AND event_sequence > ${cursor} AND event_sequence <= ${target} AND state IN ('inflight', 'retry'))`;
          }
        }),
      )
      .pipe(Effect.orDie);
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
        lanes.size === 0 &&
        unavailableWorkspaces.size === 0 &&
        legacyDomainFrom >= adoptionFence
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
        ) {
          // Owned work can append an outcome after the heads sampled above.
          // Do not report settled until that newly committed prefix is ACKed.
          const finalRuntimeHead = yield* runtimeRepository.getHighWaterSequence.pipe(Effect.orDie);
          const finalDomainHead = yield* orchestrationEngine.getEventHighWaterSequence.pipe(
            Effect.orDie,
          );
          if (runtimeScanned >= finalRuntimeHead && domainScanned >= finalDomainHead) return;
        }
      }
      yield* Effect.sleep("1 millis");
    }
  }).pipe(Effect.raceFirst(Deferred.await(fatal)), Effect.orDie);
  const start: CheckpointReactorShape["start"] = Effect.gen(function* () {
    if (started) return;
    const runtimeHighWater = yield* runtimeRepository.getHighWaterSequence.pipe(Effect.orDie);
    const highWater = yield* orchestrationEngine.getEventHighWaterSequence.pipe(Effect.orDie);
    startupRuntimeFence = runtimeHighWater;
    startupDomainFence = highWater;
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
          startupIngestionFence = ingestionCursor;
          // These immutable cuts survive restart. A missing cut is legacy or
          // incomplete protocol evidence even when a domain consumer exists;
          // adopt high-water conservatively. Neither ACK pump advances the cuts.
          yield* sql`INSERT INTO orchestration_consumer_state (consumer_name, last_acked_sequence, created_at, updated_at)
        VALUES (${runtimeAdoptionConsumer}, ${existingRuntimeConsumer.length ? 0 : Math.max(ingestionCursor, runtimeHighWater)}, ${now}, ${now}) ON CONFLICT (consumer_name) DO NOTHING`;
          yield* sql`INSERT INTO orchestration_consumer_state (consumer_name, last_acked_sequence, created_at, updated_at)
        VALUES (${domainAdoptionConsumer}, ${highWater}, ${now}, ${now}) ON CONFLICT (consumer_name) DO NOTHING`;
          yield* sql`INSERT INTO provider_runtime_event_consumers (consumer_name, last_acked_sequence, created_at, updated_at)
        VALUES (${CHECKPOINT_RUNTIME_CONSUMER}, 0, ${now}, ${now}) ON CONFLICT (consumer_name) DO NOTHING`;
          yield* sql`INSERT INTO orchestration_consumer_state (consumer_name, last_acked_sequence, created_at, updated_at)
        VALUES (${domainConsumer}, ${highWater}, ${now}, ${now}) ON CONFLICT (consumer_name) DO NOTHING`;
          yield* sql`INSERT INTO orchestration_consumer_state (consumer_name, last_acked_sequence, created_at, updated_at)
        VALUES (${legacyDomainConsumer}, 0, ${now}, ${now}) ON CONFLICT (consumer_name) DO NOTHING`;
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
    const legacyState = yield* deliveries.getConsumerState(legacyDomainConsumer).pipe(Effect.orDie);
    legacyDomainFrom = Option.isSome(legacyState) ? legacyState.value.lastAckedSequence : 0;
    runtimeScanned = yield* runtimeRepository
      .getConsumerCursor(CHECKPOINT_RUNTIME_CONSUMER)
      .pipe(Effect.orDie);
    const state = yield* deliveries.getConsumerState(domainConsumer).pipe(Effect.orDie);
    domainScanned = Option.isSome(state) ? state.value.lastAckedSequence : 0;
    workspaceConfigurationSequence = domainScanned;
    started = true;
    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(acknowledge).pipe(
          Effect.andThen(pumpAcknowledgements),
          // The sliding queue keeps one pending request, so a streaming burst
          // pays at most one ACK transaction per interval.
          Effect.andThen(Effect.sleep(CHECKPOINT_ACK_INTERVAL_MS)),
        ),
      ).pipe(Effect.catchCause(failSource)),
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
            invalidateNonGitCompletion(row.event);
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
            ? Effect.sync(() => invalidateNonGitCompletion(event)).pipe(
                Effect.andThen(runtimeRepository.append(event)),
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
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(ProjectionTurnRepositoryLive),
  Layer.provide(ProviderRuntimeEventRepositoryLive),
  Layer.provide(OrchestrationEventDeliveryRepositoryLive),
);
