import {
  CommandId,
  MessageId,
  type OrchestrationProposedPlanId,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";

import {
  generatedImageMarkdown,
  isGeneratedImageOnlyMarkdown,
} from "../../codexGeneratedImages.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { providerCommandId } from "./ProviderRuntimeIngestion.config.ts";
import {
  hasRenderableAssistantText,
  normalizeProposedPlanMarkdown,
  sameId,
} from "./ProviderRuntimeIngestion.mapping.ts";
import type { IngestionState } from "./ProviderRuntimeIngestion.state.ts";

// FILE: ProviderRuntimeIngestion.messages.ts
// Purpose: Assistant-message finalization, proposed-plan upsert/finalize, generated-image
//   reference appending, and source-proposed-plan implementation wiring for the ingestion
//   projection.
// Layer: dependency-built once per ingestion factory via makeIngestionMessages(deps).
// Exports: IngestionMessagesDeps, IngestionMessages, makeIngestionMessages.

export interface IngestionMessagesDeps {
  readonly orchestrationEngine: typeof OrchestrationEngineService.Service;
  readonly providerService: typeof ProviderService.Service;
  readonly projectionTurnRepository: typeof ProjectionTurnRepository.Service;
  readonly state: IngestionState;
  readonly getThreadDetail: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>;
}

export type IngestionMessages = ReturnType<typeof makeIngestionMessages>;

export function makeIngestionMessages(deps: IngestionMessagesDeps) {
  const { orchestrationEngine, providerService, projectionTurnRepository, state, getThreadDetail } =
    deps;

  const resolveAssistantCompletionMessageId = (input: {
    event: ProviderRuntimeEvent;
    thread: OrchestrationThread;
    turnId?: TurnId;
  }) =>
    Effect.gen(function* () {
      if (input.turnId) {
        const knownAssistantMessageIds = yield* state.getAssistantMessageIdsForTurn(
          input.thread.id,
          input.turnId,
        );
        if (input.event.itemId) {
          const eventMessageId = MessageId.makeUnsafe(`assistant:${input.event.itemId}`);
          if (knownAssistantMessageIds.has(eventMessageId)) {
            return eventMessageId;
          }
        }
        if (knownAssistantMessageIds.size === 1) {
          const [onlyMessageId] = knownAssistantMessageIds;
          if (onlyMessageId) {
            return onlyMessageId;
          }
        }
        if (knownAssistantMessageIds.size > 1) {
          const preferredKnownMessage = input.thread.messages
            .filter(
              (message: OrchestrationThread["messages"][number]) =>
                message.role === "assistant" &&
                message.turnId === input.turnId &&
                knownAssistantMessageIds.has(message.id),
            )
            .toSorted(
              (
                left: OrchestrationThread["messages"][number],
                right: OrchestrationThread["messages"][number],
              ) => {
                if (left.streaming !== right.streaming) {
                  return left.streaming ? -1 : 1;
                }
                return (
                  right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
                );
              },
            )[0];
          if (preferredKnownMessage) {
            return preferredKnownMessage.id;
          }
        }
        return input.event.itemId
          ? MessageId.makeUnsafe(`assistant:${input.event.itemId}`)
          : MessageId.makeUnsafe(`assistant:${input.turnId}`);
      }

      if (input.event.itemId) {
        return MessageId.makeUnsafe(`assistant:${input.event.itemId}`);
      }

      return MessageId.makeUnsafe(`assistant:${input.event.eventId}`);
    });

  const flushBufferedAssistantMessageDelta = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* state.takeBufferedAssistantText(input.messageId);
      if (!hasRenderableAssistantText(bufferedText)) {
        return false;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: bufferedText,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      return true;
    });

  const flushBufferedAssistantMessagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const assistantMessageIds = yield* state.getAssistantMessageIdsForTurn(
        input.threadId,
        input.turnId,
      );
      for (const assistantMessageId of assistantMessageIds) {
        yield* flushBufferedAssistantMessageDelta({
          event: input.event,
          threadId: input.threadId,
          messageId: assistantMessageId,
          turnId: input.turnId,
          createdAt: input.createdAt,
          commandTag: input.commandTag,
        });
      }
    });

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* state.takeBufferedAssistantText(input.messageId);
      const text =
        bufferedText.length > 0
          ? bufferedText
          : (input.fallbackText?.trim().length ?? 0) > 0
            ? input.fallbackText!
            : "";

      if (hasRenderableAssistantText(text)) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(input.event, input.finalDeltaCommandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      yield* state.clearAssistantMessageState(input.messageId);
    });

  const finalizeBufferedAssistantMessagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
  }) =>
    Effect.gen(function* () {
      const assistantMessageIds = yield* state.getAssistantMessageIdsForTurn(
        input.threadId,
        input.turnId,
      );
      yield* Effect.forEach(
        assistantMessageIds,
        (assistantMessageId) =>
          finalizeAssistantMessage({
            event: input.event,
            threadId: input.threadId,
            messageId: assistantMessageId,
            turnId: input.turnId,
            createdAt: input.createdAt,
            commandTag: input.commandTag,
            finalDeltaCommandTag: input.finalDeltaCommandTag,
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* state.clearAssistantMessageIdsForTurn(input.threadId, input.turnId);
    });

  const appendGeneratedImageReference = (input: {
    event: ProviderRuntimeEvent;
    thread: OrchestrationThread;
    imagePath: string;
    turnId?: TurnId;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const markdown = generatedImageMarkdown(input.imagePath);
      const messages = input.thread.messages;
      const sameItemMessageId = input.event.itemId
        ? MessageId.makeUnsafe(`assistant:${input.event.itemId}`)
        : undefined;
      const sameItemMessage = sameItemMessageId
        ? messages.find(
            (message) => message.role === "assistant" && message.id === sameItemMessageId,
          )
        : undefined;
      const sameImageMessage = messages.find(
        (message) =>
          message.role === "assistant" &&
          (message.text.includes(input.imagePath) || message.text.includes(markdown)),
      );
      const finalTurnMessage = input.turnId
        ? messages
            .filter(
              (message) =>
                message.role === "assistant" &&
                message.turnId === input.turnId &&
                !message.streaming &&
                message.text.trim().length > 0 &&
                !isGeneratedImageOnlyMarkdown(message.text),
            )
            .toSorted(
              (left, right) =>
                right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
            )[0]
        : undefined;
      const existingMessage = sameItemMessage ?? sameImageMessage ?? finalTurnMessage;
      const targetMessageId =
        existingMessage?.id ??
        MessageId.makeUnsafe(`assistant:image:${input.event.itemId ?? input.event.eventId}`);
      const targetMessageText = existingMessage?.text ?? "";
      const targetIsStreaming = existingMessage?.streaming ?? false;
      const alreadyContainsImage =
        targetMessageText.includes(input.imagePath) || targetMessageText.includes(markdown);

      let dispatchedDelta = false;
      if (!alreadyContainsImage) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(input.event, "generated-image-delta"),
          threadId: input.thread.id,
          messageId: targetMessageId,
          delta: targetMessageText.trim().length > 0 ? `\n\n${markdown}` : markdown,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
        dispatchedDelta = true;
      }

      // Only finalize when we actually changed the message (delta dispatched, or we
      // just created a brand-new image-only message), or when the existing target was
      // still streaming. Skipping complete on already-finalized targets keeps replays
      // and duplicate provider notifications from emitting redundant message-sent events.
      const shouldComplete = dispatchedDelta || !existingMessage || targetIsStreaming;
      if (shouldComplete) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: providerCommandId(input.event, "generated-image-complete"),
          threadId: input.thread.id,
          messageId: targetMessageId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }
    });

  const upsertProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
      if (!planMarkdown) {
        return;
      }

      const existingPlan = input.threadProposedPlans.find((entry) => entry.id === input.planId);
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: providerCommandId(input.event, "proposed-plan-upsert"),
        threadId: input.threadId,
        proposedPlan: {
          id: input.planId,
          turnId: input.turnId ?? null,
          planMarkdown,
          implementedAt: existingPlan?.implementedAt ?? null,
          implementationThreadId: existingPlan?.implementationThreadId ?? null,
          createdAt: existingPlan?.createdAt ?? input.createdAt,
          updatedAt: input.updatedAt,
        },
        createdAt: input.updatedAt,
      });
    });

  const finalizeBufferedProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const bufferedPlan = yield* state.takeBufferedProposedPlan(input.planId);
      const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
      const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
      const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
      if (!planMarkdown) {
        return;
      }

      yield* upsertProposedPlan({
        event: input.event,
        threadId: input.threadId,
        threadProposedPlans: input.threadProposedPlans,
        planId: input.planId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        planMarkdown,
        createdAt:
          bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
            ? bufferedPlan.createdAt
            : input.updatedAt,
        updatedAt: input.updatedAt,
      });
      yield* state.clearBufferedProposedPlan(input.planId);
    });

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.activeTurnId;
  });

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fnUntraced(function* (
    threadId: ThreadId,
    eventTurnId: TurnId | undefined,
  ) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
  });

  const markSourceProposedPlanImplemented = Effect.fnUntraced(function* (
    sourceThreadId: ThreadId,
    sourcePlanId: OrchestrationProposedPlanId,
    implementationThreadId: ThreadId,
    implementedAt: string,
  ) {
    const sourceThread = yield* getThreadDetail(sourceThreadId);
    const sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
    if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.proposed-plan.upsert",
      commandId: CommandId.makeUnsafe(
        `provider:source-proposed-plan-implemented:${implementationThreadId}:${crypto.randomUUID()}`,
      ),
      threadId: sourceThread.id,
      proposedPlan: {
        ...sourcePlan,
        implementedAt,
        implementationThreadId,
        updatedAt: implementedAt,
      },
      createdAt: implementedAt,
    });
  });

  return {
    resolveAssistantCompletionMessageId,
    flushBufferedAssistantMessagesForTurn,
    finalizeAssistantMessage,
    finalizeBufferedAssistantMessagesForTurn,
    appendGeneratedImageReference,
    finalizeBufferedProposedPlan,
    getSourceProposedPlanReferenceForAcceptedTurnStart,
    markSourceProposedPlanImplemented,
  };
}
