// Purpose: Inbound ACP message handlers for the Gemini adapter (permission requests, session/update projection, JSON-RPC response/notification dispatch).
// Layer: dependency-parameterized Effect helpers; built once per adapter via makeGeminiMessageHandlers(deps) with emitters + event base captured.
// Exports: GeminiMessageHandlers, GeminiMessageHandlersDeps, makeGeminiMessageHandlers.

import {
  ApprovalRequestId,
  type EventId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  RuntimeRequestId,
  type ThreadTokenUsageSnapshot,
  type TurnId,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { ProviderAdapterRequestError } from "../Errors.ts";
import { asArray, asRecord, trimToUndefined } from "../geminiValue.ts";
import { PROVIDER } from "./GeminiAdapter.config.ts";
import {
  isAskUserToolCall,
  parsePermissionOptions,
  parseToolCall,
  requestTypeFromToolKind,
  textFromContentBlock,
  toolContentDetail,
  toolDetail,
} from "./GeminiAdapter.events.ts";
import { currentGeminiTurnId } from "./GeminiAdapter.state.ts";
import { normalizeUsageUpdate } from "./GeminiAdapter.token.ts";
import type { GeminiSessionContext, GeminiToolCall, JsonRpcId } from "./GeminiAdapter.types.ts";

export interface GeminiMessageHandlersDeps {
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly makeEventBase: (context: GeminiSessionContext) => {
    readonly eventId: EventId;
    readonly provider: typeof PROVIDER;
    readonly threadId: GeminiSessionContext["session"]["threadId"];
    readonly createdAt: string;
  };
  readonly emitToolLifecycle: (
    context: GeminiSessionContext,
    lifecycle: "item.started" | "item.updated" | "item.completed",
    toolCall: GeminiToolCall,
    rawPayload: unknown,
  ) => Effect.Effect<void>;
  readonly emitTextDelta: (
    context: GeminiSessionContext,
    streamKind: "assistant_text" | "reasoning_text",
    delta: string,
    rawPayload: unknown,
  ) => Effect.Effect<void>;
  readonly emitUsage: (
    context: GeminiSessionContext,
    usage: ThreadTokenUsageSnapshot,
    turnId?: TurnId,
    rawPayload?: unknown,
  ) => Effect.Effect<void>;
}

export type GeminiMessageHandlers = ReturnType<typeof makeGeminiMessageHandlers>;

export function makeGeminiMessageHandlers(deps: GeminiMessageHandlersDeps) {
  const { offerRuntimeEvent, makeEventBase, emitToolLifecycle, emitTextDelta, emitUsage } = deps;

  const handlePermissionRequest = Effect.fn("handlePermissionRequest")(function* (
    context: GeminiSessionContext,
    requestId: JsonRpcId,
    params: unknown,
  ) {
    const record = asRecord(params);
    const toolCall = parseToolCall(record?.toolCall);
    const requestType = requestTypeFromToolKind(toolCall?.kind ?? undefined);
    const detail = isAskUserToolCall(toolCall)
      ? "Gemini CLI requested user input, but Gemini ACP did not include the question payload. Accepting this request will continue with an empty answer set."
      : (toolContentDetail(toolCall?.content) ?? toolDetail(toolCall ?? { toolCallId: "" }));
    const approvalRequestId = ApprovalRequestId.makeUnsafe(
      `gemini-approval-${crypto.randomUUID()}`,
    );
    context.pendingApprovals.set(approvalRequestId, {
      acpRequestId: requestId,
      options: parsePermissionOptions(record?.options),
      requestType,
      ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
      ...(toolCall?.toolCallId ? { providerItemId: toolCall.toolCallId } : {}),
      ...(detail ? { detail } : {}),
    });

    if (toolCall) {
      yield* emitToolLifecycle(
        context,
        context.turnState?.items.some((item) => item.id === `gemini-tool-${toolCall.toolCallId}`)
          ? "item.updated"
          : "item.started",
        toolCall,
        params,
      );
    }

    yield* offerRuntimeEvent({
      ...makeEventBase(context),
      ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
      requestId: RuntimeRequestId.makeUnsafe(approvalRequestId),
      type: "request.opened",
      payload: {
        requestType,
        ...(detail ? { detail } : {}),
        args: {
          ...(toolCall ? { toolCall } : {}),
          options: record?.options,
        },
      },
      providerRefs: {
        providerRequestId: String(requestId),
        ...(toolCall?.toolCallId
          ? { providerItemId: ProviderItemId.makeUnsafe(toolCall.toolCallId) }
          : {}),
      },
      raw: {
        source: "gemini.acp.message",
        method: "session/request_permission",
        payload: params,
      },
    });
  });

  const handleSessionUpdate = Effect.fn("handleSessionUpdate")(function* (
    context: GeminiSessionContext,
    update: unknown,
    rawPayload: unknown,
  ) {
    const record = asRecord(update);
    const sessionUpdate = trimToUndefined(record?.sessionUpdate);
    if (!sessionUpdate) {
      return;
    }

    switch (sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const delta = textFromContentBlock(record?.content);
        if (!delta) {
          return;
        }
        yield* emitTextDelta(
          context,
          sessionUpdate === "agent_message_chunk" ? "assistant_text" : "reasoning_text",
          delta,
          rawPayload,
        );
        return;
      }

      case "tool_call": {
        const toolCall = parseToolCall(record);
        if (toolCall) {
          yield* emitToolLifecycle(context, "item.started", toolCall, rawPayload);
        }
        return;
      }

      case "tool_call_update": {
        const toolCall = parseToolCall(record);
        if (!toolCall) {
          return;
        }
        const lifecycle =
          toolCall.status === "completed" || toolCall.status === "failed"
            ? "item.completed"
            : "item.updated";
        yield* emitToolLifecycle(context, lifecycle, toolCall, rawPayload);
        return;
      }

      case "plan": {
        const entries = asArray(record?.entries) ?? [];
        if (!context.turnState) {
          return;
        }
        yield* offerRuntimeEvent({
          ...makeEventBase(context),
          turnId: context.turnState.turnId,
          type: "turn.tasks.updated",
          payload: {
            tasks: entries
              .map((entry) => {
                const taskEntry = asRecord(entry);
                const task = trimToUndefined(taskEntry?.content);
                const status = trimToUndefined(taskEntry?.status);
                if (!task || !status) {
                  return null;
                }
                return {
                  task,
                  status:
                    status === "in_progress"
                      ? "inProgress"
                      : status === "completed"
                        ? "completed"
                        : "pending",
                } as const;
              })
              .filter(
                (
                  entry,
                ): entry is { task: string; status: "pending" | "inProgress" | "completed" } =>
                  entry !== null,
              ),
          },
          raw: {
            source: "gemini.acp.message",
            method: "session/update",
            payload: rawPayload,
          },
        });
        return;
      }

      case "usage_update": {
        const usage = normalizeUsageUpdate(record);
        if (usage) {
          yield* emitUsage(context, usage, currentGeminiTurnId(context), rawPayload);
        }
        return;
      }

      case "current_mode_update": {
        context.currentModeId = trimToUndefined(record?.currentModeId) ?? context.currentModeId;
        return;
      }

      case "session_info_update": {
        const title = trimToUndefined(record?.title);
        if (!title) {
          return;
        }
        const updatedAt = trimToUndefined(record?.updatedAt);
        yield* offerRuntimeEvent({
          ...makeEventBase(context),
          type: "thread.metadata.updated",
          payload: {
            name: title,
            ...(updatedAt ? { metadata: { updatedAt } } : {}),
          },
          raw: {
            source: "gemini.acp.message",
            method: "session/update",
            payload: rawPayload,
          },
        });
        return;
      }

      case "available_commands_update":
      case "config_option_update":
      default:
        return;
    }
  });

  const handleParsedMessage = Effect.fn("handleParsedMessage")(function* (
    context: GeminiSessionContext,
    parsed: Record<string, unknown>,
  ) {
    const maybeId = parsed.id;
    if (
      (typeof maybeId === "number" || typeof maybeId === "string") &&
      (Object.hasOwn(parsed, "result") || Object.hasOwn(parsed, "error"))
    ) {
      const pending = context.pending.get(String(maybeId));
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      context.pending.delete(String(maybeId));
      const error = asRecord(parsed.error);
      if (error) {
        pending.reject(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: pending.method,
            detail: trimToUndefined(error.message) ?? `${pending.method} failed`,
            cause: parsed.error,
          }),
        );
        return;
      }
      pending.resolve(parsed.result);
      return;
    }

    const method = trimToUndefined(parsed.method);
    if (!method) {
      return;
    }

    if (method === "session/update") {
      if (context.suppressSessionUpdates) {
        return;
      }
      const params = asRecord(parsed.params);
      yield* handleSessionUpdate(context, params?.update, parsed.params);
      return;
    }

    if (method === "session/request_permission") {
      const requestId = parsed.id;
      if (requestId === undefined || requestId === null) {
        return;
      }
      yield* handlePermissionRequest(context, requestId as JsonRpcId, parsed.params);
    }
  });

  return { handleParsedMessage };
}
