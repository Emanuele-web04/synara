// Purpose: Grok ACP notification-stream event handler — projects parsed ACP events into runtime events.
// Layer: deps-parameterized factory; deps carry the session-bound emitters/loggers, handler takes (ctx, event).
// Exports: makeGrokNotificationHandler.

import { type EventId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { Effect } from "effect";

import { readAcpFailedToolDetail } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpToolCallEvent,
  makeAcpTokenUsageEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { type AcpParsedSessionEvent } from "../acp/AcpRuntimeModel.ts";

import { isGrokAcpDebugEnabled } from "./GrokAdapter.logging.ts";
import {
  isRenderableGrokAssistantDelta,
  recordGrokSessionCost,
  scopeGrokRuntimeItemIdForTurn,
  scopeGrokToolCallStateForTurn,
} from "./GrokAdapter.session.ts";
import { type GrokSessionContext, PROVIDER } from "./GrokAdapter.types.ts";
import type { TurnId } from "@t3tools/contracts";

export interface GrokNotificationHandlerDeps {
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
  readonly logNative: (
    threadId: GrokSessionContext["threadId"],
    method: string,
    payload: unknown,
  ) => Effect.Effect<void>;
  readonly emitPlanUpdate: (
    ctx: GrokSessionContext,
    payload: {
      readonly explanation?: string | null;
      readonly plan: ReadonlyArray<{
        readonly step: string;
        readonly status: "pending" | "inProgress" | "completed";
      }>;
    },
    rawPayload: unknown,
  ) => Effect.Effect<void>;
  readonly activeTurnIdForGrokRuntimeEvent: (
    ctx: GrokSessionContext,
    eventTag: string,
  ) => Effect.Effect<TurnId | undefined>;
}

export function makeGrokNotificationHandler(deps: GrokNotificationHandlerDeps) {
  const {
    offerRuntimeEvent,
    makeEventStamp,
    logNative,
    emitPlanUpdate,
    activeTurnIdForGrokRuntimeEvent,
  } = deps;

  return (ctx: GrokSessionContext, event: AcpParsedSessionEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      switch (event._tag) {
        case "ModeChanged":
          return;
        case "AssistantItemStarted":
          {
            const activeTurnId = yield* activeTurnIdForGrokRuntimeEvent(ctx, event._tag);
            if (activeTurnId === undefined) {
              return;
            }
            // Content deltas open the visible message; empty starts only add noise.
          }
          return;
        case "AssistantItemCompleted":
          {
            const activeTurnId = yield* activeTurnIdForGrokRuntimeEvent(ctx, event._tag);
            if (activeTurnId === undefined) {
              return;
            }
            const scopedItemId = scopeGrokRuntimeItemIdForTurn(activeTurnId, event.itemId);
            if (!ctx.activeAssistantItemsWithContent.has(scopedItemId)) {
              if (isGrokAcpDebugEnabled()) {
                yield* Effect.logInfo("grok.acp.empty_assistant_item_suppressed", {
                  threadId: ctx.threadId,
                  turnId: activeTurnId,
                  itemId: scopedItemId,
                });
              }
              return;
            }
            ctx.activeAssistantItemsWithContent.delete(scopedItemId);
            yield* offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp: yield* makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: activeTurnId,
                itemId: scopedItemId,
                lifecycle: "item.completed",
              }),
            );
          }
          return;
        case "PlanUpdated":
          {
            const activeTurnId = yield* activeTurnIdForGrokRuntimeEvent(ctx, event._tag);
            if (activeTurnId === undefined) {
              return;
            }
            yield* logNative(ctx.threadId, "session/update", event.rawPayload);
            yield* emitPlanUpdate(ctx, event.payload, event.rawPayload);
          }
          return;
        case "ToolCallUpdated":
          {
            const activeTurnId = yield* activeTurnIdForGrokRuntimeEvent(ctx, event._tag);
            if (activeTurnId === undefined) {
              return;
            }
            yield* logNative(ctx.threadId, "session/update", event.rawPayload);
            const failedToolDetail = readAcpFailedToolDetail(event.toolCall);
            if (failedToolDetail !== undefined) {
              ctx.activeTurnFailedToolDetail = failedToolDetail;
            }
            yield* offerRuntimeEvent(
              makeAcpToolCallEvent({
                stamp: yield* makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: activeTurnId,
                toolCall: scopeGrokToolCallStateForTurn(activeTurnId, event.toolCall),
                rawPayload: event.rawPayload,
              }),
            );
          }
          return;
        case "ContentDelta":
          {
            const activeTurnId = yield* activeTurnIdForGrokRuntimeEvent(ctx, event._tag);
            if (activeTurnId === undefined) {
              return;
            }
            yield* logNative(ctx.threadId, "session/update", event.rawPayload);
            const scopedItemId = event.itemId
              ? scopeGrokRuntimeItemIdForTurn(activeTurnId, event.itemId)
              : undefined;
            if (isRenderableGrokAssistantDelta(event)) {
              ctx.activeTurnHadAssistantContent = true;
              if (scopedItemId !== undefined) {
                ctx.activeAssistantItemsWithContent.add(scopedItemId);
              }
            }
            yield* offerRuntimeEvent(
              makeAcpContentDeltaEvent({
                stamp: yield* makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: activeTurnId,
                ...(scopedItemId ? { itemId: scopedItemId } : {}),
                text: event.text,
                ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                rawPayload: event.rawPayload,
              }),
            );
          }
          return;
        case "UsageUpdated":
          {
            const activeTurnId = yield* activeTurnIdForGrokRuntimeEvent(ctx, event._tag);
            if (activeTurnId === undefined) {
              return;
            }
            yield* logNative(ctx.threadId, "session/update", event.rawPayload);
            recordGrokSessionCost(ctx, event.cost);
            yield* offerRuntimeEvent(
              makeAcpTokenUsageEvent({
                stamp: yield* makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: activeTurnId,
                usage: event.usage,
                rawPayload: event.rawPayload,
              }),
            );
          }
          return;
      }
    });
}
