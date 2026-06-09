// Purpose: Pi SDK session-event handling — projects AgentSessionEvents into Synara runtime events.
// Layer: deps-parameterized factory; closes over emitter/snapshot deps, no Effect/Service binding.
// Exports: PiEventHandlerDeps shape and makePiEventHandler(deps) returning handleSessionEvent.

import crypto from "node:crypto";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  type EventId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";

import { classifyPiTurnFailure } from "../piTurnFailure.ts";
import { makeSessionSnapshot } from "./PiAdapter.session.ts";
import { normalizeTokenUsage } from "./PiAdapter.token.ts";
import { textFromToolResult, toolItemType, toolLifecycleData, toolTitle } from "./PiAdapter.tools.ts";
import { type PiSessionContext, type PiTrackedToolCall } from "./PiAdapter.types.ts";

export interface PiEventBase {
  readonly eventId: EventId;
  readonly provider: "pi";
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly turnId?: TurnId;
}

export interface PiEventHandlerDeps {
  readonly makeEventBase: (
    context: PiSessionContext,
    options?: { readonly includeTurnId?: boolean },
  ) => PiEventBase;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => void;
  readonly offerRuntimeError: (
    context: PiSessionContext,
    input: {
      readonly message: string;
      readonly cause?: unknown;
      readonly method: string;
      readonly messageType?: string;
    },
  ) => void;
  readonly recordItem: (context: PiSessionContext, item: unknown) => void;
}

export interface PiEventHandler {
  readonly handleSessionEvent: (context: PiSessionContext, event: AgentSessionEvent) => void;
}

export function makePiEventHandler(deps: PiEventHandlerDeps): PiEventHandler {
  const { makeEventBase, offerRuntimeEvent, offerRuntimeError, recordItem } = deps;

  const handleMessageUpdate = (
    context: PiSessionContext,
    event: Extract<AgentSessionEvent, { type: "message_update" }>,
  ) => {
    if (event.message.role !== "assistant") return;
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") {
      if (!context.activeAssistantItemId) {
        context.activeAssistantItemId = RuntimeItemId.makeUnsafe(
          `pi-assistant-${crypto.randomUUID()}`,
        );
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId: context.activeAssistantItemId,
          type: "item.started",
          payload: { itemType: "assistant_message", status: "inProgress", title: "Assistant" },
          raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
        } satisfies ProviderRuntimeEvent);
      }
      recordItem(context, { type: "assistant_message", delta: update.delta });
      offerRuntimeEvent({
        ...makeEventBase(context),
        itemId: context.activeAssistantItemId,
        type: "content.delta",
        payload: {
          streamKind: "assistant_text",
          delta: update.delta,
          contentIndex: update.contentIndex,
        },
        raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
      } satisfies ProviderRuntimeEvent);
      return;
    }
    if (update.type === "thinking_delta") {
      if (!context.activeReasoningItemId) {
        context.activeReasoningItemId = RuntimeItemId.makeUnsafe(
          `pi-reasoning-${crypto.randomUUID()}`,
        );
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId: context.activeReasoningItemId,
          type: "item.started",
          payload: { itemType: "reasoning", status: "inProgress", title: "Reasoning" },
          raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
        } satisfies ProviderRuntimeEvent);
      }
      recordItem(context, { type: "reasoning", delta: update.delta });
      offerRuntimeEvent({
        ...makeEventBase(context),
        itemId: context.activeReasoningItemId,
        type: "content.delta",
        payload: {
          streamKind: "reasoning_text",
          delta: update.delta,
          contentIndex: update.contentIndex,
        },
        raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
      } satisfies ProviderRuntimeEvent);
    }
  };

  const handleSessionEvent = (context: PiSessionContext, event: AgentSessionEvent) => {
    switch (event.type) {
      case "agent_start":
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "thread.state.changed",
          payload: { state: "active" },
          raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
        } satisfies ProviderRuntimeEvent);
        return;
      case "turn_start":
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "turn.started",
          payload: {
            ...(context.runtime.session.model
              ? {
                  model: `${context.runtime.session.model.provider}/${context.runtime.session.model.id}`,
                }
              : {}),
            effort: context.runtime.session.thinkingLevel,
          },
          raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
        } satisfies ProviderRuntimeEvent);
        return;
      case "message_update":
        handleMessageUpdate(context, event);
        return;
      case "tool_execution_start": {
        const itemId = RuntimeItemId.makeUnsafe(`pi-tool-${event.toolCallId}`);
        const tracked: PiTrackedToolCall = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          itemId,
          itemType: toolItemType(event.toolName),
        };
        context.activeToolItems.set(event.toolCallId, tracked);
        const title = toolTitle(event.toolName, event.args);
        recordItem(context, {
          type: "tool_call",
          status: "started",
          toolName: event.toolName,
          args: event.args,
        });
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId,
          providerRefs: { providerItemId: ProviderItemId.makeUnsafe(event.toolCallId) },
          type: "item.started",
          payload: {
            itemType: tracked.itemType,
            status: "inProgress",
            title,
            data: toolLifecycleData({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
            }),
          },
          raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
        } satisfies ProviderRuntimeEvent);
        return;
      }
      case "tool_execution_update": {
        const tracked = context.activeToolItems.get(event.toolCallId);
        if (!tracked) return;
        const detail = textFromToolResult(event.partialResult);
        recordItem(context, {
          type: "tool_call",
          status: "updated",
          toolName: event.toolName,
          output: detail,
        });
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId: tracked.itemId,
          providerRefs: { providerItemId: ProviderItemId.makeUnsafe(event.toolCallId) },
          type: "item.updated",
          payload: {
            itemType: tracked.itemType,
            status: "inProgress",
            title: toolTitle(event.toolName, tracked.args),
            ...(detail ? { detail } : {}),
            data: toolLifecycleData({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: tracked.args,
              partialResult: event.partialResult,
            }),
          },
          raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
        } satisfies ProviderRuntimeEvent);
        return;
      }
      case "tool_execution_end": {
        const tracked = context.activeToolItems.get(event.toolCallId) ?? {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: undefined,
          itemId: RuntimeItemId.makeUnsafe(`pi-tool-${event.toolCallId}`),
          itemType: toolItemType(event.toolName),
        };
        context.activeToolItems.delete(event.toolCallId);
        const detail = textFromToolResult(event.result);
        recordItem(context, {
          type: "tool_call",
          status: event.isError ? "failed" : "completed",
          toolName: event.toolName,
          output: detail,
          result: event.result,
        });
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId: tracked.itemId,
          providerRefs: { providerItemId: ProviderItemId.makeUnsafe(event.toolCallId) },
          type: "item.completed",
          payload: {
            itemType: tracked.itemType,
            status: event.isError ? "failed" : "completed",
            title: toolTitle(event.toolName, tracked.args),
            ...(detail ? { detail } : {}),
            data: toolLifecycleData({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: tracked.args,
              result: event.result,
              isError: event.isError,
            }),
          },
          raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
        } satisfies ProviderRuntimeEvent);
        return;
      }
      case "compaction_start": {
        const itemId = RuntimeItemId.makeUnsafe(`pi-compaction-${crypto.randomUUID()}`);
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId,
          type: "item.updated",
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            title: "Compacting context",
          },
          raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
        } satisfies ProviderRuntimeEvent);
        return;
      }
      case "compaction_end": {
        const itemId = RuntimeItemId.makeUnsafe(`pi-compaction-${crypto.randomUUID()}`);
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId,
          type: "item.completed",
          payload: {
            itemType: "context_compaction",
            status: event.aborted ? "failed" : "completed",
            title: "Context compacted",
            data: event,
          },
          raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
        } satisfies ProviderRuntimeEvent);
        return;
      }
      case "agent_end": {
        const stats = context.runtime.session.getSessionStats();
        const usage = normalizeTokenUsage(stats, context.runtime.session.model?.contextWindow);
        context.lastKnownTokenUsage = usage;
        const turnId = context.activeTurnId;
        const errorMessage = context.runtime.session.agent.state.errorMessage;
        const failure = errorMessage ? classifyPiTurnFailure(errorMessage) : undefined;
        const leafId = context.runtime.session.sessionManager.getLeafId();
        const turn = turnId
          ? context.turns.find((candidate) => candidate.id === turnId)
          : undefined;
        if (turn) turn.leafId = leafId;
        if (context.activeAssistantItemId) {
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: context.activeAssistantItemId,
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: errorMessage ? "failed" : "completed",
              title: "Assistant",
            },
            raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
        }
        if (context.activeReasoningItemId) {
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: context.activeReasoningItemId,
            type: "item.completed",
            payload: {
              itemType: "reasoning",
              status: errorMessage ? "failed" : "completed",
              title: "Reasoning",
            },
            raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
        }
        if (usage) {
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "thread.token-usage.updated",
            payload: { usage },
            raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
        }
        if (errorMessage && failure?.state === "failed") {
          offerRuntimeError(context, {
            message: errorMessage,
            method: "prompt",
            messageType: event.type,
            cause: event,
          });
        }
        const completionBase = makeEventBase(context);
        context.activeTurnId = undefined;
        context.activeAssistantItemId = undefined;
        context.activeReasoningItemId = undefined;
        context.activeToolItems.clear();
        context.session = makeSessionSnapshot(context);
        offerRuntimeEvent({
          ...completionBase,
          type: "turn.completed",
          payload:
            errorMessage && failure
              ? {
                  state: failure.state,
                  stopReason: failure.stopReason,
                  errorMessage,
                  usage: stats,
                }
              : { state: "completed", stopReason: null, usage: stats },
          raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
        } satisfies ProviderRuntimeEvent);
        return;
      }
      default:
        return;
    }
  };

  return { handleSessionEvent };
}
