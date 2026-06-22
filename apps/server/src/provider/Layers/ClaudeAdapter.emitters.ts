// Purpose: Runtime-event emitter helpers for the Claude adapter (thread/turn lifecycle, assistant-text blocks, plan/task projection).
// Layer: dependency-parameterized Effect helpers; built once per session-runtime via makeClaudeEmitters(deps).
// Exports: ClaudeEmitters, makeClaudeEmitters.

import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ProviderItemId,
  type ProviderRuntimeTurnStatus,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  type TurnId,
} from "@t3tools/contracts";
import { Effect, Random } from "effect";

import { ProviderAdapterValidationError } from "../Errors.ts";
import { PROVIDER } from "./ClaudeAdapter.config.ts";
import {
  asCanonicalTurnId,
  asRuntimeItemId,
  exitPlanCaptureKey,
  extractAssistantTextBlocks,
  normalizeClaudeTodoTasks,
  sdkNativeItemId,
  sdkNativeMethod,
} from "./ClaudeAdapter.events.ts";
import { resolveEffectiveClaudeContextWindow } from "./ClaudeAdapter.models.ts";
import {
  type ClaudeEmitterDeps,
  type ClaudeSessionContext,
  nativeProviderRefs,
} from "./ClaudeAdapter.runtime.ts";
import {
  maxClaudeContextWindowFromModelUsage,
  mergeClaudeTokenUsageSnapshot,
  normalizeClaudeTokenUsage,
} from "./ClaudeAdapter.token.ts";
import type { AssistantTextBlockState } from "./ClaudeAdapter.types.ts";

export interface ClaudeEmitters {
  readonly logNativeSdkMessage: (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) => Effect.Effect<void>;
  readonly snapshotThread: (context: ClaudeSessionContext) => Effect.Effect<
    {
      threadId: ThreadId;
      turns: ReadonlyArray<{ id: TurnId; items: ReadonlyArray<unknown> }>;
    },
    ProviderAdapterValidationError
  >;
  readonly updateResumeCursor: (context: ClaudeSessionContext) => Effect.Effect<void>;
  readonly ensureAssistantTextBlock: (
    context: ClaudeSessionContext,
    blockIndex: number,
    options?: { readonly fallbackText?: string; readonly streamClosed?: boolean },
  ) => Effect.Effect<
    { readonly blockIndex: number; readonly block: AssistantTextBlockState } | undefined
  >;
  readonly completeAssistantTextBlock: (
    context: ClaudeSessionContext,
    block: AssistantTextBlockState,
    options?: {
      readonly force?: boolean;
      readonly rawMethod?: string;
      readonly rawPayload?: unknown;
    },
  ) => Effect.Effect<void>;
  readonly backfillAssistantTextBlocksFromSnapshot: (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) => Effect.Effect<void>;
  readonly ensureThreadId: (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) => Effect.Effect<void>;
  readonly emitRuntimeError: (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
  ) => Effect.Effect<void>;
  readonly emitRuntimeWarning: (
    context: ClaudeSessionContext,
    message: string,
    detail?: unknown,
  ) => Effect.Effect<void>;
  readonly warnUnhandledSdkKind: (
    context: ClaudeSessionContext,
    kind: string,
    message: string,
    detail: unknown,
  ) => Effect.Effect<void>;
  readonly emitProposedPlanCompleted: (
    context: ClaudeSessionContext,
    input: {
      readonly planMarkdown: string;
      readonly toolUseId?: string | undefined;
      readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) => Effect.Effect<void>;
  readonly emitTodoTasksUpdated: (
    context: ClaudeSessionContext,
    input: {
      readonly toolInput: Record<string, unknown>;
      readonly toolUseId?: string | undefined;
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) => Effect.Effect<void>;
  readonly completeTurn: (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage?: string,
    result?: SDKResultMessage,
  ) => Effect.Effect<void>;
}

export function makeClaudeEmitters(deps: ClaudeEmitterDeps): ClaudeEmitters {
  const { offerRuntimeEvent, makeEventStamp, nowIso, nativeEventLogger } = deps;

  const logNativeSdkMessage = (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!nativeEventLogger) {
        return;
      }

      const observedAt = new Date().toISOString();
      const itemId = sdkNativeItemId(message);

      yield* nativeEventLogger.write(
        {
          observedAt,
          event: {
            id:
              "uuid" in message && typeof message.uuid === "string"
                ? message.uuid
                : crypto.randomUUID(),
            kind: "notification",
            provider: PROVIDER,
            createdAt: observedAt,
            method: sdkNativeMethod(message),
            ...(typeof message.session_id === "string"
              ? { providerThreadId: message.session_id }
              : {}),
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            ...(itemId ? { itemId: ProviderItemId.makeUnsafe(itemId) } : {}),
            payload: message,
          },
        },
        context.session.threadId,
      );
    });

  const snapshotThread = (
    context: ClaudeSessionContext,
  ): Effect.Effect<
    {
      threadId: ThreadId;
      turns: ReadonlyArray<{ id: TurnId; items: ReadonlyArray<unknown> }>;
    },
    ProviderAdapterValidationError
  > =>
    Effect.gen(function* () {
      const threadId = context.session.threadId;
      if (!threadId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "readThread",
          issue: "Session thread id is not initialized yet.",
        });
      }
      return {
        threadId,
        turns: context.turns.map((turn) => ({
          id: turn.id,
          items: [...turn.items],
        })),
      };
    });

  const updateResumeCursor = (context: ClaudeSessionContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      const threadId = context.session.threadId;
      if (!threadId) return;

      const resumeCursor = {
        threadId,
        ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
        ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
        turnCount: context.turns.length,
      };

      context.session = {
        ...context.session,
        resumeCursor,
        updatedAt: yield* nowIso,
      };
    });

  const ensureAssistantTextBlock = (
    context: ClaudeSessionContext,
    blockIndex: number,
    options?: {
      readonly fallbackText?: string;
      readonly streamClosed?: boolean;
    },
  ): Effect.Effect<
    | {
        readonly blockIndex: number;
        readonly block: AssistantTextBlockState;
      }
    | undefined
  > =>
    Effect.gen(function* () {
      const turnState = context.turnState;
      if (!turnState) {
        return undefined;
      }

      const existing = turnState.assistantTextBlocks.get(blockIndex);
      if (existing && !existing.completionEmitted) {
        if (existing.fallbackText.length === 0 && options?.fallbackText) {
          existing.fallbackText = options.fallbackText;
        }
        if (options?.streamClosed) {
          existing.streamClosed = true;
        }
        return { blockIndex, block: existing };
      }

      const block: AssistantTextBlockState = {
        itemId: yield* Random.nextUUIDv4,
        blockIndex,
        emittedTextDelta: false,
        fallbackText: options?.fallbackText ?? "",
        streamClosed: options?.streamClosed ?? false,
        completionEmitted: false,
      };
      turnState.assistantTextBlocks.set(blockIndex, block);
      turnState.assistantTextBlockOrder.push(block);
      return { blockIndex, block };
    });

  const createSyntheticAssistantTextBlock = (
    context: ClaudeSessionContext,
    fallbackText: string,
  ): Effect.Effect<
    | {
        readonly blockIndex: number;
        readonly block: AssistantTextBlockState;
      }
    | undefined
  > =>
    Effect.gen(function* () {
      const turnState = context.turnState;
      if (!turnState) {
        return undefined;
      }

      const blockIndex = turnState.nextSyntheticAssistantBlockIndex;
      turnState.nextSyntheticAssistantBlockIndex -= 1;
      return yield* ensureAssistantTextBlock(context, blockIndex, {
        fallbackText,
        streamClosed: true,
      });
    });

  const completeAssistantTextBlock = (
    context: ClaudeSessionContext,
    block: AssistantTextBlockState,
    options?: {
      readonly force?: boolean;
      readonly rawMethod?: string;
      readonly rawPayload?: unknown;
    },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const turnState = context.turnState;
      if (!turnState || block.completionEmitted) {
        return;
      }

      if (!options?.force && !block.streamClosed) {
        return;
      }

      if (!block.emittedTextDelta && block.fallbackText.length > 0) {
        const deltaStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: deltaStamp.eventId,
          provider: PROVIDER,
          createdAt: deltaStamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          itemId: asRuntimeItemId(block.itemId),
          payload: {
            streamKind: "assistant_text",
            delta: block.fallbackText,
          },
          providerRefs: nativeProviderRefs(context),
          ...(options?.rawMethod || options?.rawPayload
            ? {
                raw: {
                  source: "claude.sdk.message" as const,
                  ...(options.rawMethod ? { method: options.rawMethod } : {}),
                  payload: options?.rawPayload,
                },
              }
            : {}),
        });
      }

      block.completionEmitted = true;
      if (turnState.assistantTextBlocks.get(block.blockIndex) === block) {
        turnState.assistantTextBlocks.delete(block.blockIndex);
      }

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        itemId: asRuntimeItemId(block.itemId),
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
          ...(block.fallbackText.length > 0 ? { detail: block.fallbackText } : {}),
        },
        providerRefs: nativeProviderRefs(context),
        ...(options?.rawMethod || options?.rawPayload
          ? {
              raw: {
                source: "claude.sdk.message" as const,
                ...(options.rawMethod ? { method: options.rawMethod } : {}),
                payload: options?.rawPayload,
              },
            }
          : {}),
      });
    });

  const backfillAssistantTextBlocksFromSnapshot = (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const turnState = context.turnState;
      if (!turnState) {
        return;
      }

      const snapshotTextBlocks = extractAssistantTextBlocks(message);
      if (snapshotTextBlocks.length === 0) {
        return;
      }

      const orderedBlocks = turnState.assistantTextBlockOrder.map((block) => ({
        blockIndex: block.blockIndex,
        block,
      }));

      for (const [position, text] of snapshotTextBlocks.entries()) {
        const existingEntry = orderedBlocks[position];
        const entry =
          existingEntry ??
          (yield* createSyntheticAssistantTextBlock(context, text).pipe(
            Effect.map((created) => {
              if (!created) {
                return undefined;
              }
              orderedBlocks.push(created);
              return created;
            }),
          ));
        if (!entry) {
          continue;
        }

        if (entry.block.fallbackText.length === 0) {
          entry.block.fallbackText = text;
        }

        if (entry.block.streamClosed && !entry.block.completionEmitted) {
          yield* completeAssistantTextBlock(context, entry.block, {
            rawMethod: "claude/assistant",
            rawPayload: message,
          });
        }
      }
    });

  const ensureThreadId = (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (typeof message.session_id !== "string" || message.session_id.length === 0) {
        return;
      }
      if (
        message.type === "system" &&
        (message.subtype === "hook_started" || message.subtype === "hook_response")
      ) {
        return;
      }
      const nextThreadId = message.session_id;
      context.resumeSessionId = message.session_id;
      yield* updateResumeCursor(context);

      if (context.lastThreadStartedId !== nextThreadId) {
        context.lastThreadStartedId = nextThreadId;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "thread.started",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          payload: {
            providerThreadId: nextThreadId,
          },
          providerRefs: {},
          raw: {
            source: "claude.sdk.message",
            method: "claude/thread/started",
            payload: {
              session_id: message.session_id,
            },
          },
        });
      }
    });

  const emitRuntimeError = (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (cause !== undefined) {
        void cause;
      }
      const turnState = context.turnState;
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "runtime.error",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
        payload: {
          message,
          class: "provider_error",
          ...(cause !== undefined ? { detail: cause } : {}),
        },
        providerRefs: nativeProviderRefs(context),
      });
    });

  const emitRuntimeWarning = (
    context: ClaudeSessionContext,
    message: string,
    detail?: unknown,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const turnState = context.turnState;
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "runtime.warning",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
        payload: {
          message,
          ...(detail !== undefined ? { detail } : {}),
        },
        providerRefs: nativeProviderRefs(context),
      });
    });

  // Surfaces each distinct unrecognized SDK message kind at most once per session.
  // Without this, high-frequency telemetry the adapter doesn't model (notably the
  // `thinking_tokens` system subtype streamed on every reasoning tick) turns into a
  // "Runtime warning" timeline entry per message and floods the conversation.
  const warnUnhandledSdkKind = (
    context: ClaudeSessionContext,
    kind: string,
    message: string,
    detail: unknown,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (context.warnedUnhandledSdkKinds.has(kind)) {
        return;
      }
      context.warnedUnhandledSdkKinds.add(kind);
      const turnState = context.turnState;
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "provider.unhandled",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
        payload: {
          nativeEventName: kind,
          reason: "no_mapper",
          redactedPayloadPreview: message,
        },
        providerRefs: nativeProviderRefs(context),
        raw: {
          source: "claude.sdk.message",
          method: kind,
          payload: detail,
        },
      });
    });

  const emitProposedPlanCompleted = (
    context: ClaudeSessionContext,
    input: {
      readonly planMarkdown: string;
      readonly toolUseId?: string | undefined;
      readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const turnState = context.turnState;
      const planMarkdown = input.planMarkdown.trim();
      if (!turnState || planMarkdown.length === 0) {
        return;
      }

      const captureKey = exitPlanCaptureKey({
        toolUseId: input.toolUseId,
        planMarkdown,
      });
      if (turnState.capturedProposedPlanKeys.has(captureKey)) {
        return;
      }
      turnState.capturedProposedPlanKeys.add(captureKey);

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.proposed.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: {
          planMarkdown,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: input.toolUseId,
        }),
        raw: {
          source: input.rawSource,
          method: input.rawMethod,
          payload: input.rawPayload,
        },
      });
    });

  // Normalizes Claude TodoWrite tool calls into the shared runtime task-list event.
  const emitTodoTasksUpdated = (
    context: ClaudeSessionContext,
    input: {
      readonly toolInput: Record<string, unknown>;
      readonly toolUseId?: string | undefined;
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const turnState = context.turnState;
      if (!turnState) {
        return;
      }

      const tasksPayload = normalizeClaudeTodoTasks(input.toolInput);
      if (!tasksPayload) {
        return;
      }

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.tasks.updated",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: tasksPayload,
        providerRefs: nativeProviderRefs(context, {
          providerItemId: input.toolUseId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: input.rawMethod,
          payload: input.rawPayload,
        },
      });
    });

  const completeTurn = (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage?: string,
    result?: SDKResultMessage,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const resultContextWindow = maxClaudeContextWindowFromModelUsage(result?.modelUsage);
      const effectiveContextWindow = resolveEffectiveClaudeContextWindow({
        reportedContextWindow: resultContextWindow,
        lastKnownContextWindow: context.lastKnownContextWindow,
        currentApiModelId: context.currentApiModelId,
      });
      if (effectiveContextWindow !== undefined) {
        context.lastKnownContextWindow = effectiveContextWindow;
      }

      // The SDK result.usage contains *accumulated* totals across all API calls
      // (input_tokens, cache_read_input_tokens, etc. summed over every request).
      // This does NOT represent the current context window size.
      // Instead, use the last known context-window-accurate usage from task_progress
      // events and treat the accumulated total as totalProcessedTokens.
      const accumulatedSnapshot = normalizeClaudeTokenUsage(result?.usage, effectiveContextWindow);
      const lastGoodUsage = context.lastKnownTokenUsage;
      const maxTokens = effectiveContextWindow;
      const usageSnapshot: ThreadTokenUsageSnapshot | undefined = lastGoodUsage
        ? mergeClaudeTokenUsageSnapshot(lastGoodUsage, accumulatedSnapshot, maxTokens)
        : accumulatedSnapshot;

      const turnState = context.turnState;
      if (!turnState) {
        if (usageSnapshot) {
          const usageStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "thread.token-usage.updated",
            eventId: usageStamp.eventId,
            provider: PROVIDER,
            createdAt: usageStamp.createdAt,
            threadId: context.session.threadId,
            payload: {
              usage: usageSnapshot,
            },
            providerRefs: {},
          });
        }

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          payload: {
            state: status,
            ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
            ...(result?.usage ? { usage: result.usage } : {}),
            ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
            ...(typeof result?.total_cost_usd === "number"
              ? { totalCostUsd: result.total_cost_usd }
              : {}),
            ...(errorMessage ? { errorMessage } : {}),
          },
          providerRefs: {},
        });
        return;
      }

      for (const [index, tool] of context.inFlightTools.entries()) {
        const toolStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.completed",
          eventId: toolStamp.eventId,
          provider: PROVIDER,
          createdAt: toolStamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            itemType: tool.itemType,
            status: status === "completed" ? "completed" : "failed",
            title: tool.title,
            ...(tool.detail ? { detail: tool.detail } : {}),
            data: {
              toolName: tool.toolName,
              input: tool.input,
            },
          },
          providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/result",
            payload: result ?? { status },
          },
        });
        if (tool.itemType === "file_change") {
          context.turnState = {
            ...turnState,
            sawFileChange: true,
          };
        }
        context.inFlightTools.delete(index);
      }
      // Clear any remaining stale entries (e.g. from interrupted content blocks)
      context.inFlightTools.clear();

      for (const block of turnState.assistantTextBlockOrder) {
        yield* completeAssistantTextBlock(context, block, {
          force: true,
          rawMethod: "claude/result",
          rawPayload: result ?? { status },
        });
      }

      for (const block of turnState.reasoningBlocks.values()) {
        if (block.completionEmitted) {
          continue;
        }
        block.completionEmitted = true;
        const reasoningStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.completed",
          eventId: reasoningStamp.eventId,
          provider: PROVIDER,
          createdAt: reasoningStamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          itemId: asRuntimeItemId(block.itemId),
          payload: {
            itemType: "reasoning",
            status: status === "completed" ? "completed" : "failed",
            title: "Thinking",
            data: {
              contentIndex: block.blockIndex,
            },
          },
          providerRefs: nativeProviderRefs(context, { providerItemId: block.itemId }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/result",
            payload: result ?? { status },
          },
        });
      }
      turnState.reasoningBlocks.clear();

      context.turns.push({
        id: turnState.turnId,
        items: [...turnState.items],
      });

      if (usageSnapshot) {
        const usageStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "thread.token-usage.updated",
          eventId: usageStamp.eventId,
          provider: PROVIDER,
          createdAt: usageStamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: {
            usage: usageSnapshot,
          },
          providerRefs: nativeProviderRefs(context),
        });
      }

      // Feed Claude edits into the same placeholder checkpoint flow used by Codex.
      if (status === "completed" && turnState.sawFileChange) {
        const diffStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.diff.updated",
          eventId: diffStamp.eventId,
          provider: PROVIDER,
          createdAt: diffStamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: {
            unifiedDiff: "",
          },
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message",
            method: "claude/result",
            payload: result ?? { status },
          },
        });
      }

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: {
          state: status,
          ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
          ...(result?.usage ? { usage: result.usage } : {}),
          ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
          ...(typeof result?.total_cost_usd === "number"
            ? { totalCostUsd: result.total_cost_usd }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
        providerRefs: nativeProviderRefs(context),
      });

      const updatedAt = yield* nowIso;
      if (context.interruptRequestedTurnId === turnState.turnId) {
        context.interruptRequestedTurnId = undefined;
      }
      context.lastThinkingItemId = undefined;
      context.turnState = undefined;
      context.session = {
        ...context.session,
        status: "ready",
        activeTurnId: undefined,
        updatedAt,
        ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
      };
      yield* updateResumeCursor(context);
    });

  return {
    logNativeSdkMessage,
    snapshotThread,
    updateResumeCursor,
    ensureAssistantTextBlock,
    completeAssistantTextBlock,
    backfillAssistantTextBlocksFromSnapshot,
    ensureThreadId,
    emitRuntimeError,
    emitRuntimeWarning,
    warnUnhandledSdkKind,
    emitProposedPlanCompleted,
    emitTodoTasksUpdated,
    completeTurn,
  };
}
