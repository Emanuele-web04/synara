// Purpose: Cursor ACP notification-stream event handler — projects parsed ACP events into runtime events.
// Layer: deps-parameterized factory; deps carry the session-bound emitters/loggers, handler takes (ctx, event).
// Exports: CursorNotificationHandlerDeps, makeCursorNotificationHandler.

import { type EventId, type ProviderRuntimeEvent, type ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";

import { readAcpFailedToolDetail } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpTokenUsageEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { type AcpParsedSessionEvent } from "../acp/AcpRuntimeModel.ts";

import {
  type CursorSessionContext,
  PROVIDER,
  recordCursorSessionCost,
} from "./CursorAdapter.types.ts";

export interface CursorNotificationHandlerDeps {
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
  readonly logNative: (
    threadId: ThreadId,
    method: string,
    payload: unknown,
    source: "acp.jsonrpc" | "acp.cursor.extension",
  ) => Effect.Effect<void>;
  readonly emitPlanUpdate: (
    ctx: CursorSessionContext,
    payload: {
      readonly explanation?: string | null;
      readonly plan: ReadonlyArray<{
        readonly step: string;
        readonly status: "pending" | "inProgress" | "completed";
      }>;
    },
    rawPayload: unknown,
    source: "acp.jsonrpc" | "acp.cursor.extension",
    method: string,
  ) => Effect.Effect<void>;
}

export function makeCursorNotificationHandler(deps: CursorNotificationHandlerDeps) {
  const { offerRuntimeEvent, makeEventStamp, logNative, emitPlanUpdate } = deps;

  return (ctx: CursorSessionContext, event: AcpParsedSessionEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      switch (event._tag) {
        case "ModeChanged":
          return;
        case "AssistantItemStarted":
          yield* offerRuntimeEvent(
            makeAcpAssistantItemEvent({
              stamp: yield* makeEventStamp(),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              itemId: event.itemId,
              lifecycle: "item.started",
            }),
          );
          return;
        case "AssistantItemCompleted":
          yield* offerRuntimeEvent(
            makeAcpAssistantItemEvent({
              stamp: yield* makeEventStamp(),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              itemId: event.itemId,
              lifecycle: "item.completed",
            }),
          );
          return;
        case "PlanUpdated":
          yield* logNative(ctx.threadId, "session/update", event.rawPayload, "acp.jsonrpc");
          yield* emitPlanUpdate(
            ctx,
            event.payload,
            event.rawPayload,
            "acp.jsonrpc",
            "session/update",
          );
          return;
        case "ToolCallUpdated":
          yield* logNative(ctx.threadId, "session/update", event.rawPayload, "acp.jsonrpc");
          const failedToolDetail = readAcpFailedToolDetail(event.toolCall);
          if (failedToolDetail !== undefined && ctx.activeTurnId !== undefined) {
            ctx.activeTurnFailedToolDetail = failedToolDetail;
          }
          yield* offerRuntimeEvent(
            makeAcpToolCallEvent({
              stamp: yield* makeEventStamp(),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              toolCall: event.toolCall,
              rawPayload: event.rawPayload,
            }),
          );
          return;
        case "ContentDelta":
          yield* logNative(ctx.threadId, "session/update", event.rawPayload, "acp.jsonrpc");
          yield* offerRuntimeEvent(
            makeAcpContentDeltaEvent({
              stamp: yield* makeEventStamp(),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              ...(event.itemId ? { itemId: event.itemId } : {}),
              text: event.text,
              ...(event.streamKind ? { streamKind: event.streamKind } : {}),
              rawPayload: event.rawPayload,
            }),
          );
          return;
        case "UsageUpdated":
          yield* logNative(ctx.threadId, "session/update", event.rawPayload, "acp.jsonrpc");
          recordCursorSessionCost(ctx, event.cost);
          yield* offerRuntimeEvent(
            makeAcpTokenUsageEvent({
              stamp: yield* makeEventStamp(),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              usage: event.usage,
              rawPayload: event.rawPayload,
            }),
          );
          return;
      }
    });
}
