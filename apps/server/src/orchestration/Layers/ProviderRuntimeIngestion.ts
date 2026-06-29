import {
  MessageId,
  type AssistantDeliveryMode,
  CheckpointRef,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Option, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  buildSubagentIdentityDirectory,
  collectSubagentProviderThreadIds,
  extractSubagentIdentityHints,
  resolveSubagentIdentityFromDirectory,
} from "@t3tools/shared/subagents";

import { generatedImagePathFromRuntimeEvent } from "../../codexGeneratedImages.ts";
import { parseCheckpointFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import {
  DEFAULT_ASSISTANT_DELIVERY_MODE,
  providerCommandId,
  STRICT_PROVIDER_LIFECYCLE_GUARD,
} from "./ProviderRuntimeIngestion.config.ts";
import {
  asObject,
  extractCollabPayload,
  extractSubagentIdentity,
  inferRuntimeModeFromUserInputAnswers,
  normalizeIdentifier,
  orchestrationSessionStatusFromRuntimeState,
  proposedPlanIdForTurn,
  proposedPlanIdFromEvent,
  resolveTerminalTurnId,
  runtimeErrorMessageFromEvent,
  runtimeEventToActivities,
  runtimeTurnErrorMessage,
  runtimeTurnState,
  sameId,
  subagentThreadId,
  subagentThreadTitle,
  toTurnId,
} from "./ProviderRuntimeIngestion.mapping.ts";
import {
  providerItemFromRuntimeEvent,
  providerItemIdFromRuntimeEvent,
} from "./ProviderRuntimeIngestion.mapping.items.ts";
import { makeIngestionState } from "./ProviderRuntimeIngestion.state.ts";
import { makeIngestionMessages } from "./ProviderRuntimeIngestion.messages.ts";
import type {
  RuntimeIngestionInput,
  SubagentIdentity,
  TurnStartRequestedDomainEvent,
} from "./ProviderRuntimeIngestion.types.ts";

// FILE: ProviderRuntimeIngestion.ts
// Purpose: Projects provider runtime events into orchestration read-model updates and thread activity.
// Layer: Server orchestration ingestion
// Exports: ProviderRuntimeIngestionLive
// Depends on: ProviderRuntimeEvent contracts, OrchestrationEngine, Projection repositories

const deliveryModeKey = (threadId: ThreadId, turnId: TurnId | string) => `${threadId}:${turnId}`;

const toolOutputBufferKey = (threadId: ThreadId, itemId: string) => `${threadId}:${itemId}`;

const isToolOutputDelta = (
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
  event.type === "content.delta" &&
  event.itemId !== undefined &&
  (event.payload.streamKind === "command_output" ||
    event.payload.streamKind === "file_change_output" ||
    event.payload.streamKind === "unknown");

const mergeBufferedToolOutput = (
  data: unknown,
  bufferedOutput: string,
): Record<string, unknown> => {
  const dataRecord = asObject(data) ?? {};
  const rawOutputRecord = asObject(dataRecord.rawOutput);
  const rawOutput =
    rawOutputRecord === undefined
      ? { output: bufferedOutput }
      : {
          ...rawOutputRecord,
          ...(typeof rawOutputRecord.output === "string" && rawOutputRecord.output.length > 0
            ? {}
            : { output: bufferedOutput }),
        };
  return {
    ...dataRecord,
    rawOutput,
  };
};

const eventWithBufferedToolOutput = (
  event: ProviderRuntimeEvent,
  toolOutputBuffersByItem: Map<string, string>,
): ProviderRuntimeEvent => {
  if (event.type !== "item.completed" || event.itemId === undefined) {
    return event;
  }
  const bufferedOutput = toolOutputBuffersByItem.get(
    toolOutputBufferKey(event.threadId, event.itemId),
  );
  if (bufferedOutput === undefined || bufferedOutput.length === 0) {
    return event;
  }
  toolOutputBuffersByItem.delete(toolOutputBufferKey(event.threadId, event.itemId));
  return {
    ...event,
    payload: {
      ...event.payload,
      data: mergeBufferedToolOutput(event.payload.data, bufferedOutput),
    },
  };
};

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;

  const pendingAssistantDeliveryModesByThread = new Map<string, AssistantDeliveryMode>();
  const assistantDeliveryModesByTurn = new Map<string, AssistantDeliveryMode>();
  const providerDiffPlaceholdersByTurn = new Map<
    string,
    { readonly checkpointRef: CheckpointRef; readonly checkpointTurnCount: number }
  >();
  const toolOutputBuffersByItem = new Map<string, string>();

  const state = yield* makeIngestionState();
  const {
    rememberAssistantMessageId,
    forgetAssistantMessageId,
    getAssistantMessageIdsForTurn,
    clearAssistantMessageIdsForTurn,
    appendBufferedAssistantText,
    appendBufferedProposedPlan,
    clearTurnStateForSession,
  } = state;

  const getThreadDetail = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<OrchestrationThread | undefined> {
    return Option.getOrUndefined(
      yield* projectionSnapshotQuery
        .getThreadDetailById(threadId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none()))),
    );
  });
  const resolveAssistantDeliveryMode = (threadId: ThreadId, turnId: TurnId | string | undefined) =>
    turnId !== undefined
      ? (assistantDeliveryModesByTurn.get(deliveryModeKey(threadId, turnId)) ??
        pendingAssistantDeliveryModesByThread.get(String(threadId)) ??
        DEFAULT_ASSISTANT_DELIVERY_MODE)
      : (pendingAssistantDeliveryModesByThread.get(String(threadId)) ??
        DEFAULT_ASSISTANT_DELIVERY_MODE);
  const clearAssistantDeliveryModesForThread = (threadId: ThreadId) => {
    pendingAssistantDeliveryModesByThread.delete(String(threadId));
    const prefix = `${threadId}:`;
    for (const key of assistantDeliveryModesByTurn.keys()) {
      if (key.startsWith(prefix)) {
        assistantDeliveryModesByTurn.delete(key);
      }
    }
    for (const key of providerDiffPlaceholdersByTurn.keys()) {
      if (key.startsWith(prefix)) {
        providerDiffPlaceholdersByTurn.delete(key);
      }
    }
    for (const key of toolOutputBuffersByItem.keys()) {
      if (key.startsWith(prefix)) {
        toolOutputBuffersByItem.delete(key);
      }
    }
  };

  const {
    resolveAssistantCompletionMessageId,
    flushBufferedAssistantMessagesForTurn,
    finalizeAssistantMessage,
    finalizeBufferedAssistantMessagesForTurn,
    appendGeneratedImageReference,
    finalizeBufferedProposedPlan,
    getSourceProposedPlanReferenceForAcceptedTurnStart,
    markSourceProposedPlanImplemented,
  } = makeIngestionMessages({
    orchestrationEngine,
    providerService,
    projectionTurnRepository,
    state,
    getThreadDetail,
  });

  const processRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const now = event.createdAt;
      const parentThread = yield* getThreadDetail(event.threadId);
      if (!parentThread) return;

      const ensureSubagentThread = (
        providerThreadId: string,
        identity?: Pick<
          SubagentIdentity,
          "agentId" | "nickname" | "role" | "model" | "modelIsRequestedHint"
        >,
      ) =>
        Effect.gen(function* () {
          const childThreadId = subagentThreadId(parentThread.id, providerThreadId);
          // A single provider event can describe the child both as a collab receiver and
          // as the event's provider thread, so re-read after any earlier dispatch in this handler.
          const existingThread = yield* projectionSnapshotQuery.getThreadDetailById(childThreadId);
          const resolvedModelSelection =
            identity?.model && identity.modelIsRequestedHint !== true
              ? {
                  provider: parentThread.modelSelection.provider,
                  model: identity.model,
                }
              : undefined;

          if (Option.isNone(existingThread)) {
            yield* orchestrationEngine.dispatch({
              type: "thread.create",
              commandId: providerCommandId(event, "subagent-thread-create"),
              threadId: childThreadId,
              projectId: parentThread.projectId,
              title: subagentThreadTitle({
                nickname: identity?.nickname,
                role: identity?.role,
                providerThreadId,
              }),
              modelSelection: resolvedModelSelection ?? parentThread.modelSelection,
              runtimeMode: parentThread.runtimeMode,
              interactionMode: parentThread.interactionMode,
              envMode: parentThread.envMode,
              branch: parentThread.branch,
              worktreePath: parentThread.worktreePath,
              associatedWorktreePath: parentThread.associatedWorktreePath,
              associatedWorktreeBranch: parentThread.associatedWorktreeBranch,
              associatedWorktreeRef: parentThread.associatedWorktreeRef,
              parentThreadId: parentThread.id,
              subagentAgentId: identity?.agentId ?? null,
              subagentNickname: identity?.nickname ?? null,
              subagentRole: identity?.role ?? null,
              createdAt: now,
            });
          } else {
            const existingThreadShell = existingThread.value;
            if (
              identity?.agentId !== undefined ||
              identity?.nickname !== undefined ||
              identity?.role !== undefined ||
              (identity?.model !== undefined && identity.modelIsRequestedHint !== true)
            ) {
              yield* orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: providerCommandId(event, "subagent-thread-meta-update"),
                threadId: childThreadId,
                ...(identity?.nickname !== undefined || identity?.role !== undefined
                  ? {
                      title: subagentThreadTitle({
                        nickname:
                          identity?.nickname ?? existingThreadShell.subagentNickname ?? undefined,
                        role: identity?.role ?? existingThreadShell.subagentRole ?? undefined,
                        providerThreadId,
                      }),
                    }
                  : {}),
                parentThreadId: parentThread.id,
                ...(resolvedModelSelection !== undefined &&
                existingThreadShell.modelSelection.model !== resolvedModelSelection.model
                  ? { modelSelection: resolvedModelSelection }
                  : {}),
                ...(identity?.agentId !== undefined ? { subagentAgentId: identity.agentId } : {}),
                ...(identity?.nickname !== undefined
                  ? { subagentNickname: identity.nickname }
                  : {}),
                ...(identity?.role !== undefined ? { subagentRole: identity.role } : {}),
              });
            }
          }

          return {
            threadId: childThreadId,
            thread: Option.match(existingThread, {
              onSome: (thread) => thread,
              onNone: () => ({
                ...parentThread,
                id: childThreadId,
                title: subagentThreadTitle({
                  nickname: identity?.nickname,
                  role: identity?.role,
                  providerThreadId,
                }),
                parentThreadId: parentThread.id,
                subagentAgentId: identity?.agentId ?? null,
                subagentNickname: identity?.nickname ?? null,
                subagentRole: identity?.role ?? null,
                modelSelection: resolvedModelSelection ?? parentThread.modelSelection,
                latestTurn: null,
                messages: [],
                proposedPlans: [],
                providerItems: [],
                activities: [],
                checkpoints: [],
                session: null,
                createdAt: now,
                updatedAt: now,
              }),
            }),
          };
        });

      const collabPayload = extractCollabPayload(event);
      const collabItem = asObject(collabPayload?.item) ?? collabPayload;
      const isCollabToolEvent =
        (event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed") &&
        event.payload.itemType === "collab_agent_tool_call" &&
        collabItem !== undefined;
      if (isCollabToolEvent && collabItem) {
        const receiverThreadIds = collectSubagentProviderThreadIds(collabItem);
        const identityDirectory = buildSubagentIdentityDirectory(
          extractSubagentIdentityHints(collabItem),
        );
        for (const receiverThreadId of receiverThreadIds) {
          yield* ensureSubagentThread(
            receiverThreadId,
            resolveSubagentIdentityFromDirectory(identityDirectory, {
              providerThreadId: receiverThreadId,
            }) as SubagentIdentity | undefined,
          );
        }
      }

      const providerThreadId = normalizeIdentifier(event.providerRefs?.providerThreadId);
      const providerParentThreadId = normalizeIdentifier(
        event.providerRefs?.providerParentThreadId,
      );
      const isChildThreadEvent =
        providerThreadId !== undefined &&
        providerParentThreadId !== undefined &&
        providerThreadId !== providerParentThreadId;
      const targetThreadResolution =
        isChildThreadEvent && providerThreadId
          ? yield* ensureSubagentThread(
              providerThreadId,
              extractSubagentIdentity(event, providerThreadId),
            )
          : { threadId: parentThread.id, thread: parentThread };
      const thread = targetThreadResolution.thread;
      const activeTurnId = thread.session?.activeTurnId ?? null;
      const eventTurnId = resolveTerminalTurnId(event, activeTurnId);
      const mappedEvent = eventWithBufferedToolOutput(event, toolOutputBuffersByItem);
      const providerItemId = providerItemIdFromRuntimeEvent(mappedEvent);
      const providerItem = providerItemFromRuntimeEvent({
        event: mappedEvent,
        existing: thread.providerItems.find((item) => item.id === providerItemId),
        turnId: eventTurnId ?? toTurnId(event.turnId) ?? activeTurnId,
        createdAt: now,
      });
      if (providerItem !== undefined) {
        yield* orchestrationEngine.dispatch({
          type: "thread.provider-item.upsert",
          commandId: providerCommandId(event, "provider-item-upsert"),
          threadId: thread.id,
          providerItem,
          createdAt: now,
        });
      }
      const isTerminalTurnEvent = event.type === "turn.completed" || event.type === "turn.aborted";
      if (event.type === "turn.started" && eventTurnId !== undefined) {
        const pendingMode =
          pendingAssistantDeliveryModesByThread.get(String(thread.id)) ??
          DEFAULT_ASSISTANT_DELIVERY_MODE;
        assistantDeliveryModesByTurn.set(deliveryModeKey(thread.id, eventTurnId), pendingMode);
        pendingAssistantDeliveryModesByThread.delete(String(thread.id));
      }

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

      const shouldApplyThreadLifecycle = (() => {
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return true;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return !conflictsWithActiveTurn;
          case "turn.completed":
          case "turn.aborted":
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // If no active turn is tracked, accept completion scoped to this thread.
            return true;
          default:
            return true;
        }
      })();
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed" ||
        event.type === "turn.aborted"
      ) {
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : isTerminalTurnEvent ||
                event.type === "session.exited" ||
                (event.type === "session.state.changed" &&
                  (event.payload.state === "ready" ||
                    event.payload.state === "stopped" ||
                    event.payload.state === "error"))
              ? null
              : activeTurnId;
        const status = (() => {
          switch (event.type) {
            case "session.state.changed":
              return orchestrationSessionStatusFromRuntimeState(event.payload.state);
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              return runtimeTurnState(event) === "failed" ? "error" : "ready";
            case "turn.aborted":
              return "interrupted";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active turn; preserve turn-running state in that case.
              return activeTurnId !== null ? "running" : "ready";
          }
        })();
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" && runtimeTurnState(event) === "failed"
              ? (runtimeTurnErrorMessage(event) ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready" || status === "interrupted"
                ? null
                : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
          if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
            yield* markSourceProposedPlanImplemented(
              acceptedTurnStartedSourcePlan.sourceThreadId,
              acceptedTurnStartedSourcePlan.sourcePlanId,
              thread.id,
              now,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "provider runtime ingestion failed to mark source proposed plan",
                  {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  },
                ),
              ),
            );
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "user-input.resolved") {
        const inferredRuntimeMode = inferRuntimeModeFromUserInputAnswers(event.payload.answers);
        if (inferredRuntimeMode && inferredRuntimeMode !== thread.runtimeMode) {
          yield* orchestrationEngine.dispatch({
            type: "thread.runtime-mode.set",
            commandId: providerCommandId(event, "thread-runtime-mode-set"),
            threadId: thread.id,
            runtimeMode: inferredRuntimeMode,
            createdAt: now,
          });
        }
      }

      const assistantDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? event.payload.delta
          : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      if (assistantDelta && assistantDelta.length > 0) {
        const assistantMessageId = MessageId.makeUnsafe(
          `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
        );
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        const assistantDeliveryMode = resolveAssistantDeliveryMode(thread.id, turnId);
        if (assistantDeliveryMode === "buffered") {
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
          if (spillChunk.length > 0) {
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: providerCommandId(event, "assistant-delta-buffer-spill"),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
          }
        } else {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: providerCommandId(event, "assistant-delta"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: assistantDelta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      if (isToolOutputDelta(event)) {
        const itemId = event.itemId;
        if (itemId !== undefined) {
          const key = toolOutputBufferKey(thread.id, itemId);
          toolOutputBuffersByItem.set(
            key,
            `${toolOutputBuffersByItem.get(key) ?? ""}${event.payload.delta}`,
          );
        }
      }

      const assistantCompletion =
        event.type === "item.completed" && event.payload.itemType === "assistant_message"
          ? {
              fallbackText: event.payload.detail,
            }
          : undefined;
      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const eventCompletionTurnId = toTurnId(event.turnId);
        const assistantMessageId = yield* resolveAssistantCompletionMessageId({
          event,
          thread,
          ...(eventCompletionTurnId ? { turnId: eventCompletionTurnId } : {}),
        });
        const existingAssistantMessage = thread.messages.find(
          (entry) => entry.id === assistantMessageId,
        );
        const turnId =
          toTurnId(existingAssistantMessage?.turnId ?? undefined) ?? eventCompletionTurnId;
        const shouldApplyFallbackCompletionText =
          !existingAssistantMessage || existingAssistantMessage.text.length === 0;
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        yield* finalizeAssistantMessage({
          event,
          threadId: thread.id,
          messageId: assistantMessageId,
          ...(turnId ? { turnId } : {}),
          createdAt: now,
          commandTag: "assistant-complete",
          finalDeltaCommandTag: "assistant-delta-finalize",
          ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
            ? { fallbackText: assistantCompletion.fallbackText }
            : {}),
        });

        if (turnId) {
          yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
        }
      }

      if (proposedPlanCompletion) {
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: thread.proposedPlans,
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      const generatedImagePath = generatedImagePathFromRuntimeEvent(event);
      if (generatedImagePath) {
        const generatedImageTurnId = toTurnId(event.turnId) ?? activeTurnId ?? undefined;
        yield* appendGeneratedImageReference({
          event,
          thread,
          imagePath: generatedImagePath,
          ...(generatedImageTurnId ? { turnId: generatedImageTurnId } : {}),
          createdAt: now,
        });
      }

      if (isTerminalTurnEvent) {
        const finalizedTurnId = eventTurnId ?? activeTurnId ?? undefined;
        if (finalizedTurnId) {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
            thread.id,
            finalizedTurnId,
          );
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              finalizeAssistantMessage({
                event,
                threadId: thread.id,
                messageId: assistantMessageId,
                turnId: finalizedTurnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* clearAssistantMessageIdsForTurn(thread.id, finalizedTurnId);
          assistantDeliveryModesByTurn.delete(deliveryModeKey(thread.id, finalizedTurnId));
          providerDiffPlaceholdersByTurn.delete(deliveryModeKey(thread.id, finalizedTurnId));

          yield* finalizeBufferedProposedPlan({
            event,
            threadId: thread.id,
            threadProposedPlans: thread.proposedPlans,
            planId: proposedPlanIdForTurn(thread.id, finalizedTurnId),
            turnId: finalizedTurnId,
            updatedAt: now,
          });
        }
      }

      if (event.type === "session.exited") {
        const exitedTurnId = eventTurnId ?? activeTurnId ?? undefined;
        if (exitedTurnId) {
          yield* finalizeBufferedAssistantMessagesForTurn({
            event,
            threadId: thread.id,
            turnId: exitedTurnId,
            createdAt: now,
            commandTag: "assistant-complete-session-exit",
            finalDeltaCommandTag: "assistant-delta-session-exit",
          });
        }
        yield* clearTurnStateForSession(thread.id);
        clearAssistantDeliveryModesForThread(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = runtimeErrorMessageFromEvent(event) ?? "Provider runtime error";
        const erroredTurnId = eventTurnId ?? activeTurnId ?? undefined;

        if (erroredTurnId) {
          yield* finalizeBufferedAssistantMessagesForTurn({
            event,
            threadId: thread.id,
            turnId: erroredTurnId,
            createdAt: now,
            commandTag: "assistant-complete-runtime-error",
            finalDeltaCommandTag: "assistant-delta-runtime-error",
          });
          assistantDeliveryModesByTurn.delete(deliveryModeKey(thread.id, erroredTurnId));
        }

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: eventTurnId ?? null,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
        });
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const placeholderKey = deliveryModeKey(thread.id, turnId);
          const currentThread = (yield* getThreadDetail(thread.id)) ?? thread;
          const existingCheckpoint = currentThread.checkpoints.find((checkpoint) =>
            sameId(checkpoint.turnId, turnId),
          );
          const rememberedPlaceholder = providerDiffPlaceholdersByTurn.get(placeholderKey);
          const canUpdateExistingPlaceholder =
            existingCheckpoint?.status === "missing" &&
            existingCheckpoint.checkpointRef.startsWith("provider-diff:");
          if (existingCheckpoint === undefined || canUpdateExistingPlaceholder) {
            const capabilities = yield* providerService.getCapabilities(event.provider);
            const files =
              capabilities.supportsLiveTurnDiffPatch === true
                ? parseCheckpointFilesFromUnifiedDiff(event.payload.unifiedDiff)
                : [];
            const maxTurnCount = currentThread.checkpoints.reduce(
              (max, c) => Math.max(max, c.checkpointTurnCount),
              0,
            );
            const checkpointRef =
              existingCheckpoint?.checkpointRef ??
              rememberedPlaceholder?.checkpointRef ??
              CheckpointRef.makeUnsafe(`provider-diff:${event.eventId}`);
            const checkpointTurnCount =
              existingCheckpoint?.checkpointTurnCount ??
              rememberedPlaceholder?.checkpointTurnCount ??
              maxTurnCount + 1;
            providerDiffPlaceholdersByTurn.set(placeholderKey, {
              checkpointRef,
              checkpointTurnCount,
            });
            // Leave assistantMessageId undefined on the placeholder: the real
            // capture performed by CheckpointReactor will resolve the actual
            // assistant MessageId once the message is finalized. Emitting a
            // synthetic id here would leak an incorrect key that can collide
            // across turns and cause the diff card to render on the wrong row.
            yield* orchestrationEngine.dispatch({
              type: "thread.turn.diff.complete",
              commandId: providerCommandId(event, "thread-turn-diff-complete"),
              threadId: thread.id,
              turnId,
              completedAt: now,
              checkpointRef,
              status: "missing",
              files,
              assistantMessageId: undefined,
              checkpointTurnCount,
              createdAt: now,
            });
          }
        }
      }

      const activities = runtimeEventToActivities(mappedEvent);
      yield* Effect.forEach(activities, (activity) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: providerCommandId(event, "thread-activity-append"),
          threadId: thread.id,
          activity,
          createdAt: activity.createdAt,
        }),
      ).pipe(Effect.asVoid);
    });

  const processDomainEvent = (event: TurnStartRequestedDomainEvent) =>
    Effect.gen(function* () {
      const nextAssistantDeliveryMode =
        event.payload.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE;
      pendingAssistantDeliveryModesByThread.set(
        String(event.payload.threadId),
        nextAssistantDeliveryMode,
      );
      if (nextAssistantDeliveryMode !== "streaming") {
        return;
      }

      const thread = Option.getOrUndefined(
        yield* projectionSnapshotQuery.getThreadShellById(event.payload.threadId),
      );
      const activeTurnId = thread?.session?.activeTurnId ?? undefined;
      if (!thread || !activeTurnId) {
        return;
      }
      assistantDeliveryModesByTurn.set(
        deliveryModeKey(event.payload.threadId, activeTurnId),
        nextAssistantDeliveryMode,
      );

      const flushEvent: ProviderRuntimeEvent = {
        type: "turn.started",
        eventId: event.eventId,
        provider: thread.modelSelection.provider,
        createdAt: event.payload.createdAt,
        threadId: event.payload.threadId,
        turnId: activeTurnId,
        payload: {},
      };
      yield* flushBufferedAssistantMessagesForTurn({
        event: flushEvent,
        threadId: event.payload.threadId,
        turnId: activeTurnId,
        createdAt: event.payload.createdAt,
        commandTag: "assistant-delta-domain-flush",
      });
    });

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime" ? processRuntimeEvent(input.event) : processDomainEvent(input.event);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: ProviderRuntimeIngestionShape["start"] = Effect.gen(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        worker.enqueue({ source: "runtime", event }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.turn-start-requested") {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
