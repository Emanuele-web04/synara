// Purpose: SDK message/stream handlers for the Claude adapter (stream_event, user/assistant/result/system, telemetry, dispatch).
// Layer: dependency-parameterized Effect helpers; built once per session-runtime via makeClaudeMessageHandlers(deps).
// Exports: ClaudeMessageHandlers, makeClaudeMessageHandlers.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { RuntimeTaskId, TurnId } from "@t3tools/contracts";
import type { Effect as EffectType } from "effect";
import { Effect, Random } from "effect";

import { extractProposedPlanMarkdown } from "../planMode.ts";
import { PROVIDER } from "./ClaudeAdapter.config.ts";
import {
  asCanonicalTurnId,
  asRuntimeItemId,
  classifyToolItemType,
  extractContentBlockText,
  extractExitPlanModePlan,
  extractTextContent,
  normalizeClaudeUserVisibleErrorMessage,
  sdkNativeMethod,
  streamKindFromDeltaType,
  summarizeToolRequest,
  titleForTool,
  toolInputFingerprint,
  toolResultBlocksFromUserMessage,
  toolResultStreamKind,
  tryParseJsonRecord,
  turnStatusFromResult,
} from "./ClaudeAdapter.events.ts";
import type { ClaudeEmitters } from "./ClaudeAdapter.emitters.ts";
import {
  type ClaudeEmitterDeps,
  type ClaudeSessionContext,
  hasPendingUserInterrupt,
  nativeProviderRefs,
} from "./ClaudeAdapter.runtime.ts";
import { normalizeClaudeTokenUsage } from "./ClaudeAdapter.token.ts";
import type { AssistantTextBlockState, ToolInFlight } from "./ClaudeAdapter.types.ts";

export interface ClaudeMessageHandlersDeps {
  readonly emitters: ClaudeEmitters;
  readonly offerRuntimeEvent: ClaudeEmitterDeps["offerRuntimeEvent"];
  readonly makeEventStamp: ClaudeEmitterDeps["makeEventStamp"];
  readonly nowIso: ClaudeEmitterDeps["nowIso"];
}

export interface ClaudeMessageHandlers {
  readonly handleSdkMessage: (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) => EffectType.Effect<void>;
}

export function makeClaudeMessageHandlers(deps: ClaudeMessageHandlersDeps): ClaudeMessageHandlers {
  const { offerRuntimeEvent, makeEventStamp, nowIso } = deps;
  const {
    logNativeSdkMessage,
    updateResumeCursor,
    ensureAssistantTextBlock,
    completeAssistantTextBlock,
    backfillAssistantTextBlocksFromSnapshot,
    ensureThreadId,
    emitRuntimeError,
    warnUnhandledSdkKind,
    emitProposedPlanCompleted,
    emitTodoTasksUpdated,
    completeTurn,
  } = deps.emitters;

  const handleStreamEvent = (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (message.type !== "stream_event") {
        return;
      }

      const { event } = message;

      if (event.type === "content_block_delta") {
        if (
          (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") &&
          context.turnState
        ) {
          const deltaText =
            event.delta.type === "text_delta"
              ? event.delta.text
              : typeof event.delta.thinking === "string"
                ? event.delta.thinking
                : "";
          if (deltaText.length === 0) {
            return;
          }
          const streamKind = streamKindFromDeltaType(event.delta.type);
          const assistantBlockEntry =
            event.delta.type === "text_delta"
              ? yield* ensureAssistantTextBlock(context, event.index)
              : context.turnState.assistantTextBlocks.get(event.index)
                ? {
                    blockIndex: event.index,
                    block: context.turnState.assistantTextBlocks.get(
                      event.index,
                    ) as AssistantTextBlockState,
                  }
                : undefined;
          if (assistantBlockEntry?.block && event.delta.type === "text_delta") {
            assistantBlockEntry.block.emittedTextDelta = true;
          }
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "content.delta",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            turnId: context.turnState.turnId,
            ...(assistantBlockEntry?.block
              ? { itemId: asRuntimeItemId(assistantBlockEntry.block.itemId) }
              : {}),
            payload: {
              streamKind,
              delta: deltaText,
            },
            providerRefs: nativeProviderRefs(context),
            raw: {
              source: "claude.sdk.message",
              method: "claude/stream_event/content_block_delta",
              payload: message,
            },
          });
          return;
        }

        if (event.delta.type === "input_json_delta") {
          const tool = context.inFlightTools.get(event.index);
          if (!tool || typeof event.delta.partial_json !== "string") {
            return;
          }

          const partialInputJson = tool.partialInputJson + event.delta.partial_json;
          const parsedInput = tryParseJsonRecord(partialInputJson);
          const detail = parsedInput
            ? summarizeToolRequest(tool.toolName, parsedInput)
            : tool.detail;
          let nextTool: ToolInFlight = {
            ...tool,
            partialInputJson,
            ...(parsedInput ? { input: parsedInput } : {}),
            ...(detail ? { detail } : {}),
          };

          const nextFingerprint =
            parsedInput && Object.keys(parsedInput).length > 0
              ? toolInputFingerprint(parsedInput)
              : undefined;
          context.inFlightTools.set(event.index, nextTool);

          if (
            !parsedInput ||
            !nextFingerprint ||
            tool.lastEmittedInputFingerprint === nextFingerprint
          ) {
            return;
          }

          nextTool = {
            ...nextTool,
            lastEmittedInputFingerprint: nextFingerprint,
          };
          context.inFlightTools.set(event.index, nextTool);

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.updated",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            itemId: asRuntimeItemId(nextTool.itemId),
            payload: {
              itemType: nextTool.itemType,
              status: "inProgress",
              title: nextTool.title,
              ...(nextTool.detail ? { detail: nextTool.detail } : {}),
              data: {
                toolName: nextTool.toolName,
                input: nextTool.input,
              },
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: nextTool.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/stream_event/content_block_delta/input_json_delta",
              payload: message,
            },
          });
          if (nextTool.toolName === "TodoWrite") {
            yield* emitTodoTasksUpdated(context, {
              toolInput: nextTool.input,
              toolUseId: nextTool.itemId,
              rawMethod: "claude/stream_event/content_block_delta/input_json_delta",
              rawPayload: message,
            });
          }
        }
        return;
      }

      if (event.type === "content_block_start") {
        const { index, content_block: block } = event;
        if (block.type === "text") {
          yield* ensureAssistantTextBlock(context, index, {
            fallbackText: extractContentBlockText(block),
          });
          return;
        }
        if (
          block.type !== "tool_use" &&
          block.type !== "server_tool_use" &&
          block.type !== "mcp_tool_use"
        ) {
          return;
        }
        const toolName = block.name;
        const itemType = classifyToolItemType(toolName);
        const toolInput =
          typeof block.input === "object" && block.input !== null
            ? (block.input as Record<string, unknown>)
            : {};
        const itemId = block.id;
        const detail = summarizeToolRequest(toolName, toolInput);
        const inputFingerprint =
          Object.keys(toolInput).length > 0 ? toolInputFingerprint(toolInput) : undefined;

        const tool: ToolInFlight = {
          itemId,
          itemType,
          toolName,
          title: titleForTool(itemType),
          detail,
          input: toolInput,
          partialInputJson: "",
          ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
        };
        context.inFlightTools.set(index, tool);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.started",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            itemType: tool.itemType,
            status: "inProgress",
            title: tool.title,
            ...(tool.detail ? { detail: tool.detail } : {}),
            data: {
              toolName: tool.toolName,
              input: toolInput,
            },
          },
          providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_start",
            payload: message,
          },
        });
        if (toolName === "TodoWrite") {
          yield* emitTodoTasksUpdated(context, {
            toolInput,
            toolUseId: tool.itemId,
            rawMethod: "claude/stream_event/content_block_start",
            rawPayload: message,
          });
        }
        return;
      }

      if (event.type === "content_block_stop") {
        const { index } = event;
        const assistantBlock = context.turnState?.assistantTextBlocks.get(index);
        if (assistantBlock) {
          assistantBlock.streamClosed = true;
          yield* completeAssistantTextBlock(context, assistantBlock, {
            rawMethod: "claude/stream_event/content_block_stop",
            rawPayload: message,
          });
          return;
        }
        const tool = context.inFlightTools.get(index);
        if (!tool) {
          return;
        }
      }
    });

  const handleUserMessage = (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (message.type !== "user") {
        return;
      }

      if (context.turnState) {
        context.turnState.items.push(message.message);
      }

      for (const toolResult of toolResultBlocksFromUserMessage(message)) {
        const toolEntry = Array.from(context.inFlightTools.entries()).find(
          ([, tool]) => tool.itemId === toolResult.toolUseId,
        );
        if (!toolEntry) {
          continue;
        }

        const [index, tool] = toolEntry;
        const itemStatus = toolResult.isError ? "failed" : "completed";
        const toolData = {
          toolName: tool.toolName,
          input: tool.input,
          result: toolResult.block,
        };

        const updatedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.updated",
          eventId: updatedStamp.eventId,
          provider: PROVIDER,
          createdAt: updatedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            itemType: tool.itemType,
            status: toolResult.isError ? "failed" : "inProgress",
            title: tool.title,
            ...(tool.detail ? { detail: tool.detail } : {}),
            data: toolData,
          },
          providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/user",
            payload: message,
          },
        });

        const streamKind = toolResultStreamKind(tool.itemType);
        if (streamKind && toolResult.text.length > 0 && context.turnState) {
          const deltaStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "content.delta",
            eventId: deltaStamp.eventId,
            provider: PROVIDER,
            createdAt: deltaStamp.createdAt,
            threadId: context.session.threadId,
            turnId: context.turnState.turnId,
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              streamKind,
              delta: toolResult.text,
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/user",
              payload: message,
            },
          });
        }

        const completedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.completed",
          eventId: completedStamp.eventId,
          provider: PROVIDER,
          createdAt: completedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            itemType: tool.itemType,
            status: itemStatus,
            title: tool.title,
            ...(tool.detail ? { detail: tool.detail } : {}),
            data: toolData,
          },
          providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/user",
            payload: message,
          },
        });

        if (tool.itemType === "file_change" && context.turnState) {
          context.turnState = {
            ...context.turnState,
            sawFileChange: true,
          };
        }
        context.inFlightTools.delete(index);
      }
    });

  const handleAssistantMessage = (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (message.type !== "assistant") {
        return;
      }

      // Auto-start a synthetic turn for assistant messages that arrive without
      // an active turn (e.g., background agent/subagent responses between user prompts).
      if (!context.turnState) {
        const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
        const startedAt = yield* nowIso;
        context.turnState = {
          turnId,
          startedAt,
          interactionMode: "default",
          items: [],
          assistantTextBlocks: new Map(),
          assistantTextBlockOrder: [],
          capturedProposedPlanKeys: new Set(),
          sawFileChange: false,
          nextSyntheticAssistantBlockIndex: -1,
        };
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: startedAt,
        };
        const turnStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.started",
          eventId: turnStartedStamp.eventId,
          provider: PROVIDER,
          createdAt: turnStartedStamp.createdAt,
          threadId: context.session.threadId,
          turnId,
          payload: {},
          providerRefs: {
            ...nativeProviderRefs(context),
            providerTurnId: turnId,
          },
          raw: {
            source: "claude.sdk.message",
            method: "claude/synthetic-turn-start",
            payload: {},
          },
        });
      }
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") {
            continue;
          }
          const toolUse = block as {
            type?: unknown;
            id?: unknown;
            name?: unknown;
            input?: unknown;
          };
          if (toolUse.type !== "tool_use" || toolUse.name !== "ExitPlanMode") {
            continue;
          }
          const planMarkdown = extractExitPlanModePlan(toolUse.input);
          if (!planMarkdown) {
            continue;
          }
          yield* emitProposedPlanCompleted(context, {
            planMarkdown,
            toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
            rawSource: "claude.sdk.message",
            rawMethod: "claude/assistant",
            rawPayload: message,
          });
        }

        const taggedPlanMarkdown =
          context.turnState?.interactionMode === "plan"
            ? extractProposedPlanMarkdown(extractTextContent(content))
            : undefined;
        if (taggedPlanMarkdown) {
          yield* emitProposedPlanCompleted(context, {
            planMarkdown: taggedPlanMarkdown,
            rawSource: "claude.sdk.message",
            rawMethod: "claude/assistant/proposed-plan-block",
            rawPayload: message,
          });
        }
      }

      if (context.turnState) {
        context.turnState.items.push(message.message);
        yield* backfillAssistantTextBlocksFromSnapshot(context, message);
      }

      // Capture per-API-call usage from the assistant response for accurate
      // context window tracking. Unlike task_progress (accumulated per-task),
      // this reflects the actual prompt + output size for this single API call.
      const perCallUsage = (message.message as { usage?: unknown } | undefined)?.usage;
      if (perCallUsage) {
        const normalizedPerCallUsage = normalizeClaudeTokenUsage(
          perCallUsage as Record<string, unknown>,
          context.lastKnownContextWindow,
        );
        if (normalizedPerCallUsage) {
          context.lastKnownTokenUsage = normalizedPerCallUsage;
          const usageStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "thread.token-usage.updated",
            eventId: usageStamp.eventId,
            provider: PROVIDER,
            createdAt: usageStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            payload: { usage: normalizedPerCallUsage },
            providerRefs: nativeProviderRefs(context),
            raw: {
              source: "claude.sdk.message",
              method: "claude/assistant-usage",
              payload: perCallUsage,
            },
          });
        }
      }

      context.lastAssistantUuid = message.uuid;
      yield* updateResumeCursor(context);
    });

  const handleResultMessage = (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (message.type !== "result") {
        return;
      }

      const status =
        hasPendingUserInterrupt(context) && message.subtype === "error_during_execution"
          ? "interrupted"
          : turnStatusFromResult(message);
      const errorMessage =
        message.subtype === "success"
          ? undefined
          : normalizeClaudeUserVisibleErrorMessage(message.errors[0], status);

      if (status === "failed") {
        yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
      }

      yield* completeTurn(context, status, errorMessage, message);
    });

  const handleSystemMessage = (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (message.type !== "system") {
        return;
      }

      // Benign high-frequency telemetry we intentionally don't project. `thinking_tokens`
      // streams on every reasoning tick while extended thinking is active; `task_updated`
      // is an incremental task patch already covered by task_started/progress/completed.
      // Short-circuit before allocating an event stamp so they can't flood the timeline
      // (or churn allocations) with "Runtime warning" entries.
      if (message.subtype === "thinking_tokens" || message.subtype === "task_updated") {
        return;
      }

      const stamp = yield* makeEventStamp();
      const base = {
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        providerRefs: nativeProviderRefs(context),
        raw: {
          source: "claude.sdk.message" as const,
          method: sdkNativeMethod(message),
          messageType: `${message.type}:${message.subtype}`,
          payload: message,
        },
      };

      switch (message.subtype) {
        case "init":
          yield* offerRuntimeEvent({
            ...base,
            type: "session.configured",
            payload: {
              config: message as Record<string, unknown>,
            },
          });
          return;
        case "status":
          yield* offerRuntimeEvent({
            ...base,
            type: "session.state.changed",
            payload: {
              state: message.status === "compacting" ? "waiting" : "running",
              reason: `status:${message.status ?? "active"}`,
              detail: message,
            },
          });
          return;
        case "compact_boundary":
          yield* offerRuntimeEvent({
            ...base,
            type: "thread.state.changed",
            payload: {
              state: "compacted",
              detail: message,
            },
          });
          return;
        case "hook_started":
          yield* offerRuntimeEvent({
            ...base,
            type: "hook.started",
            payload: {
              hookId: message.hook_id,
              hookName: message.hook_name,
              hookEvent: message.hook_event,
            },
          });
          return;
        case "hook_progress":
          yield* offerRuntimeEvent({
            ...base,
            type: "hook.progress",
            payload: {
              hookId: message.hook_id,
              output: message.output,
              stdout: message.stdout,
              stderr: message.stderr,
            },
          });
          return;
        case "hook_response":
          yield* offerRuntimeEvent({
            ...base,
            type: "hook.completed",
            payload: {
              hookId: message.hook_id,
              outcome: message.outcome,
              output: message.output,
              stdout: message.stdout,
              stderr: message.stderr,
              ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
            },
          });
          return;
        case "task_started":
          yield* offerRuntimeEvent({
            ...base,
            type: "task.started",
            payload: {
              taskId: RuntimeTaskId.makeUnsafe(message.task_id),
              description: message.description,
              ...(message.task_type ? { taskType: message.task_type } : {}),
            },
          });
          return;
        case "task_progress":
          if (message.usage) {
            const normalizedUsage = normalizeClaudeTokenUsage(
              message.usage,
              context.lastKnownContextWindow,
            );
            if (normalizedUsage) {
              context.lastKnownTokenUsage = normalizedUsage;
              const usageStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                ...base,
                eventId: usageStamp.eventId,
                createdAt: usageStamp.createdAt,
                type: "thread.token-usage.updated",
                payload: {
                  usage: normalizedUsage,
                },
              });
            }
          }
          yield* offerRuntimeEvent({
            ...base,
            type: "task.progress",
            payload: {
              taskId: RuntimeTaskId.makeUnsafe(message.task_id),
              description: message.description,
              ...(message.summary ? { summary: message.summary } : {}),
              ...(message.usage ? { usage: message.usage } : {}),
              ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
            },
          });
          return;
        case "task_notification":
          if (message.usage) {
            const normalizedUsage = normalizeClaudeTokenUsage(
              message.usage,
              context.lastKnownContextWindow,
            );
            if (normalizedUsage) {
              context.lastKnownTokenUsage = normalizedUsage;
              const usageStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                ...base,
                eventId: usageStamp.eventId,
                createdAt: usageStamp.createdAt,
                type: "thread.token-usage.updated",
                payload: {
                  usage: normalizedUsage,
                },
              });
            }
          }
          yield* offerRuntimeEvent({
            ...base,
            type: "task.completed",
            payload: {
              taskId: RuntimeTaskId.makeUnsafe(message.task_id),
              status: message.status,
              ...(message.summary ? { summary: message.summary } : {}),
              ...(message.usage ? { usage: message.usage } : {}),
            },
          });
          return;
        case "files_persisted":
          yield* offerRuntimeEvent({
            ...base,
            type: "files.persisted",
            payload: {
              files: Array.isArray(message.files)
                ? message.files.map((file: { filename: string; file_id: string }) => ({
                    filename: file.filename,
                    fileId: file.file_id,
                  }))
                : [],
              ...(Array.isArray(message.failed)
                ? {
                    failed: message.failed.map((entry: { filename: string; error: string }) => ({
                      filename: entry.filename,
                      error: entry.error,
                    })),
                  }
                : {}),
            },
          });
          return;
        default:
          yield* warnUnhandledSdkKind(
            context,
            `system:${message.subtype}`,
            `Unhandled Claude system message subtype '${message.subtype}'.`,
            message,
          );
          return;
      }
    });

  const handleSdkTelemetryMessage = (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const stamp = yield* makeEventStamp();
      const base = {
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        providerRefs: nativeProviderRefs(context),
        raw: {
          source: "claude.sdk.message" as const,
          method: sdkNativeMethod(message),
          messageType: message.type,
          payload: message,
        },
      };

      if (message.type === "tool_progress") {
        yield* offerRuntimeEvent({
          ...base,
          type: "tool.progress",
          payload: {
            toolUseId: message.tool_use_id,
            toolName: message.tool_name,
            elapsedSeconds: message.elapsed_time_seconds,
            ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
          },
        });
        return;
      }

      if (message.type === "tool_use_summary") {
        yield* offerRuntimeEvent({
          ...base,
          type: "tool.summary",
          payload: {
            summary: message.summary,
            ...(message.preceding_tool_use_ids.length > 0
              ? { precedingToolUseIds: message.preceding_tool_use_ids }
              : {}),
          },
        });
        return;
      }

      if (message.type === "auth_status") {
        yield* offerRuntimeEvent({
          ...base,
          type: "auth.status",
          payload: {
            isAuthenticating: message.isAuthenticating,
            output: message.output,
            ...(message.error ? { error: message.error } : {}),
          },
        });
        return;
      }

      if (message.type === "rate_limit_event") {
        yield* offerRuntimeEvent({
          ...base,
          type: "account.rate-limits.updated",
          payload: {
            rateLimits: message,
          },
        });
        return;
      }
    });

  const handleSdkMessage = (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* logNativeSdkMessage(context, message);
      yield* ensureThreadId(context, message);

      switch (message.type) {
        case "stream_event":
          yield* handleStreamEvent(context, message);
          return;
        case "user":
          yield* handleUserMessage(context, message);
          return;
        case "assistant":
          yield* handleAssistantMessage(context, message);
          return;
        case "result":
          yield* handleResultMessage(context, message);
          return;
        case "system":
          yield* handleSystemMessage(context, message);
          return;
        case "tool_progress":
        case "tool_use_summary":
        case "auth_status":
        case "rate_limit_event":
          yield* handleSdkTelemetryMessage(context, message);
          return;
        default:
          yield* warnUnhandledSdkKind(
            context,
            `type:${message.type}`,
            `Unhandled Claude SDK message type '${message.type}'.`,
            message,
          );
          return;
      }
    });

  return { handleSdkMessage };
}
