import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { OrchestrationCommand } from "@t3tools/contracts";
import { Cause, Deferred, Effect, Layer, Option, PubSub, Queue, Ref, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandInternalError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationCommandTimeoutError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import type { ProjectMetadataOrchestrationEvent } from "../projectMetadataProjection.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";

const ORCHESTRATION_DISPATCH_TIMEOUT_MS = 45_000;

type CommandExecutionState = "queued" | "in-flight" | "abandoned";
type DispatchTimeoutDecision = { kind: "abandon" } | { kind: "wait" };

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  executionState: Ref.Ref<CommandExecutionState>;
  deadlineAtMs: number;
}

type CommittedCommandResult = {
  readonly committedEvents: OrchestrationEvent[];
  readonly lastSequence: number;
  readonly nextReadModel: OrchestrationReadModel;
};

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
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

function isProjectMetadataEvent(
  event: OrchestrationEvent,
): event is ProjectMetadataOrchestrationEvent {
  return (
    event.type === "project.created" ||
    event.type === "project.meta-updated" ||
    event.type === "project.deleted"
  );
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;

  let readModel = createEmptyReadModel(new Date().toISOString());

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

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

  const resolveStoredCommandOutcome = (
    command: OrchestrationCommand,
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
      if (existingReceipt.value.status === "accepted") {
        return {
          sequence: existingReceipt.value.resultSequence,
        };
      }
      return yield* new OrchestrationCommandPreviouslyRejectedError({
        commandId: command.commandId,
        detail: existingReceipt.value.error ?? "Previously rejected.",
      });
    });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void, never> => {
    const dispatchStartSequence = readModel.snapshotSequence;
    const remainingBudgetMs = Math.max(0, envelope.deadlineAtMs - Date.now());
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      let nextReadModel = readModel;
      for (const persistedEvent of persistedEvents) {
        nextReadModel = yield* projectEvent(nextReadModel, persistedEvent);
      }
      readModel = nextReadModel;

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    return Effect.gen(function* () {
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
        if (existingReceipt.value.status === "accepted") {
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

      const eventBase = yield* decideOrchestrationCommand({
        command: envelope.command,
        readModel,
      });
      const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
      const transactionalCommitEffect: Effect.Effect<
        CommittedCommandResult,
        OrchestrationDispatchError,
        never
      > = Effect.gen(function* () {
        const committedEvents: OrchestrationEvent[] = [];
        let nextReadModel = readModel;

        for (const nextEvent of eventBases) {
          const savedEvent = yield* eventStore.append(nextEvent);
          nextReadModel = yield* projectEvent(nextReadModel, savedEvent);
          if (isProjectMetadataEvent(savedEvent)) {
            yield* projectionPipeline.projectMetadataEvent(savedEvent);
          } else {
            yield* projectionPipeline.projectEvent(savedEvent);
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

        yield* commandReceiptRepository.upsert({
          commandId: envelope.command.commandId,
          aggregateKind: lastSavedEvent.aggregateKind,
          aggregateId: lastSavedEvent.aggregateId,
          acceptedAt: lastSavedEvent.occurredAt,
          resultSequence: lastSavedEvent.sequence,
          status: "accepted",
          error: null,
        });

        return {
          committedEvents,
          lastSequence: lastSavedEvent.sequence,
          nextReadModel,
        } as const;
      }).pipe(
        Effect.catchCause((cause): Effect.Effect<never, OrchestrationDispatchError, never> => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
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

      const committedCommand = yield* sql
        .withTransaction(transactionalCommitEffect)
        .pipe(
          Effect.catchTag("SqlError", (sqlError) =>
            Effect.fail(
              toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
            ),
          ),
        );

      readModel = committedCommand.nextReadModel;
      for (const event of committedCommand.committedEvents) {
        yield* PubSub.publish(eventPubSub, event);
      }
      yield* Deferred.succeed(envelope.result, { sequence: committedCommand.lastSequence });
    }).pipe(
      Effect.timeoutOption(remainingBudgetMs),
      Effect.flatMap((outcome) =>
        Option.match(outcome, {
          onNone: () => Effect.fail(makeCommandTimeoutError(envelope.command)),
          onSome: Effect.succeed,
        }),
      ),
      Effect.catch((error: OrchestrationDispatchError) =>
        Effect.gen(function* () {
          yield* reconcileReadModelAfterDispatchFailure.pipe(
            Effect.catch(() =>
              Effect.logWarning(
                "failed to reconcile orchestration read model after dispatch failure",
              ).pipe(
                Effect.annotateLogs({
                  commandId: envelope.command.commandId,
                  snapshotSequence: readModel.snapshotSequence,
                }),
              ),
            ),
          );

          if (Schema.is(OrchestrationCommandTimeoutError)(error)) {
            const resolvedTimeoutOutcome = yield* resolveStoredCommandOutcome(
              envelope.command,
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
            yield* commandReceiptRepository
              .upsert({
                commandId: envelope.command.commandId,
                aggregateKind: aggregateRef.aggregateKind,
                aggregateId: aggregateRef.aggregateId,
                acceptedAt: new Date().toISOString(),
                resultSequence: readModel.snapshotSequence,
                status: "rejected",
                error: error.message,
              })
              .pipe(Effect.catch(() => Effect.void));
          }
          yield* Deferred.fail(envelope.result, error);
        }),
      ),
      Effect.catchCause((cause): Effect.Effect<void, never, never> => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.gen(function* () {
          yield* reconcileReadModelAfterDispatchFailure.pipe(
            Effect.catch(() =>
              Effect.logWarning(
                "failed to reconcile orchestration read model after unexpected worker failure",
              ).pipe(
                Effect.annotateLogs({
                  commandId: envelope.command.commandId,
                  snapshotSequence: readModel.snapshotSequence,
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

          const resolvedCrashOutcome = yield* resolveStoredCommandOutcome(envelope.command).pipe(
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
          yield* Deferred.fail(
            envelope.result,
            Schema.is(OrchestrationCommandTimeoutError)(resolvedError)
              ? makeCommandInternalError(envelope.command)
              : resolvedError,
          );
        });
      }),
    );
  };

  yield* projectionPipeline.bootstrap;

  // bootstrap in-memory read model from event store
  yield* Stream.runForEach(eventStore.readAll(), (event) =>
    Effect.gen(function* () {
      readModel = yield* projectEvent(readModel, event);
    }),
  );

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(worker);
  yield* Effect.log("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: readModel.snapshotSequence }),
  );

  const getReadModel: OrchestrationEngineShape["getReadModel"] = () =>
    Effect.sync((): OrchestrationReadModel => readModel);

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive) =>
    eventStore.readFromSequence(fromSequenceExclusive);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      const executionState = yield* Ref.make<CommandExecutionState>("queued");
      yield* Queue.offer(commandQueue, {
        command,
        result,
        executionState,
        deadlineAtMs: Date.now() + ORCHESTRATION_DISPATCH_TIMEOUT_MS,
      });
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

  return {
    getReadModel,
    readEvents,
    dispatch,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
