import type {
  ChatAttachment,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  SpaceId,
  ThreadId,
} from "@synara/contracts";
import { OrchestrationCommand, ORCHESTRATION_WS_METHODS } from "@synara/contracts";
import { makeDrainableWorker } from "@synara/shared/DrainableWorker";
import { makeKeyedDrainableWorker } from "@synara/shared/KeyedDrainableWorker";
import { SIDECHAT_INACTIVITY_EXPIRY_MS, sidechatExpiryMs } from "@synara/shared/sidechatExpiry";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Ref,
  Schema,
  Semaphore,
  Scope,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  toPersistenceSqlError,
  type OrchestrationEventStoreError,
  type PersistenceSqlError,
} from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import {
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceipt,
} from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments.ts";
import { ManagedAttachmentRepositoryLive } from "../../persistence/Layers/ManagedAttachments.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { orchestrationMessageFromStoredMessage } from "../../persistence/projectionThreadMessageRow.ts";
import {
  LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
  type ManagedAttachmentPrincipal,
} from "../../managedAttachmentPrincipal.ts";
import {
  OrchestrationCommandAdmissionError,
  OrchestrationCommandIdentityCollisionError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandInternalError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationCommandTimeoutError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import {
  fingerprintOrchestrationCommand,
  type OrchestrationCommandFingerprint,
} from "../commandFingerprint.ts";
import {
  ORCHESTRATION_COMMAND_CONTROL_RESERVE,
  ORCHESTRATION_COMMAND_QUEUE_CAPACITY,
  ORCHESTRATION_EVENT_PUBSUB_CAPACITY,
  type OrchestrationCommandAdmissionDecision,
  orchestrationCommandLane,
  isQuiescingCommandAdmissible,
} from "../orchestrationAdmission.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import {
  discardMaterializedThreadGoalFile,
  isOversizedThreadGoal,
  materializeThreadGoalFile,
  pruneThreadGoalFiles,
  readMaterializedThreadGoalText,
  threadGoalFileNameFromReference,
  threadGoalFileReference,
} from "../threadGoalMaterialization.ts";
import { PROJECT_METADATA_SNAPSHOT_PROJECTORS } from "../projectMetadataProjection.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import {
  OrchestrationProjectionPipeline,
  type ShellMetadataOrchestrationEvent,
} from "../Services/ProjectionPipeline.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { REQUIRED_SNAPSHOT_PROJECTORS } from "./ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";

const ORCHESTRATION_DISPATCH_TIMEOUT_MS = 45_000;
const DEFERRED_PROJECTION_RETRY_DELAYS_MS = [100, 500, 2_000, 10_000, 30_000] as const;
/** Coalesce/skip full projection rebuilds when large state DBs make repair multi-minute. */
const PROJECTION_REPAIR_COOLDOWN_MS = 120_000;
const REQUIRED_REPAIR_PROJECTORS = Object.values(ORCHESTRATION_PROJECTOR_NAMES);

type CommandExecutionState = "queued" | "in-flight" | "abandoned";
type DispatchTimeoutDecision = { kind: "abandon" } | { kind: "wait" };
type OrchestrationEnginePhase = "running" | "quiescing" | "draining" | "stopped";

interface CommandEnvelope {
  command: OrchestrationCommand;
  settleOnly: boolean;
  attachmentPrincipal: ManagedAttachmentPrincipal;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  executionState: Ref.Ref<CommandExecutionState>;
  deadlineAtMs: number;
}

interface EngineAdmissionState {
  readonly phase: OrchestrationEnginePhase;
  readonly outstanding: number;
  readonly idle: Deferred.Deferred<void>;
}

type CommittedCommandResult = {
  readonly committedEvents: OrchestrationEvent[];
  /** Sequences whose deferred phase was settled inside the commit transaction. */
  readonly deferredSettledSequences: ReadonlySet<number>;
  readonly lastSequence: number;
  readonly nextCommandReadModel: OrchestrationReadModel;
};

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "space" | "project" | "thread";
  readonly aggregateId: SpaceId | ProjectId | ThreadId;
} {
  switch (command.type) {
    case "space.create":
    case "space.meta.update":
    case "space.reorder":
    case "space.delete":
    case "space.projects.assign":
      return {
        aggregateKind: "space",
        aggregateId: command.spaceId,
      };
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

// Space and project metadata events share the synchronous "shell" projection path: they
// are cheap, sidebar-visible rows that must be queryable the moment the command commits.
function isShellMetadataEvent(event: OrchestrationEvent): event is ShellMetadataOrchestrationEvent {
  return (
    event.type === "space.created" ||
    event.type === "space.meta-updated" ||
    event.type === "space.order-updated" ||
    event.type === "space.deleted" ||
    event.type === "project.created" ||
    event.type === "project.meta-updated" ||
    event.type === "project.deleted"
  );
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const managedAttachments = yield* ManagedAttachmentRepository;
  const messageRepository = yield* ProjectionThreadMessageRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* Effect.serviceOption(ServerSettingsService);
  const deciderWorkspacePaths = {
    homeDir: serverConfig.homeDir,
    chatWorkspaceRoot: serverConfig.chatWorkspaceRoot,
  } as const;

  let commandReadModel = createEmptyReadModel(new Date().toISOString());

  const eventPubSub = yield* PubSub.sliding<OrchestrationEvent>(
    ORCHESTRATION_EVENT_PUBSUB_CAPACITY,
  );
  const eventPublicationLock = yield* Semaphore.make(1);
  let lastPublishedSequence = 0;
  const initiallyIdle = yield* Deferred.make<void>();
  yield* Deferred.succeed(initiallyIdle, undefined).pipe(Effect.orDie);
  const engineAdmissionState = yield* Ref.make<EngineAdmissionState>({
    phase: "running",
    outstanding: 0,
    idle: initiallyIdle,
  });
  const maintenanceLock = yield* Semaphore.make(1);
  const deferredProjectionLock = yield* Semaphore.make(1);
  const deferredProjectionDirty = yield* Ref.make(false);
  let deferredProjectionCoveredSequence = 0;
  const deferredProjectionCatchUpInFlight = yield* Ref.make(false);
  const deferredProjectionRetryAttempts = yield* Ref.make(0);
  const deferredProjectionLastFailure = yield* Ref.make<string | null>(null);
  const deferredProjectionScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(deferredProjectionScope, Exit.void));
  // Full projection repair is multi-minute on large state DBs. Coalesce concurrent
  // callers onto one rebuild and skip thrash when a repair just completed.
  type ProjectionRepairError = OrchestrationDispatchError | OrchestrationEventStoreError;
  const projectionRepairInFlight = yield* Ref.make<Deferred.Deferred<
    OrchestrationReadModel,
    ProjectionRepairError
  > | null>(null);
  const lastSuccessfulProjectionRepairAtMs = yield* Ref.make(0);

  // Reactors can dispatch commands while consuming these events. Waiting for
  // a slow subscriber here would occupy command workers and block progress. Keep a
  // bounded live window; subscribers recover overflow from the durable log.
  const publishCommittedEvent = (event: OrchestrationEvent) =>
    eventPublicationLock
      .withPermits(1)(
        Effect.suspend(() =>
          event.sequence <= lastPublishedSequence
            ? Effect.void
            : PubSub.publish(eventPubSub, event).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    lastPublishedSequence = Math.max(lastPublishedSequence, event.sequence);
                  }),
                ),
              ),
        ),
      )
      .pipe(Effect.uninterruptible);

  const makeCommandTimeoutError = (command: OrchestrationCommand) =>
    new OrchestrationCommandTimeoutError({
      commandId: command.commandId,
      commandType: command.type,
      timeoutMs: ORCHESTRATION_DISPATCH_TIMEOUT_MS,
    });

  const makeCommandInternalError = (
    command: OrchestrationCommand,
    detail = "The orchestration worker crashed before the command could finish.",
  ) =>
    new OrchestrationCommandInternalError({
      commandId: command.commandId,
      commandType: command.type,
      detail,
    });

  const validateCommandReceiptIdentity = (
    receipt: OrchestrationCommandReceipt,
    fingerprint: OrchestrationCommandFingerprint,
  ): Effect.Effect<void, OrchestrationCommandIdentityCollisionError> => {
    if (
      receipt.fingerprintVersion === fingerprint.version &&
      receipt.commandFingerprint === fingerprint.value
    ) {
      return Effect.void;
    }
    const detail =
      receipt.fingerprintVersion === null || receipt.commandFingerprint === null
        ? "The stored receipt predates verifiable command fingerprints; retry with a new command ID."
        : "The command ID is already bound to different command content.";
    return Effect.fail(
      new OrchestrationCommandIdentityCollisionError({
        commandId: receipt.commandId,
        detail,
      }),
    );
  };

  const validateAcceptedAttachmentRetry = (
    command: OrchestrationCommand,
    principal: ManagedAttachmentPrincipal,
  ): Effect.Effect<void, OrchestrationCommandPreviouslyRejectedError | PersistenceSqlError> =>
    Effect.gen(function* () {
      if (command.type !== "thread.turn.start") return;
      const requestedIds = command.message.attachments
        .filter((attachment) => attachment.type === "image" || attachment.type === "file")
        .map((attachment) => attachment.id)
        .sort();
      const claimed = yield* Effect.forEach(
        requestedIds,
        (attachmentId) => managedAttachments.findClaimedById({ attachmentId }),
        { concurrency: 1 },
      );
      const claimedAttachments = claimed.flatMap((attachment) =>
        Option.isSome(attachment) ? [attachment.value] : [],
      );
      const exactIdentity =
        requestedIds.length === claimedAttachments.length &&
        claimedAttachments.every(
          (attachment) =>
            attachment.ownerThreadId === command.threadId &&
            attachment.ownerKind === principal.ownerKind &&
            attachment.ownerId === principal.ownerId &&
            attachment.claimMessageId === command.message.messageId,
        );
      if (!exactIdentity) {
        return yield* new OrchestrationCommandPreviouslyRejectedError({
          commandId: command.commandId,
          detail:
            "The command ID was already accepted with a different managed attachment set or owner.",
        });
      }
    });

  const resolveStoredCommandOutcome = (
    command: OrchestrationCommand,
    principal: ManagedAttachmentPrincipal,
    settleOnly: boolean,
  ): Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never> =>
    Effect.gen(function* () {
      const receiptExit = yield* Effect.exit(
        commandReceiptRepository.getByCommandId({
          commandId: command.commandId,
        }),
      );
      const existingReceipt = receiptExit._tag === "Success" ? receiptExit.value : Option.none();
      if (Option.isNone(existingReceipt)) {
        return yield* makeCommandTimeoutError(command);
      }
      const fingerprint = fingerprintOrchestrationCommand(command);
      yield* validateCommandReceiptIdentity(existingReceipt.value, fingerprint);
      if (existingReceipt.value.status === "accepted") {
        if (!settleOnly) yield* validateAcceptedAttachmentRetry(command, principal);
        return {
          sequence: existingReceipt.value.resultSequence,
        };
      }
      return yield* new OrchestrationCommandPreviouslyRejectedError({
        commandId: command.commandId,
        detail: existingReceipt.value.error ?? "Previously rejected.",
      });
    });

  // When deferred projection slips, supervise bootstrap retries while idle instead of waiting
  // for unrelated future traffic to rediscover the dirty cursor.
  const scheduleDeferredProjectionCatchUp: (input: {
    readonly eventType: OrchestrationEvent["type"];
    readonly sequence: number;
  }) => Effect.Effect<void> = Effect.fn(function* (input) {
    const shouldStart = yield* Ref.modify(
      deferredProjectionCatchUpInFlight,
      (inFlight): readonly [boolean, boolean] => [!inFlight, true],
    );
    if (!shouldStart) {
      return;
    }

    yield* Effect.logWarning("scheduling deferred orchestration projection catch-up").pipe(
      Effect.annotateLogs({
        eventType: input.eventType,
        sequence: input.sequence,
      }),
    );
    const recoverUntilHealthy = Effect.gen(function* () {
      while (yield* Ref.get(deferredProjectionDirty)) {
        const outcome = yield* Effect.exit(
          deferredProjectionLock.withPermits(1)(
            maintenanceLock.withPermits(1)(
              projectionPipeline.bootstrap.pipe(
                Effect.andThen(eventStore.getHighWaterSequence()),
                Effect.tap((sequence) =>
                  Effect.sync(() => {
                    deferredProjectionCoveredSequence = sequence;
                  }),
                ),
                Effect.andThen(Ref.set(deferredProjectionDirty, false)),
                Effect.andThen(Ref.set(deferredProjectionRetryAttempts, 0)),
                Effect.andThen(Ref.set(deferredProjectionLastFailure, null)),
              ),
            ),
          ),
        );
        if (outcome._tag === "Success") {
          yield* Effect.log("deferred orchestration projection catch-up completed").pipe(
            Effect.annotateLogs({
              eventType: input.eventType,
              sequence: input.sequence,
            }),
          );
          return;
        }

        const retryAttempts = yield* Ref.updateAndGet(
          deferredProjectionRetryAttempts,
          (attempts) => attempts + 1,
        );
        const failure = Cause.pretty(outcome.cause);
        yield* Ref.set(deferredProjectionLastFailure, failure);
        const retryDelayMs =
          DEFERRED_PROJECTION_RETRY_DELAYS_MS[
            Math.min(retryAttempts - 1, DEFERRED_PROJECTION_RETRY_DELAYS_MS.length - 1)
          ] ?? 30_000;
        yield* Effect.logWarning(
          "deferred orchestration projection catch-up failed; retrying",
        ).pipe(
          Effect.annotateLogs({
            eventType: input.eventType,
            sequence: input.sequence,
            retryAttempts,
            retryDelayMs,
            cause: failure,
          }),
        );
        yield* Effect.sleep(`${retryDelayMs} millis`);
      }
    }).pipe(
      Effect.ensuring(Ref.set(deferredProjectionCatchUpInFlight, false)),
      // A dirty notification can arrive while the previous supervisor is
      // completing. Recheck after surrendering its claim; interruption skips
      // this tail so scope closure cannot launch another recovery fiber.
      Effect.andThen(Ref.get(deferredProjectionDirty)),
      Effect.flatMap((dirty) => (dirty ? scheduleDeferredProjectionCatchUp(input) : Effect.void)),
    );

    yield* recoverUntilHealthy.pipe(Effect.forkIn(deferredProjectionScope), Effect.asVoid);
  });

  const deferredProjectionWorker = yield* makeDrainableWorker(
    (event: OrchestrationEvent) =>
      deferredProjectionLock.withPermits(1)(
        Effect.gen(function* () {
          if (event.sequence <= deferredProjectionCoveredSequence) return;
          if (yield* Ref.get(deferredProjectionDirty)) {
            yield* scheduleDeferredProjectionCatchUp({
              eventType: event.type,
              sequence: event.sequence,
            });
            return;
          }
          const outcome = yield* Effect.exit(
            Effect.suspend(() => projectionPipeline.projectDeferredEvent(event)),
          );
          if (outcome._tag === "Success") {
            deferredProjectionCoveredSequence = event.sequence;
            return;
          }
          yield* Ref.set(deferredProjectionDirty, true);
          yield* Effect.logWarning("deferred orchestration projector failed", {
            sequence: event.sequence,
            eventType: event.type,
            cause: Cause.pretty(outcome.cause),
          });
          yield* scheduleDeferredProjectionCatchUp({
            eventType: event.type,
            sequence: event.sequence,
          });
        }),
      ),
    { capacity: ORCHESTRATION_COMMAND_QUEUE_CAPACITY },
  );

  const enqueueDeferredProjection = (event: OrchestrationEvent) =>
    deferredProjectionWorker.tryEnqueue(event).pipe(
      Effect.catchTag("DrainableWorkerAdmissionError", () =>
        Ref.set(deferredProjectionDirty, true).pipe(
          Effect.andThen(
            scheduleDeferredProjectionCatchUp({
              eventType: event.type,
              sequence: event.sequence,
            }),
          ),
        ),
      ),
    );

  const getProjectionCatchUpStatus: OrchestrationEngineShape["getProjectionCatchUpStatus"] =
    Effect.gen(function* () {
      const [dirty, inFlight, retryAttempts, lastFailure] = yield* Effect.all([
        Ref.get(deferredProjectionDirty),
        Ref.get(deferredProjectionCatchUpInFlight),
        Ref.get(deferredProjectionRetryAttempts),
        Ref.get(deferredProjectionLastFailure),
      ]);
      // Lag is measured directly from the cursor table so a projector that
      // stalled without tripping the deferred dirty flag (or whose cursor row
      // was deleted by an interrupted repair) is still visible here. Only the
      // snapshot-fence cursors are lag-scored: the live path advances each
      // per-projector cursor only when its predicate matches (checkpoints
      // rejects every live event), so individual cursors legitimately trail
      // the journal between bootstraps and scoring them would report a healthy
      // system as permanently degraded. Missing rows follow that same fence
      // scope: predicate-specific cursors are legitimately absent until their
      // first matching event, while a missing required fence cursor makes the
      // snapshot sequence incomplete. A read
      // failure must not masquerade as health: the probe still answers (a
      // failing /health body is worse than a degraded one), but reports
      // state "unknown" so a database outage is distinguishable from both a
      // healthy system and a diagnosed lag.
      const lag = yield* Effect.gen(function* () {
        const highWaterSequence = yield* eventStore.getHighWaterSequence();
        const stateRows = yield* sql<{
          readonly projector: string;
          readonly lastAppliedSequence: number;
        }>`
          SELECT projector, last_applied_sequence AS "lastAppliedSequence"
          FROM projection_state
        `;
        const sequenceByProjector = new Map(
          stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
        );
        const lagByProjector: Record<string, number> = {};
        const missingProjectors: string[] = [];
        for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
          const sequence = sequenceByProjector.get(projector);
          if (sequence === undefined) {
            continue;
          }
          const projectorLag = highWaterSequence - sequence;
          if (projectorLag > 0) {
            lagByProjector[projector] = projectorLag;
          }
        }
        if (stateRows.length > 0) {
          for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
            if (!sequenceByProjector.has(projector)) {
              missingProjectors.push(projector);
            }
          }
        }
        return { probeFailed: false, highWaterSequence, lagByProjector, missingProjectors };
      }).pipe(
        Effect.catch(() =>
          Effect.succeed({
            probeFailed: true,
            highWaterSequence: 0,
            lagByProjector: {} as Record<string, number>,
            missingProjectors: [] as string[],
          }),
        ),
      );
      const degraded =
        dirty || lag.missingProjectors.length > 0 || Object.keys(lag.lagByProjector).length > 0;
      return {
        // A failed probe with the dirty flag set is still a known degradation;
        // "unknown" is reserved for a failed probe with no other evidence.
        state: degraded ? "degraded" : lag.probeFailed ? "unknown" : "healthy",
        inFlight,
        retryAttempts,
        lastFailure,
        highWaterSequence: lag.highWaterSequence,
        lagByProjector: lag.lagByProjector,
        missingProjectors: lag.missingProjectors,
      };
    });

  const refreshCommandReadModelFromProjectionState = Effect.gen(function* () {
    const nextCommandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();
    // The snapshot fence includes the deferred cursor. Its lag must not roll
    // back command state that is already durably committed and published.
    if (nextCommandReadModel.snapshotSequence < commandReadModel.snapshotSequence) {
      return commandReadModel;
    }
    commandReadModel = nextCommandReadModel;
    return nextCommandReadModel;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("failed to refresh orchestration command read model").pipe(
        Effect.annotateLogs({
          cause: Cause.pretty(cause),
        }),
        Effect.flatMap(() =>
          Effect.fail(
            new OrchestrationCommandInternalError({
              commandId: "repair-local-state",
              commandType: ORCHESTRATION_WS_METHODS.repairState,
              detail:
                "Projection state changed, but the refreshed command snapshot could not be loaded.",
            }),
          ),
        ),
      ),
    ),
  );

  const overlayThread = (
    model: OrchestrationReadModel,
    thread: OrchestrationReadModel["threads"][number],
  ): OrchestrationReadModel => {
    const existingThread = model.threads.find((entry) => entry.id === thread.id);
    // The command cache may contain only deltas received since a restart.
    // Durable detail includes the complete text, now including pending chunks.
    // Overlaying that detail with a partial cache would truncate completion.
    const hasThread = existingThread !== undefined;
    return {
      ...model,
      threads: hasThread
        ? model.threads.map((entry) => (entry.id === thread.id ? thread : entry))
        : [...model.threads, thread],
    };
  };

  const loadThreadDetailForDecider = (
    command: OrchestrationCommand,
    model: OrchestrationReadModel,
    threadId: ThreadId,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationDispatchError> =>
    projectionSnapshotQuery.getThreadDetailById(threadId).pipe(
      Effect.map((threadOption) =>
        Option.match(threadOption, {
          onNone: () => model,
          onSome: (thread) => overlayThread(model, thread),
        }),
      ),
      Effect.mapError(
        (error) =>
          new OrchestrationCommandInternalError({
            commandId: command.commandId,
            commandType: command.type,
            detail: `Failed to load thread detail for command validation: ${error.message}`,
          }),
      ),
    );

  const buildDeciderReadModel = (
    command: OrchestrationCommand,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationDispatchError> => {
    switch (command.type) {
      case "thread.handoff.create":
      case "thread.fork.create":
        return loadThreadDetailForDecider(command, commandReadModel, command.sourceThreadId);
      case "thread.claude-cache.set":
        return command.hold
          ? loadThreadDetailForDecider(command, commandReadModel, command.threadId)
          : Effect.succeed(commandReadModel);
      case "thread.turn.start":
        if (command.asyncUserInputResponse) {
          return messageRepository
            .getByThreadAndMessageId({
              threadId: command.threadId,
              messageId: command.asyncUserInputResponse.messageId,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new OrchestrationCommandInternalError({
                    commandId: command.commandId,
                    commandType: command.type,
                    detail: `Failed to load the asynchronous question: ${error.message}`,
                  }),
              ),
              Effect.map((message) => {
                const thread = commandReadModel.threads.find(
                  (entry) => entry.id === command.threadId,
                );
                if (!thread || Option.isNone(message)) return commandReadModel;
                return overlayThread(commandReadModel, {
                  ...thread,
                  messages: [
                    ...thread.messages.filter((entry) => entry.id !== message.value.messageId),
                    orchestrationMessageFromStoredMessage(message.value),
                  ],
                });
              }),
            );
        }
        return command.sourceProposedPlan
          ? loadThreadDetailForDecider(
              command,
              commandReadModel,
              command.sourceProposedPlan.threadId,
            )
          : Effect.succeed(commandReadModel);
      case "thread.conversation.rollback":
      case "thread.message.edit-and-resend":
      case "thread.approval.respond":
      case "thread.user-input.respond":
      case "thread.sidechat.expire":
        return loadThreadDetailForDecider(command, commandReadModel, command.threadId);
      case "thread.message.assistant.complete":
        // Read the exact message, including a resumed message older than the
        // transcript window. This avoids loading a whole thread to finalize it.
        return messageRepository
          .getByThreadAndMessageId({ threadId: command.threadId, messageId: command.messageId })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestrationCommandInternalError({
                  commandId: command.commandId,
                  commandType: command.type,
                  detail: `Failed to load the complete assistant message: ${error.message}`,
                }),
            ),
            Effect.flatMap((message) => {
              const model = commandReadModel.threads.some((entry) => entry.id === command.threadId)
                ? Effect.succeed(commandReadModel)
                : loadThreadDetailForDecider(command, commandReadModel, command.threadId);
              return model.pipe(
                Effect.map((readModel) => {
                  const thread = readModel.threads.find((entry) => entry.id === command.threadId);
                  // A missing projection row must not discard text still in cache.
                  // SQL failures stay errors; a present row remains authoritative.
                  if (!thread || Option.isNone(message)) return readModel;
                  return overlayThread(readModel, {
                    ...thread,
                    messages: [orchestrationMessageFromStoredMessage(message.value)],
                  });
                }),
              );
            }),
          );
      default:
        return Effect.succeed(commandReadModel);
    }
  };

  // Rebuild only the project/space projection rows and snapshot cursors.
  // Existing thread/chat projection rows stay in place so older installs do not
  // lose history that is no longer fully represented in orchestration_events.
  const resetDerivedProjectionState = sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM projection_spaces`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`
        DELETE FROM projection_state
        WHERE projector IN ${sql.in(PROJECT_METADATA_SNAPSHOT_PROJECTORS)}
      `;
    }),
  );

  const backupDerivedProjectionState = sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DROP TABLE IF EXISTS temp_repair_projection_spaces`;
      yield* sql`DROP TABLE IF EXISTS temp_repair_projection_projects`;
      yield* sql`DROP TABLE IF EXISTS temp_repair_projection_state`;
      yield* sql`CREATE TEMP TABLE temp_repair_projection_spaces AS SELECT * FROM projection_spaces`;
      yield* sql`CREATE TEMP TABLE temp_repair_projection_projects AS SELECT * FROM projection_projects`;
      yield* sql`CREATE TEMP TABLE temp_repair_projection_state AS SELECT * FROM projection_state`;
    }),
  );

  const restoreDerivedProjectionState = sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM projection_spaces`;
      yield* sql`INSERT INTO projection_spaces SELECT * FROM temp_repair_projection_spaces`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`INSERT INTO projection_projects SELECT * FROM temp_repair_projection_projects`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`INSERT INTO projection_state SELECT * FROM temp_repair_projection_state`;
    }),
  );

  const dropProjectionRepairBackup = sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DROP TABLE IF EXISTS temp_repair_projection_spaces`;
      yield* sql`DROP TABLE IF EXISTS temp_repair_projection_projects`;
      yield* sql`DROP TABLE IF EXISTS temp_repair_projection_state`;
    }),
  );

  const verifyProjectionRepairFence = (repairFence: number) =>
    Effect.gen(function* () {
      if (repairFence === 0) {
        return;
      }
      const rows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector IN ${sql.in(REQUIRED_REPAIR_PROJECTORS)}
      `;
      const cursorByProjector = new Map(
        rows.map((row) => [row.projector, row.lastAppliedSequence] as const),
      );
      const laggingProjectors = REQUIRED_REPAIR_PROJECTORS.filter(
        (projector) => (cursorByProjector.get(projector) ?? -1) < repairFence,
      );
      if (laggingProjectors.length > 0) {
        return yield* new OrchestrationCommandInternalError({
          commandId: "repair-local-state",
          commandType: ORCHESTRATION_WS_METHODS.repairState,
          detail:
            `Rebuilt local projections did not reach captured event fence ${repairFence}. ` +
            `Lagging projectors: ${laggingProjectors.join(", ")}.`,
        });
      }
    }).pipe(
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(
          new OrchestrationCommandInternalError({
            commandId: "repair-local-state",
            commandType: ORCHESTRATION_WS_METHODS.repairState,
            detail: `Failed to verify the rebuilt projection fence: ${sqlError.message}`,
          }),
        ),
      ),
    );

  // Callers must build this effect inside a fiber (see `runEnvelope`): the body
  // runs synchronously, so anything it throws is only contained when it is raised
  // while an effect is being evaluated.
  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void, never> => {
    const remainingBudgetMs = Math.max(0, envelope.deadlineAtMs - Date.now());
    const commandFingerprint = fingerprintOrchestrationCommand(envelope.command);
    // A materialized goal file is a candidate until its command commits: the
    // write happens before invariants run, so a rejection must drop it instead
    // of leaving up to the payload bound on disk. `goalFileCommitted` flips only
    // after the commit transaction resolves — a timed-out command that turns out
    // to have committed (accepted receipt) keeps its file.
    let materializedGoalFilePath: string | undefined;
    let materializedGoalFileWrite: Promise<string> | undefined;
    let goalFileCommitted = false;
    const discardUncommittedGoalFile = Effect.gen(function* () {
      if (goalFileCommitted) {
        return;
      }
      // An interrupt can land while the write is still in flight — the yield
      // assignment in the command body then never runs, and unlinking first
      // would race the write. Await it so the cleanup sees the settled path.
      const pendingWrite = materializedGoalFileWrite;
      if (pendingWrite !== undefined) {
        const settledPath = yield* Effect.promise(() =>
          pendingWrite.then(
            (path) => path,
            () => undefined,
          ),
        );
        materializedGoalFilePath ??= settledPath;
        materializedGoalFileWrite = undefined;
      }
      const filePath = materializedGoalFilePath;
      materializedGoalFilePath = undefined;
      if (filePath === undefined) {
        return;
      }
      // The flag alone cannot prove non-commit: an interrupt delivered inside
      // the commit transaction can land the write without the flag statement
      // ever running. The accepted receipt is the source of truth — a command
      // with one owns its file; only a command with none loses the candidate.
      const receiptExit = yield* Effect.exit(
        commandReceiptRepository.getByCommandId({ commandId: envelope.command.commandId }),
      );
      // A failed lookup cannot establish non-commit. Leave the candidate for
      // a later authoritative prune rather than deleting an accepted objective.
      if (receiptExit._tag === "Failure") return;
      const receipt = receiptExit.value;
      if (Option.isSome(receipt) && receipt.value.status === "accepted") {
        return;
      }
      yield* Effect.promise(() => discardMaterializedThreadGoalFile(filePath));
    });
    const reconcileCommandReadModelUnderLock = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(commandReadModel.snapshotSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      let nextCommandReadModel = commandReadModel;
      for (const persistedEvent of persistedEvents) {
        nextCommandReadModel = yield* projectEvent(nextCommandReadModel, persistedEvent);
      }
      commandReadModel = nextCommandReadModel;

      for (const persistedEvent of persistedEvents) {
        yield* publishCommittedEvent(persistedEvent);
      }
      yield* Ref.set(deferredProjectionDirty, true);
      const lastEvent = persistedEvents.at(-1)!;
      yield* scheduleDeferredProjectionCatchUp({
        eventType: lastEvent.type,
        sequence: lastEvent.sequence,
      });
    });
    const reconcileCommandReadModelAfterDispatchFailure = maintenanceLock.withPermits(1)(
      reconcileCommandReadModelUnderLock,
    );

    const runCommand = Effect.gen(function* () {
      const shouldSkip = yield* Ref.modify(envelope.executionState, (state) => {
        if (state === "abandoned") {
          return [true, state] as const;
        }
        return [false, "in-flight"] as const;
      });
      if (shouldSkip) {
        return;
      }

      if (remainingBudgetMs === 0) {
        return yield* makeCommandTimeoutError(envelope.command);
      }

      const existingReceipt = yield* commandReceiptRepository.getByCommandId({
        commandId: envelope.command.commandId,
      });
      if (Option.isSome(existingReceipt)) {
        const identityResult = yield* Effect.result(
          validateCommandReceiptIdentity(existingReceipt.value, commandFingerprint),
        );
        if (identityResult._tag === "Failure") {
          yield* Deferred.fail(envelope.result, identityResult.failure);
          return;
        }
        if (existingReceipt.value.status === "accepted") {
          // Settlement reads a fingerprint-bound receipt and cannot reclaim or
          // deliver attachments. Its verdict must survive reconnect ownership changes.
          if (!envelope.settleOnly) {
            yield* validateAcceptedAttachmentRetry(envelope.command, envelope.attachmentPrincipal);
          }
          yield* Deferred.succeed(envelope.result, {
            sequence: existingReceipt.value.resultSequence,
          });
          return;
        }
        yield* Deferred.fail(
          envelope.result,
          new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          }),
        );
        return;
      }

      if (envelope.settleOnly) {
        const detail =
          "The connection was interrupted before this message was accepted. Please send it again.";
        const aggregateRef = commandToAggregateRef(envelope.command);
        // This runs under the same commit lock as normal dispatch. The
        // receipt fences a delayed original RPC, including one still outside
        // the engine in startup/normalization when settlement arrived.
        const inserted = yield* maintenanceLock.withPermits(1)(
          commandReceiptRepository.insert({
            commandId: envelope.command.commandId,
            aggregateKind: aggregateRef.aggregateKind,
            aggregateId: aggregateRef.aggregateId,
            acceptedAt: new Date().toISOString(),
            resultSequence: commandReadModel.snapshotSequence,
            status: "rejected",
            error: detail,
            fingerprintVersion: commandFingerprint.version,
            commandFingerprint: commandFingerprint.value,
          }),
        );
        if (!inserted) {
          return yield* makeCommandInternalError(
            envelope.command,
            "Failed to settle the original message.",
          );
        }
        yield* Deferred.fail(
          envelope.result,
          new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail,
          }),
        );
        return;
      }

      let command: OrchestrationCommand = envelope.command;
      if (command.type === "thread.turn.start") {
        const pendingImport = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM project_import_origins
          WHERE thread_id = ${command.threadId} AND status = 'pending'
          LIMIT 1
        `.pipe(Effect.mapError(toPersistenceSqlError("OrchestrationEngine.pendingProjectImport")));
        if (pendingImport.length > 0) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail:
              "This conversation is still being imported. Finish or retry its import before sending a message.",
          });
        }
        const startCommand = command;
        const attachments = yield* Effect.forEach(
          startCommand.message.attachments,
          (attachment) => {
            if (attachment.type === "assistant-selection") {
              return Effect.succeed<ChatAttachment>(attachment);
            }
            return managedAttachments
              .findServerOwned({
                attachmentId: attachment.id,
                ownerThreadId: startCommand.threadId,
                ownerKind: envelope.attachmentPrincipal.ownerKind,
                ownerId: envelope.attachmentPrincipal.ownerId,
                now: new Date().toISOString(),
              })
              .pipe(
                Effect.flatMap((found) =>
                  Option.match(found, {
                    onNone: () =>
                      Effect.fail(
                        new OrchestrationCommandInvariantError({
                          commandType: startCommand.type,
                          detail: `Managed attachment ${attachment.id} is unavailable, expired, or owned by another session/thread.`,
                        }),
                      ),
                    onSome: (blob) => {
                      if (blob.kind !== "image" && blob.kind !== "file") {
                        return Effect.fail(
                          new OrchestrationCommandInvariantError({
                            commandType: startCommand.type,
                            detail: `Managed attachment ${attachment.id} has unsupported kind '${blob.kind}'.`,
                          }),
                        );
                      }
                      return Effect.succeed<ChatAttachment>({
                        type: blob.kind,
                        id: blob.attachmentId,
                        name: blob.originalName,
                        mimeType: blob.mimeType,
                        sizeBytes: blob.sizeBytes!,
                      });
                    },
                  }),
                ),
              );
          },
          { concurrency: 1 },
        );
        command = {
          ...startCommand,
          message: { ...startCommand.message, attachments },
        };
      }

      if (command.type === "thread.meta.update" && isOversizedThreadGoal(command.goal)) {
        // A goal is re-injected into every provider turn — a huge inline goal
        // would bloat each prompt. Materialize it to a per-command file and
        // persist a resolvable "read this file" reference instead (same
        // contract Codex uses for oversized input). The per-command filename
        // keeps a rejected update from overwriting the file a live reference
        // still points at; the reference only commits if the command does.
        const goalCommand = command;
        const oversizedGoal = command.goal;
        // Keep the write promise reachable from cleanup: an interrupt during
        // the await must not unlink underneath a write that still lands.
        const goalFileWrite = materializeThreadGoalFile({
          stateDir: serverConfig.stateDir,
          threadId: goalCommand.threadId,
          commandId: goalCommand.commandId,
          goal: oversizedGoal,
        });
        materializedGoalFileWrite = goalFileWrite;
        const goalFilePath = yield* Effect.tryPromise({
          try: () => goalFileWrite,
          catch: () =>
            makeCommandInternalError(
              goalCommand,
              "Could not materialize the oversized thread goal to a file.",
            ),
        });
        materializedGoalFilePath = goalFilePath;
        command = { ...goalCommand, goal: threadGoalFileReference(goalFilePath) };
      }

      let resolvedGoal: string | null = null;
      if (command.type === "thread.meta.update" && command.goalAchieved === true) {
        const persistedGoal =
          commandReadModel.threads.find((entry) => entry.id === command.threadId)?.goal ?? "";
        const goalCommand = command;
        resolvedGoal = yield* Effect.promise(() =>
          readMaterializedThreadGoalText({
            stateDir: serverConfig.stateDir,
            threadId: goalCommand.threadId,
            goal: persistedGoal,
          }),
        );
      }

      const committedCommand = yield* maintenanceLock.withPermits(1)(
        Effect.gen(function* () {
          if (
            command.type === "thread.meta.update" &&
            command.expectedTitleSequence !== undefined
          ) {
            const currentTitleSequence = yield* eventStore
              .getThreadTitleHighWaterSequence(command.threadId)
              .pipe(
                Effect.mapError(() =>
                  makeCommandInternalError(
                    command,
                    "Could not verify the thread title revision before the conditional update.",
                  ),
                ),
              );
            if (currentTitleSequence !== command.expectedTitleSequence) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: `Thread '${command.threadId}' title changed before the conditional update.`,
              });
            }
          }

          if (command.type === "thread.claude-cache.set" && command.hold) {
            // Admission runs in the command worker, so a stop cannot slip between
            // this durable fence and the atomic review/session events below.
            const cancellation = yield* Stream.runHead(
              eventStore.readThreadEventsFromSequence(
                command.threadId,
                command.hold.sourceEventSequence,
                1,
                commandReadModel.snapshotSequence,
                [
                  "thread.session-stop-requested",
                  "thread.archived",
                  "thread.deleted",
                  "thread.sidechat-expired",
                  "thread.conversation-rolled-back",
                ],
              ),
            ).pipe(
              Effect.mapError(() =>
                makeCommandInternalError(
                  command,
                  "Could not verify Claude cache hold authorization.",
                ),
              ),
            );
            if (Option.isSome(cancellation)) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "Command produced no events.",
              });
            }
          }

          let deciderReadModel = yield* buildDeciderReadModel(command);
          if (resolvedGoal !== null && command.type === "thread.meta.update") {
            const currentThread = deciderReadModel.threads.find(
              (entry) => entry.id === command.threadId,
            );
            if (currentThread !== undefined)
              deciderReadModel = overlayThread(deciderReadModel, {
                ...currentThread,
                goal: resolvedGoal,
              });
          }
          const eventBase = yield* decideOrchestrationCommand({
            command,
            readModel: deciderReadModel,
            workspacePaths: deciderWorkspacePaths,
          });
          const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
          const transactionalCommitEffect: Effect.Effect<
            CommittedCommandResult,
            OrchestrationDispatchError,
            never
          > = Effect.gen(function* () {
            if (command.type === "thread.sidechat.expire") {
              // The timer may have fired before a live settings update while this
              // command waited in the queue. Validate at the persistence owner, since
              // interrupting the caller cannot withdraw an already-admitted envelope.
              // Standalone compatibility layers retain their original one-hour default.
              const expiryMs = Option.isSome(serverSettings)
                ? sidechatExpiryMs(
                    (yield* serverSettings.value.getSettings.pipe(
                      Effect.mapError(() =>
                        makeCommandInternalError(
                          command,
                          "Could not verify the side chat expiry setting.",
                        ),
                      ),
                    )).sidechatExpiry,
                  )
                : SIDECHAT_INACTIVITY_EXPIRY_MS;
              if (
                expiryMs === null ||
                Date.now() < Date.parse(command.expectedLastActivityAt) + expiryMs
              ) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "Side chat is not due under the current expiry setting.",
                });
              }
            }
            const committedEvents: OrchestrationEvent[] = [];
            const deferredSettledSequences = new Set<number>();
            let nextCommandReadModel = commandReadModel;

            if (command.type === "thread.turn.start") {
              const attachmentIds = command.message.attachments
                .filter((attachment) => attachment.type === "image" || attachment.type === "file")
                .map((attachment) => attachment.id);
              const claim = yield* managedAttachments.claimForAcceptedTurn({
                attachmentIds,
                ownerThreadId: command.threadId,
                ownerKind: envelope.attachmentPrincipal.ownerKind,
                ownerId: envelope.attachmentPrincipal.ownerId,
                commandId: command.commandId,
                messageId: command.message.messageId,
                now: new Date().toISOString(),
              });
              if (claim.status !== "claimed") {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: `Managed attachment claim was rejected: ${claim.reason}.`,
                });
              }
            }

            // A checkpoint request must observe a durable cut of native events,
            // not the timing of two independent live subscriptions. The SQLite
            // transaction owns both this fence and the command receipt.
            const needsCheckpointFence = eventBases.some(
              (event) =>
                event.type === "thread.turn-start-requested" ||
                event.type === "thread.message-sent" ||
                event.type === "thread.checkpoint-revert-requested" ||
                event.type === "thread.turn-diff-completed",
            );
            const checkpointRuntimeSequence = needsCheckpointFence
              ? ((yield* sql<{ readonly sequence: number }>`
                  SELECT COALESCE(MAX(sequence), 0) AS sequence FROM provider_runtime_events
                `)[0]?.sequence ?? 0)
              : undefined;
            for (const nextEvent of eventBases) {
              const savedEvent = yield* eventStore.append(
                checkpointRuntimeSequence === undefined
                  ? nextEvent
                  : {
                      ...nextEvent,
                      metadata: { ...nextEvent.metadata, checkpointRuntimeSequence },
                    },
              );
              nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
              if (isShellMetadataEvent(savedEvent)) {
                yield* projectionPipeline.projectMetadataEvent(savedEvent);
              } else {
                const { deferredPhaseSettled } =
                  yield* projectionPipeline.projectHotEventInCurrentTransaction(savedEvent);
                if (deferredPhaseSettled) deferredSettledSequences.add(savedEvent.sequence);
              }
              committedEvents.push(savedEvent);
            }

            const lastSavedEvent = committedEvents.at(-1) ?? null;
            if (lastSavedEvent === null) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: envelope.command.type,
                detail: "Command produced no events.",
              });
            }

            const receiptInserted = yield* commandReceiptRepository.insert({
              commandId: envelope.command.commandId,
              aggregateKind: lastSavedEvent.aggregateKind,
              aggregateId: lastSavedEvent.aggregateId,
              acceptedAt: lastSavedEvent.occurredAt,
              resultSequence: lastSavedEvent.sequence,
              status: "accepted",
              error: null,
              fingerprintVersion: commandFingerprint.version,
              commandFingerprint: commandFingerprint.value,
            });
            if (!receiptInserted) {
              return yield* new OrchestrationCommandIdentityCollisionError({
                commandId: envelope.command.commandId,
                detail: "A receipt with this command ID appeared while the command was committing.",
              });
            }

            return {
              committedEvents,
              deferredSettledSequences,
              lastSequence: lastSavedEvent.sequence,
              nextCommandReadModel,
            } as const;
          }).pipe(
            Effect.catchCause((cause): Effect.Effect<never, OrchestrationDispatchError, never> => {
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.interrupt;
              }
              const typedFailure = Cause.findErrorOption(cause);
              if (
                Option.isSome(typedFailure) &&
                (typedFailure.value instanceof OrchestrationCommandInvariantError ||
                  typedFailure.value instanceof OrchestrationCommandIdentityCollisionError)
              ) {
                return Effect.fail(typedFailure.value);
              }
              return Effect.logError(
                "orchestration command crashed inside persistence transaction",
              ).pipe(
                Effect.annotateLogs({
                  commandId: envelope.command.commandId,
                  commandType: envelope.command.type,
                  cause: Cause.pretty(cause),
                }),
                Effect.flatMap(() =>
                  Effect.fail(
                    makeCommandInternalError(
                      envelope.command,
                      "The command hit an unexpected internal error before it could be saved.",
                    ),
                  ),
                ),
              );
            }),
          );

          const committed = yield* sql
            .withTransaction(transactionalCommitEffect)
            .pipe(
              Effect.catchTag("SqlError", (sqlError) =>
                Effect.fail(
                  toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(
                    sqlError,
                  ),
                ),
              ),
            );
          commandReadModel = committed.nextCommandReadModel;
          for (const event of committed.committedEvents) {
            yield* publishCommittedEvent(event);
            if (!committed.deferredSettledSequences.has(event.sequence))
              yield* enqueueDeferredProjection(event);
          }
          return committed;
        }).pipe(
          Effect.onExit((exit) =>
            exit._tag === "Failure"
              ? reconcileCommandReadModelUnderLock.pipe(Effect.catchCause(() => Effect.void))
              : Effect.void,
          ),
        ),
      );

      // Commit is durable: the candidate file is now owned by the accepted
      // update and governed by the post-commit prune, not the failure cleanup.
      goalFileCommitted = true;

      // Goal-file housekeeping only runs once the command committed: the
      // accepted update decides which files still matter — a fresh oversized
      // goal keeps only its own file, a goal moved back inline / marked
      // achieved or a deleted thread drops the directory (also sweeping files
      // orphaned by rejected materializations). Rejected commands never reach
      // here, so a failure can't delete a file a live reference still uses.
      const goalFilesDropThreadId =
        command.type === "thread.delete"
          ? command.threadId
          : command.type === "thread.meta.update" &&
              (command.goal !== undefined || command.goalAchieved === true)
            ? command.threadId
            : null;
      if (goalFilesDropThreadId !== null) {
        yield* Effect.tryPromise({
          try: () =>
            pruneThreadGoalFiles({
              stateDir: serverConfig.stateDir,
              threadId: goalFilesDropThreadId,
              // Retain the committed goal's reference, including an unchanged
              // reference saved by Edit goal; achievement/inline goals have none.
              keepFileName:
                threadGoalFileNameFromReference({
                  stateDir: serverConfig.stateDir,
                  threadId: goalFilesDropThreadId,
                  goal:
                    committedCommand.nextCommandReadModel.threads.find(
                      (thread) => thread.id === goalFilesDropThreadId,
                    )?.goal ?? "",
                }) ?? undefined,
            }),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Thread goal file cleanup failed.", {
              threadId: goalFilesDropThreadId,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      }

      yield* Deferred.succeed(envelope.result, { sequence: committedCommand.lastSequence });
    }).pipe(
      // Interrupts never surface as a typed failure, so they need their own
      // cleanup hook. This finalizer is scoped to the gen, so it runs both when
      // the timeout race interrupts it and on an external worker interrupt —
      // after inner transaction finalizers, so the receipt read is definitive:
      // an accepted receipt means the commit landed and owns the file.
      Effect.onInterrupt(() => discardUncommittedGoalFile),
      Effect.timeoutOption(remainingBudgetMs),
      Effect.flatMap((outcome) =>
        Option.match(outcome, {
          onNone: () => Effect.fail(makeCommandTimeoutError(envelope.command)),
          onSome: Effect.succeed,
        }),
      ),
      Effect.catch((error: OrchestrationDispatchError) =>
        Effect.gen(function* () {
          yield* reconcileCommandReadModelAfterDispatchFailure.pipe(
            Effect.catch(() =>
              Effect.logWarning(
                "failed to reconcile orchestration read model after dispatch failure",
              ).pipe(
                Effect.annotateLogs({
                  commandId: envelope.command.commandId,
                  snapshotSequence: commandReadModel.snapshotSequence,
                }),
              ),
            ),
          );

          if (Schema.is(OrchestrationCommandTimeoutError)(error)) {
            const resolvedTimeoutOutcome = yield* resolveStoredCommandOutcome(
              envelope.command,
              envelope.attachmentPrincipal,
              envelope.settleOnly,
            ).pipe(
              Effect.match({
                onFailure: (resolvedError) => ({ _tag: "Left" as const, left: resolvedError }),
                onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
              }),
            );
            if (resolvedTimeoutOutcome._tag === "Right") {
              yield* Deferred.succeed(envelope.result, resolvedTimeoutOutcome.right);
              return;
            }
            error = resolvedTimeoutOutcome.left;
          }

          if (Schema.is(OrchestrationCommandInvariantError)(error)) {
            const aggregateRef = commandToAggregateRef(envelope.command);
            yield* maintenanceLock.withPermits(1)(
              commandReceiptRepository
                .insert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: new Date().toISOString(),
                  resultSequence: commandReadModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                  fingerprintVersion: commandFingerprint.version,
                  commandFingerprint: commandFingerprint.value,
                })
                .pipe(Effect.catch(() => Effect.void)),
            );
          }
          yield* discardUncommittedGoalFile;
          yield* Deferred.fail(envelope.result, error);
        }),
      ),
      Effect.catchCause((cause): Effect.Effect<void, never, never> => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.gen(function* () {
          yield* reconcileCommandReadModelAfterDispatchFailure.pipe(
            Effect.catch(() =>
              Effect.logWarning(
                "failed to reconcile orchestration read model after unexpected worker failure",
              ).pipe(
                Effect.annotateLogs({
                  commandId: envelope.command.commandId,
                  snapshotSequence: commandReadModel.snapshotSequence,
                }),
              ),
            ),
          );

          yield* Effect.logError("orchestration worker crashed while processing command").pipe(
            Effect.annotateLogs({
              commandId: envelope.command.commandId,
              commandType: envelope.command.type,
              cause: Cause.pretty(cause),
            }),
          );

          const resolvedCrashOutcome = yield* resolveStoredCommandOutcome(
            envelope.command,
            envelope.attachmentPrincipal,
            envelope.settleOnly,
          ).pipe(
            Effect.match({
              onFailure: (resolvedError) => ({ _tag: "Left" as const, left: resolvedError }),
              onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
            }),
          );

          if (resolvedCrashOutcome._tag === "Right") {
            yield* Deferred.succeed(envelope.result, resolvedCrashOutcome.right);
            return;
          }

          const resolvedError = resolvedCrashOutcome.left;
          yield* discardUncommittedGoalFile;
          yield* Deferred.fail(
            envelope.result,
            Schema.is(OrchestrationCommandTimeoutError)(resolvedError)
              ? makeCommandInternalError(envelope.command)
              : resolvedError,
          );
        });
      }),
    );

    return runCommand;
  };

  yield* projectionPipeline.bootstrap;

  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();
  lastPublishedSequence = yield* eventStore.getHighWaterSequence();
  deferredProjectionCoveredSequence = lastPublishedSequence;

  const finishEnvelope = Ref.modify(engineAdmissionState, (current) => {
    const outstanding = Math.max(0, current.outstanding - 1);
    return [
      outstanding === 0 ? current.idle : null,
      {
        ...current,
        outstanding,
      },
    ] as const;
  }).pipe(
    Effect.flatMap((idle) =>
      idle === null ? Effect.void : Deferred.succeed(idle, undefined).pipe(Effect.orDie),
    ),
  );

  /**
   * Runs one envelope with the worker's structural safety net.
   *
   * `processEnvelope` builds its effect synchronously, so a throw raised while
   * building it (schema/normalization helpers, read-model access, anything added
   * to that body later) would otherwise propagate into the worker's `flatMap`
   * before `Effect.ensuring` is attached: the envelope would never be finished
   * (`outstanding` leaks, `drain` hangs, the caller waits out the dispatch
   * timeout) and the defect would kill the worker fiber, wedging every later
   * command. Building it inside `Effect.suspend` turns that into a defect of this
   * effect, which is contained per envelope so one poisoned command fails alone.
   */
  const runEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> =>
    Effect.suspend(() => processEnvelope(envelope)).pipe(
      Effect.catchCause((cause): Effect.Effect<void> => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logError("orchestration worker defect while processing command").pipe(
          Effect.annotateLogs({
            commandId: envelope.command.commandId,
            commandType: envelope.command.type,
            cause: Cause.pretty(cause),
          }),
          Effect.andThen(
            Deferred.fail(envelope.result, makeCommandInternalError(envelope.command)),
          ),
          Effect.asVoid,
        );
      }),
      // Last resort: even a defect raised by the handler above (a throwing getter
      // on the command, say) must not escape into the worker loop.
      Effect.catchCause(
        (cause): Effect.Effect<void> =>
          Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.void,
      ),
      Effect.ensuring(finishEnvelope),
    );

  const worker = yield* makeKeyedDrainableWorker(runEnvelope, {
    key: (envelope) => {
      const aggregate = commandToAggregateRef(envelope.command);
      return `${aggregate.aggregateKind}:${aggregate.aggregateId}`;
    },
    concurrency: 4,
    capacity: ORCHESTRATION_COMMAND_QUEUE_CAPACITY,
    priority: (envelope) =>
      envelope.settleOnly
        ? 0
        : { control: 0, user: 1, normal: 2 }[orchestrationCommandLane(envelope.command.type)],
  });

  const drain: OrchestrationEngineShape["drain"] = Effect.suspend(
    function awaitIdle(): Effect.Effect<void> {
      return Ref.get(engineAdmissionState).pipe(
        Effect.flatMap((current) => Deferred.await(current.idle)),
        Effect.andThen(Ref.get(engineAdmissionState)),
        Effect.flatMap((current) =>
          current.outstanding === 0 ? Effect.void : Effect.suspend(awaitIdle),
        ),
      );
    },
  ).pipe(Effect.andThen(deferredProjectionWorker.drain));

  const quiesce: OrchestrationEngineShape["quiesce"] = Ref.update(
    engineAdmissionState,
    (current): EngineAdmissionState =>
      current.phase === "running"
        ? {
            ...current,
            phase: "quiescing",
          }
        : current,
  );

  const stop: OrchestrationEngineShape["stop"] = Effect.uninterruptible(
    Ref.update(
      engineAdmissionState,
      (current): EngineAdmissionState =>
        current.phase === "stopped"
          ? current
          : {
              ...current,
              phase: "draining",
            },
    ).pipe(
      Effect.andThen(worker.stop),
      Effect.andThen(drain),
      Effect.andThen(deferredProjectionWorker.stop),
      Effect.andThen(
        Ref.update(
          engineAdmissionState,
          (current): EngineAdmissionState => ({
            ...current,
            phase: "stopped",
          }),
        ),
      ),
    ),
  );

  // Registered after the workers so LIFO finalization gracefully drains accepted
  // commands and deferred projections before interrupting the consumers. The event bus closes
  // only after the worker has finished every durable publication.
  yield* Effect.addFinalizer(() => stop.pipe(Effect.andThen(PubSub.shutdown(eventPubSub))));
  yield* Effect.log("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive) =>
    eventStore.readFromSequence(fromSequenceExclusive);
  const readEventsThrough: OrchestrationEngineShape["readEventsThrough"] = (
    fromSequenceExclusive,
    throughSequenceInclusive,
    limit = Number.MAX_SAFE_INTEGER,
  ) => eventStore.readFromSequence(fromSequenceExclusive, limit, throughSequenceInclusive);
  const readThreadEvents: OrchestrationEngineShape["readThreadEvents"] = (
    threadId,
    fromSequenceExclusive,
    eventTypes,
  ) =>
    eventStore.readThreadEventsFromSequence(
      threadId,
      fromSequenceExclusive,
      undefined,
      undefined,
      eventTypes,
    );
  const readThreadEventsThrough: OrchestrationEngineShape["readThreadEventsThrough"] = (
    threadId,
    fromSequenceExclusive,
    throughSequenceInclusive,
    eventTypes,
    limit = Number.MAX_SAFE_INTEGER,
  ) =>
    eventStore.readThreadEventsFromSequence(
      threadId,
      fromSequenceExclusive,
      limit,
      throughSequenceInclusive,
      eventTypes,
    );
  const getEventHighWaterSequence = eventStore.getHighWaterSequence();
  const getThreadTitleHighWaterSequence = (threadId: string) =>
    eventStore.getThreadTitleHighWaterSequence(threadId);
  const subscribeDomainEvents: OrchestrationEngineShape["subscribeDomainEvents"] =
    eventPublicationLock.withPermits(1)(
      Effect.gen(function* () {
        // Capture the cursor atomically with attachment, so a publication cannot
        // fall between the live subscription and its initial replay boundary.
        const subscription = yield* PubSub.subscribe(eventPubSub);
        let cursor = lastPublishedSequence;
        return Stream.fromEffectRepeat(PubSub.take(subscription)).pipe(
          Stream.flatMap((event) => {
            if (event.sequence <= cursor) return Stream.empty;
            const gap =
              event.sequence > cursor + 1
                ? eventStore
                    .readFromSequence(cursor, Number.MAX_SAFE_INTEGER, event.sequence - 1)
                    .pipe(Stream.orDie)
                : Stream.empty;
            return Stream.concat(gap, Stream.succeed(event)).pipe(
              Stream.tap((delivered) =>
                Effect.sync(() => {
                  cursor = delivered.sequence;
                }),
              ),
            );
          }),
        );
      }),
    );

  // Compatibility bridge for older tests and out-of-tree callers. Production
  // code should use ProjectionSnapshotQuery directly instead of depending on
  // the command engine to own a hydrated read model.
  const getReadModel = () => Effect.sync(() => commandReadModel);
  const refreshCommandReadModel: OrchestrationEngineShape["refreshCommandReadModel"] = () =>
    maintenanceLock.withPermits(1)(refreshCommandReadModelFromProjectionState);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command, context) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      const executionState = yield* Ref.make<CommandExecutionState>("queued");
      const envelope: CommandEnvelope = {
        command,
        settleOnly: context?.settleOnly === true,
        attachmentPrincipal: context?.attachmentPrincipal ?? LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
        result,
        executionState,
        deadlineAtMs: Date.now() + ORCHESTRATION_DISPATCH_TIMEOUT_MS,
      };
      const nextIdle = yield* Deferred.make<void>();
      const admission = yield* Effect.uninterruptible(
        Ref.modify(
          engineAdmissionState,
          (current): readonly [OrchestrationCommandAdmissionDecision, EngineAdmissionState] => {
            if (
              current.phase === "draining" ||
              current.phase === "stopped" ||
              (current.phase === "quiescing" &&
                !envelope.settleOnly &&
                !isQuiescingCommandAdmissible(command.type))
            ) {
              return [{ accepted: false, reason: "stopped" as const }, current] as const;
            }
            const lane = envelope.settleOnly ? "control" : orchestrationCommandLane(command.type);
            const limit =
              lane === "control"
                ? ORCHESTRATION_COMMAND_QUEUE_CAPACITY
                : ORCHESTRATION_COMMAND_QUEUE_CAPACITY - ORCHESTRATION_COMMAND_CONTROL_RESERVE;
            if (current.outstanding >= limit) {
              return [{ accepted: false, reason: "overloaded" }, current] as const;
            }
            const decision = { accepted: true } as const;
            return [
              decision,
              {
                ...current,
                outstanding: current.outstanding + 1,
                idle: current.outstanding === 0 ? nextIdle : current.idle,
              },
            ] as const;
          },
        ).pipe(
          Effect.flatMap((decision) =>
            decision.accepted
              ? worker.tryEnqueue(envelope).pipe(
                  Effect.as(decision),
                  Effect.catchTag("DrainableWorkerAdmissionError", (error) =>
                    finishEnvelope.pipe(
                      Effect.as({
                        accepted: false,
                        reason: error.reason === "overloaded" ? "overloaded" : "stopped",
                      } as const),
                    ),
                  ),
                )
              : Effect.succeed(decision),
          ),
        ),
      );
      if (!admission.accepted) {
        return yield* new OrchestrationCommandAdmissionError({
          commandId: command.commandId,
          commandType: command.type,
          capacity: ORCHESTRATION_COMMAND_QUEUE_CAPACITY,
          reservedCapacity: ORCHESTRATION_COMMAND_CONTROL_RESERVE,
          reason: admission.reason,
        });
      }
      return yield* Deferred.await(result).pipe(
        Effect.timeoutOption(`${ORCHESTRATION_DISPATCH_TIMEOUT_MS} millis`),
        Effect.flatMap((outcome) =>
          Option.match(outcome, {
            onNone: () =>
              Ref.modify(
                executionState,
                (state): readonly [DispatchTimeoutDecision, CommandExecutionState] =>
                  state === "queued"
                    ? [{ kind: "abandon" }, "abandoned"]
                    : [{ kind: "wait" }, state],
              ).pipe(
                Effect.flatMap((decision) =>
                  decision.kind === "wait"
                    ? Effect.logWarning(
                        "orchestration dispatch exceeded queue timeout while command was already in flight",
                      ).pipe(
                        Effect.annotateLogs({
                          commandId: command.commandId,
                          commandType: command.type,
                          timeoutMs: ORCHESTRATION_DISPATCH_TIMEOUT_MS,
                        }),
                        Effect.flatMap(() => Deferred.await(result)),
                      )
                    : Effect.logWarning(
                        "orchestration dispatch timed out before command started",
                      ).pipe(
                        Effect.annotateLogs({
                          commandId: command.commandId,
                          commandType: command.type,
                          timeoutMs: ORCHESTRATION_DISPATCH_TIMEOUT_MS,
                        }),
                        Effect.flatMap(() => Effect.fail(makeCommandTimeoutError(command))),
                      ),
                ),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
    });

  // Used by the settings screen to rebuild local indexes without deleting chats.
  // Also invoked by empty-route / desktop recovery paths — those can stampede.
  const runProjectionRepair: OrchestrationEngineShape["repairState"] = () =>
    deferredProjectionLock.withPermits(1)(
      maintenanceLock.withPermits(1)(
        Effect.gen(function* () {
          yield* Effect.log("repairing orchestration projection state");
          const previousCommandReadModel = commandReadModel;
          const repairFence = yield* eventStore.getHighWaterSequence().pipe(
            Effect.mapError(
              (error) =>
                new OrchestrationCommandInternalError({
                  commandId: "repair-local-state",
                  commandType: ORCHESTRATION_WS_METHODS.repairState,
                  detail: `Failed to capture the durable event fence before repair: ${error.message}`,
                }),
            ),
          );

          yield* backupDerivedProjectionState.pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.logError("failed to back up derived orchestration projection state").pipe(
                Effect.annotateLogs({
                  cause: Cause.pretty(Cause.fail(sqlError)),
                }),
                Effect.flatMap(() =>
                  Effect.fail(
                    new OrchestrationCommandInternalError({
                      commandId: "repair-local-state",
                      commandType: ORCHESTRATION_WS_METHODS.repairState,
                      detail: "Failed to stage the current local state before rebuilding it.",
                    }),
                  ),
                ),
              ),
            ),
          );

          yield* resetDerivedProjectionState.pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.logError("failed to reset derived orchestration projection state").pipe(
                Effect.annotateLogs({
                  cause: Cause.pretty(Cause.fail(sqlError)),
                }),
                Effect.tap(() =>
                  restoreDerivedProjectionState.pipe(
                    Effect.catchCause(() =>
                      Effect.logWarning(
                        "failed to restore orchestration projection backup after reset failure",
                      ),
                    ),
                  ),
                ),
                Effect.flatMap(() =>
                  Effect.fail(
                    new OrchestrationCommandInternalError({
                      commandId: "repair-local-state",
                      commandType: ORCHESTRATION_WS_METHODS.repairState,
                      detail: "Failed to clear the local projection cache before rebuilding it.",
                    }),
                  ),
                ),
              ),
            ),
          );

          const rebuildResult = yield* Effect.exit(
            projectionPipeline.bootstrap.pipe(
              Effect.flatMap(() => verifyProjectionRepairFence(repairFence)),
            ),
          );
          if (rebuildResult._tag === "Failure") {
            const restoreResult = yield* Effect.exit(restoreDerivedProjectionState);
            if (restoreResult._tag === "Failure") {
              commandReadModel = previousCommandReadModel;
              return yield* Effect.logError(
                "failed to restore orchestration projection backup after rebuild failure",
              ).pipe(
                Effect.annotateLogs({
                  rebuildCause: Cause.pretty(rebuildResult.cause),
                  restoreCause: Cause.pretty(restoreResult.cause),
                }),
                Effect.flatMap(() =>
                  Effect.fail(
                    new OrchestrationCommandInternalError({
                      commandId: "repair-local-state",
                      commandType: ORCHESTRATION_WS_METHODS.repairState,
                      detail:
                        "Projection repair failed and its staged backup could not be restored. Restart Synara before retrying repair.",
                    }),
                  ),
                ),
              );
            }

            commandReadModel = previousCommandReadModel;
            yield* dropProjectionRepairBackup.pipe(Effect.catchCause(() => Effect.void));
            const typedFailure = Cause.findErrorOption(rebuildResult.cause);
            const repairError = Option.filter(
              typedFailure,
              (error): error is OrchestrationCommandInternalError =>
                Schema.is(OrchestrationCommandInternalError)(error),
            );
            return yield* Effect.logError(
              "failed to rebuild orchestration projections from event log",
            ).pipe(
              Effect.annotateLogs({
                cause: Cause.pretty(rebuildResult.cause),
              }),
              Effect.flatMap(() =>
                Effect.fail(
                  Option.getOrElse(
                    repairError,
                    () =>
                      new OrchestrationCommandInternalError({
                        commandId: "repair-local-state",
                        commandType: ORCHESTRATION_WS_METHODS.repairState,
                        detail: "Failed to rebuild local projections from the saved event history.",
                      }),
                  ),
                ),
              ),
            );
          }

          const snapshot = yield* refreshCommandReadModelFromProjectionState;
          deferredProjectionCoveredSequence = repairFence;
          yield* dropProjectionRepairBackup.pipe(Effect.catchCause(() => Effect.void));
          return snapshot;
        }),
      ),
    );

  const repairState: OrchestrationEngineShape["repairState"] = () =>
    Effect.gen(function* () {
      const nowMs = Date.now();
      const lastSuccessMs = yield* Ref.get(lastSuccessfulProjectionRepairAtMs);
      if (lastSuccessMs > 0 && nowMs - lastSuccessMs < PROJECTION_REPAIR_COOLDOWN_MS) {
        yield* Effect.log(
          "skipping orchestration projection repair (recent successful rebuild)",
        ).pipe(
          Effect.annotateLogs({
            cooldownMs: PROJECTION_REPAIR_COOLDOWN_MS,
            ageMs: nowMs - lastSuccessMs,
          }),
        );
        return yield* maintenanceLock.withPermits(1)(refreshCommandReadModelFromProjectionState);
      }

      const joinDeferred = yield* Deferred.make<OrchestrationReadModel, ProjectionRepairError>();
      const claim = yield* Ref.modify(
        projectionRepairInFlight,
        (
          current,
        ): readonly [
          {
            readonly kind: "join" | "start";
            readonly deferred: Deferred.Deferred<OrchestrationReadModel, ProjectionRepairError>;
          },
          Deferred.Deferred<OrchestrationReadModel, ProjectionRepairError> | null,
        ] => {
          if (current !== null) {
            return [{ kind: "join", deferred: current }, current];
          }
          return [{ kind: "start", deferred: joinDeferred }, joinDeferred];
        },
      );

      if (claim.kind === "join") {
        yield* Effect.log("joining in-flight orchestration projection repair");
        return yield* Deferred.await(claim.deferred);
      }

      return yield* Effect.gen(function* () {
        const exit = yield* Effect.exit(runProjectionRepair());
        if (exit._tag === "Success") {
          yield* Ref.set(lastSuccessfulProjectionRepairAtMs, Date.now());
          yield* Deferred.succeed(claim.deferred, exit.value).pipe(Effect.orDie);
          return exit.value;
        }
        yield* Deferred.failCause(claim.deferred, exit.cause).pipe(Effect.orDie);
        return yield* Effect.failCause(exit.cause);
      }).pipe(Effect.ensuring(Ref.set(projectionRepairInFlight, null)));
    });

  return {
    quiesce,
    drain,
    stop,
    getProjectionCatchUpStatus,
    getReadModel,
    refreshCommandReadModel,
    readEvents,
    readEventsThrough,
    readThreadEvents,
    readThreadEventsThrough,
    getEventHighWaterSequence,
    getThreadTitleHighWaterSequence,
    subscribeDomainEvents,
    dispatch,
    repairState,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (Effect RPC, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.unwrap(subscribeDomainEvents);
    },
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
).pipe(
  Layer.provide(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ManagedAttachmentRepositoryLive),
);
