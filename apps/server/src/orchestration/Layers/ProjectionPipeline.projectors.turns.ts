// Purpose: The turn-lifecycle projector closure (thread.turns read model).
// Layer: dependency-parameterized projector closure; built via makeTurnProjectors(deps).
// Exports: makeTurnProjectors.

import { Effect, Option } from "effect";

import { type ProjectionTurn } from "../../persistence/Services/ProjectionTurns.ts";
import type { ProjectorDefinition } from "./ProjectionPipeline.types.ts";
import type { ProjectionProjectorDeps } from "./ProjectionPipeline.projectors.ts";
import {
  finalizeTurnStateFromSessionStatus,
  retainProjectionTurnsAfterConversationRollback,
} from "./ProjectionPipeline.helpers.ts";

export const makeTurnProjectors = (deps: ProjectionProjectorDeps) => {
  const { projectionTurnRepository } = deps;

  const applyThreadTurnsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.turn-start-requested": {
          yield* projectionTurnRepository.replacePendingTurnStart({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
            sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
            requestedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.session-set": {
          const turnId = event.payload.session.activeTurnId;
          if (event.payload.session.status !== "running" || turnId === null) {
            if (
              event.payload.session.activeTurnId === null &&
              (event.payload.session.status === "ready" ||
                event.payload.session.status === "error" ||
                event.payload.session.status === "interrupted" ||
                event.payload.session.status === "stopped")
            ) {
              // Close the newest still-open turn when the runtime reports that
              // the thread is no longer running. Assistant message completion
              // can happen multiple times inside one turn, so session status is
              // the safer lifecycle boundary for `completedAt`.
              const turnToFinalize = (yield* projectionTurnRepository.listByThreadId({
                threadId: event.payload.threadId,
              }))
                .filter(
                  (
                    row,
                  ): row is ProjectionTurn & {
                    turnId: Exclude<ProjectionTurn["turnId"], null>;
                  } => row.turnId !== null && row.completedAt === null,
                )
                .toSorted(
                  (left, right) =>
                    right.requestedAt.localeCompare(left.requestedAt) ||
                    right.turnId.localeCompare(left.turnId),
                )
                .at(0);

              if (turnToFinalize) {
                yield* projectionTurnRepository.upsertByTurnId({
                  ...turnToFinalize,
                  state: finalizeTurnStateFromSessionStatus(
                    event.payload.session.status,
                    turnToFinalize.state,
                  ),
                  startedAt: turnToFinalize.startedAt ?? event.payload.session.updatedAt,
                  requestedAt: turnToFinalize.requestedAt ?? event.payload.session.updatedAt,
                  completedAt: event.payload.session.updatedAt,
                });
              }
            }
            return;
          }

          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId,
          });
          const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          if (Option.isSome(existingTurn)) {
            const nextState =
              existingTurn.value.state === "completed" || existingTurn.value.state === "error"
                ? existingTurn.value.state
                : "running";
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: nextState,
              pendingMessageId:
                existingTurn.value.pendingMessageId ??
                (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
              sourceProposedPlanThreadId:
                existingTurn.value.sourceProposedPlanThreadId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanThreadId
                  : null),
              sourceProposedPlanId:
                existingTurn.value.sourceProposedPlanId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanId
                  : null),
              startedAt:
                existingTurn.value.startedAt ?? event.payload.session.updatedAt ?? event.occurredAt,
              requestedAt:
                existingTurn.value.requestedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
            });
          } else {
            yield* projectionTurnRepository.upsertByTurnId({
              turnId,
              threadId: event.payload.threadId,
              pendingMessageId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.messageId
                : null,
              sourceProposedPlanThreadId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanThreadId
                : null,
              sourceProposedPlanId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanId
                : null,
              assistantMessageId: null,
              state: "running",
              requestedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              // Keep `startedAt` tied to provider runtime start, not the earlier user dispatch.
              startedAt: event.payload.session.updatedAt ?? event.occurredAt,
              completedAt: null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
            });
          }

          yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          return;
        }

        case "thread.message-sent": {
          if (event.payload.turnId === null || event.payload.role !== "assistant") {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            const existingIsTerminal =
              existingTurn.value.state === "completed" ||
              existingTurn.value.state === "error" ||
              existingTurn.value.state === "interrupted";
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.messageId,
              state:
                event.payload.streaming && !existingIsTerminal
                  ? "running"
                  : existingTurn.value.state,
              completedAt:
                event.payload.streaming && !existingIsTerminal
                  ? null
                  : existingTurn.value.completedAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.messageId,
            state: "running",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: null,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-interrupt-requested": {
          // An interrupt request is only intent, not confirmation. The provider
          // can still reject it or time out, so we keep the persisted turn state
          // unchanged until a terminal runtime event arrives.
          return;
        }

        case "thread.turn-diff-completed": {
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          const isProviderDiffPlaceholder =
            event.payload.status === "missing" &&
            event.payload.checkpointRef.startsWith("provider-diff:");
          const nextState = isProviderDiffPlaceholder
            ? Option.match(existingTurn, {
                onNone: () => "running" as const,
                onSome: (turn) => turn.state,
              })
            : event.payload.status === "error"
              ? "error"
              : "completed";
          yield* projectionTurnRepository.clearCheckpointTurnConflict({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          });

          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              // Preserve the persisted assistantMessageId when the event payload
              // is null. Placeholder turn-diff events can fire before the
              // assistant message is finalized; they must not erase a real id
              // recorded earlier by thread.message-sent.
              assistantMessageId:
                event.payload.assistantMessageId ?? existingTurn.value.assistantMessageId,
              state: nextState,
              checkpointTurnCount: event.payload.checkpointTurnCount,
              checkpointRef: event.payload.checkpointRef,
              checkpointStatus: event.payload.status,
              checkpointFiles: event.payload.files,
              startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
              completedAt: isProviderDiffPlaceholder
                ? existingTurn.value.completedAt
                : event.payload.completedAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.assistantMessageId,
            state: nextState,
            requestedAt: event.payload.completedAt,
            startedAt: event.payload.completedAt,
            completedAt: isProviderDiffPlaceholder ? null : event.payload.completedAt,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
          });
          return;
        }

        case "thread.reverted": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptTurns = existingTurns.filter(
            (turn) =>
              turn.turnId !== null &&
              turn.checkpointTurnCount !== null &&
              turn.checkpointTurnCount <= event.payload.turnCount,
          );
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        case "thread.conversation-rolled-back": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const removedTurnIds = new Set(event.payload.removedTurnIds ?? []);
          const keptTurns = retainProjectionTurnsAfterConversationRollback(
            existingTurns,
            removedTurnIds,
          );
          if (keptTurns.length === existingTurns.length) {
            return;
          }
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? turn.pendingMessageId === null ||
                  turn.state !== "pending" ||
                  turn.checkpointTurnCount !== null
                  ? Effect.void
                  : projectionTurnRepository.replacePendingTurnStart({
                      threadId: turn.threadId,
                      messageId: turn.pendingMessageId,
                      sourceProposedPlanThreadId: turn.sourceProposedPlanThreadId,
                      sourceProposedPlanId: turn.sourceProposedPlanId,
                      requestedAt: turn.requestedAt,
                    })
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

  return {
    applyThreadTurnsProjection,
  };
};
