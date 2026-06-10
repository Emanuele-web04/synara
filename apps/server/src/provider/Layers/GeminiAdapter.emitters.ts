// Purpose: Runtime-event emitter helpers for the Gemini adapter (session-state, warnings/errors, token usage, assistant/reasoning text deltas, tool lifecycle).
// Layer: dependency-parameterized Effect helpers; built once per adapter via makeGeminiEmitters(deps) with offerRuntimeEvent + makeEventBase captured.
// Exports: GeminiEmitters, GeminiEmittersDeps, makeGeminiEmitters.

import {
  EventId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  type ThreadTokenUsageSnapshot,
  type TurnId,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { trimToUndefined } from "../geminiValue.ts";
import { PROVIDER } from "./GeminiAdapter.config.ts";
import {
  itemTypeFromToolKind,
  statusFromToolStatus,
  toolContentDetail,
  toolDetail,
} from "./GeminiAdapter.events.ts";
import { upsertGeminiTurnItem } from "./GeminiAdapter.state.ts";
import type {
  GeminiRecordedItem,
  GeminiSessionContext,
  GeminiToolCall,
} from "./GeminiAdapter.types.ts";

export interface GeminiEmittersDeps {
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly makeEventBase: (context: GeminiSessionContext) => {
    readonly eventId: EventId;
    readonly provider: typeof PROVIDER;
    readonly threadId: GeminiSessionContext["session"]["threadId"];
    readonly createdAt: string;
  };
}

export interface GeminiEmitters {
  readonly emitSessionState: (
    context: GeminiSessionContext,
    state: "starting" | "ready" | "running" | "stopped" | "error",
    reason?: string,
    detail?: unknown,
  ) => Effect.Effect<void>;
  readonly emitRuntimeWarning: (
    context: GeminiSessionContext,
    message: string,
    raw?: {
      readonly source: "gemini.acp.message" | "gemini.acp.stdout" | "gemini.acp.stderr";
      readonly method?: string;
      readonly payload: unknown;
    },
  ) => Effect.Effect<void>;
  readonly emitRuntimeError: (
    context: GeminiSessionContext,
    message: string,
    detail?: unknown,
    turnId?: TurnId,
  ) => Effect.Effect<void>;
  readonly emitUsage: (
    context: GeminiSessionContext,
    usage: ThreadTokenUsageSnapshot,
    turnId?: TurnId,
    rawPayload?: unknown,
  ) => Effect.Effect<void>;
  readonly emitTextItemStarted: (
    context: GeminiSessionContext,
    streamKind: "assistant_text" | "reasoning_text",
  ) => Effect.Effect<void>;
  readonly emitTextDelta: (
    context: GeminiSessionContext,
    streamKind: "assistant_text" | "reasoning_text",
    delta: string,
    rawPayload: unknown,
  ) => Effect.Effect<void>;
  readonly emitToolLifecycle: (
    context: GeminiSessionContext,
    lifecycle: "item.started" | "item.updated" | "item.completed",
    toolCall: GeminiToolCall,
    rawPayload: unknown,
  ) => Effect.Effect<void>;
}

export function makeGeminiEmitters(deps: GeminiEmittersDeps): GeminiEmitters {
  const { offerRuntimeEvent, makeEventBase } = deps;

  const emitSessionState = Effect.fn("emitSessionState")(function* (
    context: GeminiSessionContext,
    state: "starting" | "ready" | "running" | "stopped" | "error",
    reason?: string,
    detail?: unknown,
  ) {
    yield* offerRuntimeEvent({
      ...makeEventBase(context),
      type: "session.state.changed",
      payload: {
        state,
        ...(reason ? { reason } : {}),
        ...(detail !== undefined ? { detail } : {}),
      },
      ...(detail !== undefined
        ? {
            raw: {
              source: "gemini.acp.message",
              method: "session.state",
              payload: detail,
            },
          }
        : {}),
    });
  });

  const emitRuntimeWarning = Effect.fn("emitRuntimeWarning")(function* (
    context: GeminiSessionContext,
    message: string,
    raw?: {
      readonly source: "gemini.acp.message" | "gemini.acp.stdout" | "gemini.acp.stderr";
      readonly method?: string;
      readonly payload: unknown;
    },
  ) {
    yield* offerRuntimeEvent({
      ...makeEventBase(context),
      type: "runtime.warning",
      payload: { message, ...(raw ? { detail: raw.payload } : {}) },
      ...(raw ? { raw } : {}),
    });
  });

  const emitRuntimeError = Effect.fn("emitRuntimeError")(function* (
    context: GeminiSessionContext,
    message: string,
    detail?: unknown,
    turnId?: TurnId,
  ) {
    yield* offerRuntimeEvent({
      ...makeEventBase(context),
      ...(turnId ? { turnId } : {}),
      type: "runtime.error",
      payload: {
        message,
        class: "provider_error",
        ...(detail !== undefined ? { detail } : {}),
      },
      ...(detail !== undefined
        ? {
            raw: {
              source: "gemini.acp.message",
              method: "runtime.error",
              payload: detail,
            },
          }
        : {}),
    });
  });

  const emitUsage = Effect.fn("emitUsage")(function* (
    context: GeminiSessionContext,
    usage: ThreadTokenUsageSnapshot,
    turnId?: TurnId,
    rawPayload?: unknown,
  ) {
    context.lastKnownTokenUsage = {
      ...context.lastKnownTokenUsage,
      ...usage,
      usedTokens: usage.usedTokens,
    };
    yield* offerRuntimeEvent({
      ...makeEventBase(context),
      ...(turnId ? { turnId } : {}),
      type: "thread.token-usage.updated",
      payload: { usage: context.lastKnownTokenUsage },
      ...(rawPayload !== undefined
        ? {
            raw: {
              source: "gemini.acp.message",
              method: "session/update",
              payload: rawPayload,
            },
          }
        : {}),
    });
  });

  const emitTextItemStarted = Effect.fn("emitTextItemStarted")(function* (
    context: GeminiSessionContext,
    streamKind: "assistant_text" | "reasoning_text",
  ) {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }
    const isAssistant = streamKind === "assistant_text";
    if (
      (isAssistant && turnState.assistantTextStarted) ||
      (!isAssistant && turnState.reasoningTextStarted)
    ) {
      return;
    }

    const itemId = isAssistant
      ? turnState.assistantItemId
      : (turnState.reasoningItemId ??
        RuntimeItemId.makeUnsafe(`gemini-reasoning-${crypto.randomUUID()}`));
    if (!isAssistant) {
      turnState.reasoningItemId = itemId;
      turnState.reasoningTextStarted = true;
    } else {
      turnState.assistantTextStarted = true;
    }

    upsertGeminiTurnItem(turnState, itemId, isAssistant ? "assistant_message" : "reasoning", {
      status: "inProgress",
      title: isAssistant ? "Assistant message" : "Reasoning",
    });

    yield* offerRuntimeEvent({
      ...makeEventBase(context),
      turnId: turnState.turnId,
      itemId,
      type: "item.started",
      payload: {
        itemType: isAssistant ? "assistant_message" : "reasoning",
        status: "inProgress",
        title: isAssistant ? "Assistant message" : "Reasoning",
      },
    });
  });

  const emitTextDelta = Effect.fn("emitTextDelta")(function* (
    context: GeminiSessionContext,
    streamKind: "assistant_text" | "reasoning_text",
    delta: string,
    rawPayload: unknown,
  ) {
    if (delta.length === 0) {
      return;
    }
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }

    yield* emitTextItemStarted(context, streamKind);
    const itemId =
      streamKind === "assistant_text"
        ? turnState.assistantItemId
        : (turnState.reasoningItemId as RuntimeItemId);
    const item = upsertGeminiTurnItem(
      turnState,
      itemId,
      streamKind === "assistant_text" ? "assistant_message" : "reasoning",
      {},
    );
    item.text = `${item.text ?? ""}${delta}`;
    if (streamKind === "assistant_text") {
      turnState.assistantText = `${turnState.assistantText}${delta}`;
    } else {
      turnState.reasoningText = `${turnState.reasoningText}${delta}`;
    }

    yield* offerRuntimeEvent({
      ...makeEventBase(context),
      turnId: turnState.turnId,
      itemId,
      type: "content.delta",
      payload: {
        streamKind,
        delta,
      },
      raw: {
        source: "gemini.acp.message",
        method: "session/update",
        payload: rawPayload,
      },
    });
  });

  const emitToolLifecycle = Effect.fn("emitToolLifecycle")(function* (
    context: GeminiSessionContext,
    lifecycle: "item.started" | "item.updated" | "item.completed",
    toolCall: GeminiToolCall,
    rawPayload: unknown,
  ) {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }
    const providerItemId = trimToUndefined(toolCall.toolCallId);
    if (!providerItemId) {
      return;
    }
    const itemId = RuntimeItemId.makeUnsafe(`gemini-tool-${providerItemId}`);
    const itemType = itemTypeFromToolKind(toolCall.kind ?? undefined);
    const status = statusFromToolStatus(toolCall.status);
    const detail = toolContentDetail(toolCall.content) ?? toolDetail(toolCall);
    const title = trimToUndefined(toolCall.title);
    const toolPatch: Partial<GeminiRecordedItem> = {
      ...(title ? { title } : {}),
      ...(detail ? { detail } : {}),
      ...(status ? { status } : {}),
      data: toolCall,
    };
    upsertGeminiTurnItem(turnState, itemId, itemType, toolPatch);

    yield* offerRuntimeEvent({
      ...makeEventBase(context),
      turnId: turnState.turnId,
      itemId,
      type: lifecycle,
      payload: {
        itemType,
        ...(status ? { status } : {}),
        ...(trimToUndefined(toolCall.title) ? { title: trimToUndefined(toolCall.title) } : {}),
        ...(detail ? { detail } : {}),
        data: toolCall,
      },
      providerRefs: {
        providerItemId: ProviderItemId.makeUnsafe(providerItemId),
      },
      raw: {
        source: "gemini.acp.message",
        method: "session/update",
        payload: rawPayload,
      },
    });
  });

  return {
    emitSessionState,
    emitRuntimeWarning,
    emitRuntimeError,
    emitUsage,
    emitTextItemStarted,
    emitTextDelta,
    emitToolLifecycle,
  };
}
