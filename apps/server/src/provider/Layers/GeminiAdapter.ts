/**
 * GeminiAdapterLive - Scoped live implementation for the Gemini provider adapter.
 *
 * Wraps Gemini CLI ACP sessions behind the generic provider adapter contract
 * and emits canonical provider runtime events.
 *
 * @module GeminiAdapterLive
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import {
  ApprovalRequestId,
  type CanonicalItemType,
  EventId,
  MODEL_OPTIONS_BY_PROVIDER,
  type ProviderComposerCapabilities,
  type ProviderListModelsResult,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";
import { resolveGeminiApiModelId } from "@t3tools/shared/model";
import { Effect, FileSystem, Layer, Queue, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { probeGeminiCapabilities } from "../geminiAcpProbe.ts";
import { GeminiAdapter, type GeminiAdapterShape } from "../Services/GeminiAdapter.ts";
import { asArray, asRecord, asString, trimToUndefined } from "../geminiValue.ts";
import { extractProposedPlanMarkdown, withProviderPlanModePrompt } from "../planMode.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { PROVIDER, SYNARA_GEMINI_SETTINGS_DIR } from "./GeminiAdapter.config.ts";
import {
  buildResumeCursor,
  cloneGeminiSessionFile,
  cloneStoredTurn,
  cloneUnknownArray,
  findGeminiSessionFileById,
  isAskUserToolCall,
  itemTypeFromToolKind,
  killChildProcess,
  makeApprovalOutcome,
  parsePermissionOptions,
  parseToolCall,
  readResumeSessionId,
  readResumeTurns,
  releaseProcessResources,
  requestTypeFromToolKind,
  resolveStartedGeminiSessionId,
  statusFromToolStatus,
  textFromContentBlock,
  toMessage,
  toolContentDetail,
  toolDetail,
} from "./GeminiAdapter.events.ts";
import {
  buildGeminiThinkingModelConfigAliases,
  geminiRequestTimeoutMs,
  runtimeModeToGeminiModeId,
} from "./GeminiAdapter.models.ts";
import { normalizePromptUsage, normalizeUsageUpdate } from "./GeminiAdapter.token.ts";
import type {
  GeminiAdapterLiveOptions,
  GeminiRecordedItem,
  GeminiSessionContext,
  GeminiStoredTurn,
  GeminiToolCall,
  GeminiTurnState,
  JsonRpcId,
} from "./GeminiAdapter.types.ts";

export type { GeminiAdapterLiveOptions } from "./GeminiAdapter.types.ts";
export {
  buildGeminiThinkingModelConfigAliases,
  geminiRequestTimeoutMs,
} from "./GeminiAdapter.models.ts";
export { resolveStartedGeminiSessionId } from "./GeminiAdapter.events.ts";

function updateGeminiSession(
  context: GeminiSessionContext,
  patch: Partial<ProviderSession>,
): ProviderSession {
  context.session = {
    ...context.session,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  return context.session;
}

function currentGeminiTurnId(context: GeminiSessionContext): TurnId | undefined {
  return context.turnState?.turnId;
}

function upsertGeminiTurnItem(
  turnState: GeminiTurnState,
  itemId: string,
  itemType: CanonicalItemType,
  patch: Partial<GeminiRecordedItem>,
): GeminiRecordedItem {
  let item = turnState.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    item = { id: itemId, itemType };
    turnState.items.push(item);
  }
  item.itemType = itemType;
  Object.assign(item, patch);
  return item;
}

const makeGeminiAdapter = Effect.fn("makeGeminiAdapter")(function* (
  options?: GeminiAdapterLiveOptions,
) {
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const runtimeServices = yield* Effect.services<ServerConfig | FileSystem.FileSystem>();
  const runPromise = Effect.runPromiseWith(runtimeServices);
  const runFork = Effect.runForkWith(runtimeServices);
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, GeminiSessionContext>();
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const writeNativeRecord = Effect.fn("writeNativeRecord")(function* (
    threadId: ThreadId | null,
    record: unknown,
  ) {
    if (!nativeEventLogger) {
      return;
    }
    yield* nativeEventLogger.write(record, threadId);
  });

  const prepareGeminiLaunchConfig = Effect.fn("prepareGeminiLaunchConfig")(function* (input: {
    readonly threadId: ThreadId;
    readonly selectedModel?: string;
  }) {
    const candidateModels = [
      ...MODEL_OPTIONS_BY_PROVIDER.gemini.map((option) => option.slug),
      ...(input.selectedModel ? [input.selectedModel] : []),
    ];
    const aliases = buildGeminiThinkingModelConfigAliases(candidateModels);

    if (Object.keys(aliases).length === 0) {
      return {
        env: process.env,
        systemSettingsPath: undefined,
      };
    }

    const systemSettingsPath = path.join(
      SYNARA_GEMINI_SETTINGS_DIR,
      `${input.threadId}-${crypto.randomUUID()}.json`,
    );
    yield* Effect.tryPromise({
      try: async () => {
        await fs.mkdir(SYNARA_GEMINI_SETTINGS_DIR, { recursive: true });
        await fs.writeFile(
          systemSettingsPath,
          JSON.stringify(
            {
              modelConfigs: {
                aliases,
              },
            },
            null,
            2,
          ),
          "utf8",
        );
      },
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: `Failed to prepare Gemini thinking settings: ${toMessage(cause, "write failed")}`,
          cause,
        }),
    });

    return {
      systemSettingsPath,
      env: {
        ...process.env,
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettingsPath,
      },
    };
  });

  const spawnGeminiProcess = Effect.fn("spawnGeminiProcess")(function* (
    threadId: ThreadId,
    binaryPath: string,
    cwd: string,
    env?: NodeJS.ProcessEnv,
  ) {
    return yield* Effect.try({
      try: () =>
        spawn(binaryPath, ["--acp"], {
          cwd,
          env: env ?? process.env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: process.platform === "win32",
        }),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId,
          detail: `Failed to spawn Gemini CLI: ${toMessage(cause, "spawn failed")}`,
          cause,
        }),
    });
  });

  const makeSessionContext = (input: {
    threadId: ThreadId;
    runtimeMode: ProviderSession["runtimeMode"];
    runtimeModeId: string;
    cwd: string;
    binaryPath: string;
    child: ChildProcessWithoutNullStreams;
    turns?: ReadonlyArray<GeminiStoredTurn>;
    sessionFilePath?: string;
    systemSettingsPath?: string;
  }): GeminiSessionContext => {
    const now = new Date().toISOString();
    return {
      session: {
        provider: PROVIDER,
        status: "connecting",
        runtimeMode: input.runtimeMode,
        cwd: input.cwd,
        threadId: input.threadId,
        createdAt: now,
        updatedAt: now,
      },
      binaryPath: input.binaryPath,
      child: input.child,
      stdout: readline.createInterface({ input: input.child.stdout }),
      stderr: readline.createInterface({ input: input.child.stderr }),
      pending: new Map(),
      pendingApprovals: new Map(),
      turns: (input.turns ?? []).map(cloneStoredTurn),
      runtimeModeId: input.runtimeModeId,
      nextRequestId: 1,
      sessionId: "",
      currentModeId: undefined,
      currentModelId: undefined,
      turnState: undefined,
      sessionFilePath: input.sessionFilePath,
      systemSettingsPath: input.systemSettingsPath,
      suppressSessionUpdates: false,
      stopped: false,
      exitEmitted: false,
      lastKnownTokenUsage: undefined,
    };
  };

  const snapshotThread = (context: GeminiSessionContext) => ({
    threadId: context.session.threadId,
    turns: context.turns.map((turn) => ({
      id: turn.id,
      items: cloneUnknownArray(turn.items),
    })),
  });

  const makeEventBase = (context: GeminiSessionContext) => ({
    eventId: EventId.makeUnsafe(crypto.randomUUID()),
    provider: PROVIDER,
    threadId: context.session.threadId,
    createdAt: new Date().toISOString(),
  });

  const offerRuntimeEvent = Effect.fn("offerRuntimeEvent")(function* (event: ProviderRuntimeEvent) {
    yield* Queue.offer(runtimeEventQueue, event);
  });

  const requireSession = Effect.fn("requireSession")(function* (threadId: ThreadId) {
    const context = sessions.get(threadId);
    if (!context) {
      return yield* new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId,
      });
    }
    if (context.stopped) {
      return yield* new ProviderAdapterSessionClosedError({
        provider: PROVIDER,
        threadId,
      });
    }
    return context;
  });

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

  const finishTurn = Effect.fn("finishTurn")(function* (
    context: GeminiSessionContext,
    result: {
      readonly state: "completed" | "failed" | "cancelled" | "interrupted";
      readonly stopReason?: string | null;
      readonly usage?: unknown;
      readonly errorMessage?: string;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }

    if (turnState.assistantTextStarted) {
      const proposedPlanMarkdown =
        result.state === "completed" && turnState.interactionMode === "plan"
          ? extractProposedPlanMarkdown(turnState.assistantText)
          : undefined;
      if (proposedPlanMarkdown) {
        yield* offerRuntimeEvent({
          ...makeEventBase(context),
          turnId: turnState.turnId,
          itemId: turnState.assistantItemId,
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: proposedPlanMarkdown,
          },
          raw: {
            source: "gemini.acp.message",
            method: "assistant/proposed-plan-block",
            payload: {
              text: turnState.assistantText,
            },
          },
        });
      }

      yield* offerRuntimeEvent({
        ...makeEventBase(context),
        turnId: turnState.turnId,
        itemId: turnState.assistantItemId,
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: result.state === "failed" ? "failed" : "completed",
          title: "Assistant message",
        },
      });
      upsertGeminiTurnItem(turnState, turnState.assistantItemId, "assistant_message", {
        status: result.state === "failed" ? "failed" : "completed",
      });
    }

    if (turnState.reasoningItemId && turnState.reasoningTextStarted) {
      yield* offerRuntimeEvent({
        ...makeEventBase(context),
        turnId: turnState.turnId,
        itemId: turnState.reasoningItemId,
        type: "item.completed",
        payload: {
          itemType: "reasoning",
          status: "completed",
          title: "Reasoning",
        },
      });
      upsertGeminiTurnItem(turnState, turnState.reasoningItemId, "reasoning", {
        status: "completed",
      });
    }

    const normalizedUsage = normalizePromptUsage(result.usage);
    if (normalizedUsage) {
      yield* emitUsage(context, normalizedUsage, turnState.turnId, result.usage);
    }

    yield* offerRuntimeEvent({
      ...makeEventBase(context),
      turnId: turnState.turnId,
      type: "turn.completed",
      payload: {
        state: result.state,
        ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      },
    });

    const storedTurn = yield* persistTurnSnapshot(context, turnState.turnId, turnState.items).pipe(
      Effect.catch((error) =>
        emitRuntimeWarning(context, error.message, {
          source: "gemini.acp.message",
          method: "session/snapshot",
          payload: {
            message: error.message,
          },
        }).pipe(
          Effect.as({
            id: turnState.turnId,
            items: cloneUnknownArray(turnState.items),
          } satisfies GeminiStoredTurn),
        ),
      ),
    );
    context.turns.push(storedTurn);
    context.turnState = undefined;
    updateGeminiSession(context, {
      status: "ready",
      activeTurnId: undefined,
      resumeCursor: buildResumeCursor(context),
      ...(result.state === "failed" && result.errorMessage
        ? { lastError: result.errorMessage }
        : {}),
    });
    yield* emitSessionState(context, "ready");
  });

  const rejectPendingRequests = (context: GeminiSessionContext, detail: string) => {
    for (const [id, pending] of context.pending) {
      clearTimeout(pending.timeout);
      pending.reject(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: pending.method,
          detail,
        }),
      );
      context.pending.delete(id);
    }
  };

  const disposeSessionContext = (
    context: GeminiSessionContext,
    detail: string,
    options?: {
      readonly removeFromSessions?: boolean;
    },
  ): void => {
    context.stopped = true;
    context.exitEmitted = true;
    rejectPendingRequests(context, detail);
    context.pendingApprovals.clear();
    releaseProcessResources(context);
    killChildProcess(context.child);
    if (options?.removeFromSessions && sessions.get(context.session.threadId) === context) {
      sessions.delete(context.session.threadId);
    }
  };

  const handleProcessExit = Effect.fn("handleProcessExit")(function* (
    context: GeminiSessionContext,
    input: {
      readonly detail: string;
      readonly exitKind: "graceful" | "error";
      readonly recoverable?: boolean;
    },
  ) {
    if (context.exitEmitted) {
      return;
    }
    context.exitEmitted = true;
    context.stopped = true;

    rejectPendingRequests(context, input.detail);

    if (context.turnState && input.exitKind === "error") {
      yield* emitRuntimeError(
        context,
        input.detail,
        { detail: input.detail },
        context.turnState.turnId,
      );
      yield* finishTurn(context, {
        state: "failed",
        errorMessage: input.detail,
      });
    }

    updateGeminiSession(context, {
      status: input.exitKind === "error" ? "error" : "closed",
      activeTurnId: undefined,
      ...(input.exitKind === "error" ? { lastError: input.detail } : {}),
    });
    yield* emitSessionState(
      context,
      input.exitKind === "error" ? "error" : "stopped",
      input.exitKind === "error" ? "process_exit" : "session_closed",
    );
    yield* offerRuntimeEvent({
      ...makeEventBase(context),
      type: "session.exited",
      payload: {
        reason: input.detail,
        exitKind: input.exitKind,
        ...(input.recoverable !== undefined ? { recoverable: input.recoverable } : {}),
      },
    });

    releaseProcessResources(context);
    if (sessions.get(context.session.threadId) === context) {
      sessions.delete(context.session.threadId);
    }
  });

  const writeJsonMessage = Effect.fn("writeJsonMessage")(function* (
    context: GeminiSessionContext,
    message: unknown,
  ) {
    const payload = `${JSON.stringify({ jsonrpc: "2.0", ...asRecord(message) })}\n`;
    yield* Effect.try({
      try: () => {
        if (!context.child.stdin.writable) {
          throw new Error("Gemini ACP stdin is not writable.");
        }
        context.child.stdin.write(payload);
      },
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: toMessage(cause, "Failed to write Gemini ACP message."),
          cause,
        }),
    });
  });

  const sendRequest = <T = unknown>(
    context: GeminiSessionContext,
    method: string,
    params: Record<string, unknown>,
  ): Effect.Effect<T, ProviderAdapterError> =>
    Effect.tryPromise({
      try: () =>
        new Promise<T>((resolve, reject) => {
          const id = context.nextRequestId++;
          const timeoutMs = geminiRequestTimeoutMs(method);
          const timeout = setTimeout(() => {
            context.pending.delete(String(id));
            reject(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method,
                detail: `Gemini ACP request timed out after ${timeoutMs}ms.`,
              }),
            );
          }, timeoutMs);

          context.pending.set(String(id), {
            method,
            timeout,
            resolve: (value) => resolve(value as T),
            reject: (error) => reject(error),
          });

          if (!context.child.stdin.writable) {
            clearTimeout(timeout);
            context.pending.delete(String(id));
            reject(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method,
                detail: "Gemini ACP stdin is not writable.",
              }),
            );
            return;
          }

          context.child.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              method,
              params,
            })}\n`,
          );
        }),
      catch: (cause) =>
        asString(asRecord(cause)?._tag) === "ProviderAdapterRequestError"
          ? (cause as ProviderAdapterRequestError)
          : new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: toMessage(cause, `${method} failed`),
              cause,
            }),
    });

  const sendNotification = (
    context: GeminiSessionContext,
    method: string,
    params: Record<string, unknown>,
  ) =>
    writeJsonMessage(context, { method, params }).pipe(
      Effect.mapError((cause) =>
        asString(asRecord(cause)?._tag) === "ProviderAdapterProcessError"
          ? (cause as ProviderAdapterProcessError)
          : new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: toMessage(cause, `${method} failed`),
              cause,
            }),
      ),
    );

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

  const attachProcessListeners = (context: GeminiSessionContext) => {
    const onStdoutLine = (line: string) => {
      void runPromise(
        writeNativeRecord(context.session.threadId, {
          source: "gemini.acp.stdout",
          line,
        }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const trimmed = line.trim();
              if (!trimmed.startsWith("{")) {
                return undefined;
              }
              try {
                return JSON.parse(trimmed) as Record<string, unknown>;
              } catch {
                return undefined;
              }
            }),
          ),
          Effect.flatMap((parsed) =>
            parsed
              ? writeNativeRecord(context.session.threadId, {
                  source: "gemini.acp.message",
                  payload: parsed,
                }).pipe(Effect.andThen(handleParsedMessage(context, parsed)))
              : Effect.void,
          ),
        ),
      );
    };

    const onStderrLine = (line: string) => {
      const message = line.trim();
      if (message.length === 0) {
        return;
      }
      void runPromise(
        writeNativeRecord(context.session.threadId, {
          source: "gemini.acp.stderr",
          line,
        }).pipe(
          Effect.andThen(
            emitRuntimeWarning(context, message, {
              source: "gemini.acp.stderr",
              payload: { line: message },
            }),
          ),
        ),
      );
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail =
        code === 0
          ? "Gemini ACP session exited."
          : `Gemini ACP session exited with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}.`;
      void runPromise(
        handleProcessExit(context, {
          detail,
          exitKind: code === 0 || context.stopped ? "graceful" : "error",
          recoverable: !context.stopped,
        }),
      );
    };

    const onError = (error: Error) => {
      void runPromise(
        handleProcessExit(context, {
          detail: `Gemini ACP process error: ${error.message}`,
          exitKind: "error",
          recoverable: true,
        }),
      );
    };

    context.stdout.on("line", onStdoutLine);
    context.stderr.on("line", onStderrLine);
    context.child.once("exit", onExit);
    context.child.once("error", onError);
  };

  const resolveSessionFilePath = Effect.fn("resolveSessionFilePath")(function* (
    context: GeminiSessionContext,
    options?: { readonly retries?: number },
  ) {
    const retries = options?.retries ?? 0;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const resolvedPath = yield* Effect.tryPromise({
        try: () => findGeminiSessionFileById(context.sessionId, context.sessionFilePath),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: context.session.threadId,
            detail: `Failed to locate Gemini session file: ${toMessage(cause, "lookup failed")}`,
            cause,
          }),
      });
      if (resolvedPath) {
        context.sessionFilePath = resolvedPath;
        return resolvedPath;
      }
      if (attempt < retries) {
        yield* Effect.sleep(100);
      }
    }
    return undefined;
  });

  const persistTurnSnapshot = Effect.fn("persistTurnSnapshot")(function* (
    context: GeminiSessionContext,
    turnId: TurnId,
    items: ReadonlyArray<unknown>,
  ) {
    const storedTurnBase: GeminiStoredTurn = {
      id: turnId,
      items: cloneUnknownArray(items),
    };
    const liveSessionFilePath = yield* resolveSessionFilePath(context, { retries: 5 });
    if (!liveSessionFilePath) {
      return storedTurnBase;
    }

    const snapshotSessionId = crypto.randomUUID();
    const snapshotFilePath = yield* Effect.tryPromise({
      try: () => cloneGeminiSessionFile(liveSessionFilePath, snapshotSessionId),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: `Failed to snapshot Gemini session history: ${toMessage(cause, "snapshot failed")}`,
          cause,
        }),
    });

    return {
      ...storedTurnBase,
      snapshotSessionId,
      snapshotFilePath,
    } satisfies GeminiStoredTurn;
  });

  const bootstrapSessionContext = Effect.fn("bootstrapSessionContext")(function* (
    context: GeminiSessionContext,
    input: {
      readonly resumeSessionId?: string;
      readonly allowResumeFallback?: boolean;
      readonly model?: string;
      readonly apiModelId?: string;
      readonly sessionFilePath?: string;
    },
  ) {
    context.suppressSessionUpdates = true;
    return yield* Effect.gen(function* () {
      yield* sendRequest(context, "initialize", {
        protocolVersion: 1,
        clientInfo: {
          name: "synara",
          title: "Synara",
          version: "0.1.0",
        },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          auth: { terminal: false },
        },
      });

      const startResponse = yield* input.resumeSessionId
        ? input.allowResumeFallback !== false
          ? sendRequest<Record<string, unknown>>(context, "session/load", {
              sessionId: input.resumeSessionId,
              cwd: context.session.cwd ?? process.cwd(),
              mcpServers: [],
            }).pipe(
              Effect.catch(() =>
                sendRequest<Record<string, unknown>>(context, "session/new", {
                  cwd: context.session.cwd ?? process.cwd(),
                  mcpServers: [],
                }),
              ),
            )
          : sendRequest<Record<string, unknown>>(context, "session/load", {
              sessionId: input.resumeSessionId,
              cwd: context.session.cwd ?? process.cwd(),
              mcpServers: [],
            })
        : sendRequest<Record<string, unknown>>(context, "session/new", {
            cwd: context.session.cwd ?? process.cwd(),
            mcpServers: [],
          });

      context.sessionId = resolveStartedGeminiSessionId(input.resumeSessionId, startResponse) ?? "";
      if (!context.sessionId) {
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: "Gemini ACP did not return a session id.",
        });
      }

      context.currentModeId = trimToUndefined(asRecord(startResponse.modes)?.currentModeId);
      context.currentModelId = trimToUndefined(asRecord(startResponse.models)?.currentModelId);
      yield* setGeminiMode(context, context.runtimeModeId);

      if (input.model) {
        yield* setGeminiModel(context, {
          model: input.model,
          acpModelId: input.apiModelId ?? input.model,
        });
      }

      context.sessionFilePath = input.sessionFilePath ?? context.sessionFilePath;
      updateGeminiSession(context, {
        status: "ready",
        ...(input.model
          ? { model: input.model }
          : context.currentModelId
            ? { model: context.currentModelId }
            : {}),
        resumeCursor: buildResumeCursor(context),
      });

      return {
        currentModelId: context.currentModelId,
      };
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          context.suppressSessionUpdates = false;
        }),
      ),
    );
  });

  const setGeminiMode = Effect.fn("setGeminiMode")(function* (
    context: GeminiSessionContext,
    modeId: string,
  ) {
    if (context.currentModeId === modeId) {
      return;
    }
    yield* sendRequest(context, "session/set_mode", {
      sessionId: context.sessionId,
      modeId,
    });
    context.currentModeId = modeId;
  });

  const setGeminiModel = Effect.fn("setGeminiModel")(function* (
    context: GeminiSessionContext,
    input: {
      readonly model: string;
      readonly acpModelId: string;
    },
  ) {
    if (context.currentModelId === input.acpModelId) {
      return;
    }
    yield* sendRequest(context, "session/set_model", {
      sessionId: context.sessionId,
      modelId: input.acpModelId,
    });
    context.currentModelId = input.acpModelId;
    updateGeminiSession(context, { model: input.model });
  });

  const buildPromptBlocks = Effect.fn("buildPromptBlocks")(function* (
    input: ProviderSendTurnInput,
  ) {
    const blocks: Array<Record<string, unknown>> = [];

    const promptText = trimToUndefined(
      withProviderPlanModePrompt({
        text: input.input?.trim() ?? "",
        interactionMode: input.interactionMode,
      }),
    );
    if (promptText) {
      blocks.push({
        type: "text",
        text: promptText,
      });
    }

    for (const attachment of input.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: `Invalid attachment id '${attachment.id}'.`,
        });
      }
      const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: `Failed to read attachment file: ${cause.message}.`,
              cause,
            }),
        ),
      );
      blocks.push({
        type: "image",
        mimeType: attachment.mimeType,
        data: Buffer.from(bytes).toString("base64"),
      });
    }

    return blocks;
  });

  const runPromptTurn = Effect.fn("runPromptTurn")(function* (
    context: GeminiSessionContext,
    turnId: TurnId,
    prompt: ReadonlyArray<Record<string, unknown>>,
  ) {
    const promptResult = yield* Effect.result(
      sendRequest<Record<string, unknown>>(context, "session/prompt", {
        sessionId: context.sessionId,
        prompt,
      }),
    );
    if (promptResult._tag === "Failure") {
      const error = promptResult.failure;
      const message = toMessage(error, "Gemini turn failed.");
      yield* emitRuntimeError(context, message, error, turnId);
      yield* finishTurn(context, {
        state: "failed",
        errorMessage: message,
      });
      return;
    }

    const response = promptResult.success;

    if (!response) {
      const message = "Gemini ACP returned an empty prompt response.";
      yield* emitRuntimeError(context, message, { response }, turnId);
      yield* finishTurn(context, {
        state: "failed",
        errorMessage: message,
      });
      return;
    }

    const stopReason = asString(response.stopReason) ?? null;
    yield* finishTurn(context, {
      state: stopReason === "cancelled" ? "cancelled" : "completed",
      stopReason,
      usage: response.usage,
    });
  });

  const startSession: GeminiAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const existing = sessions.get(input.threadId);
      if (existing) {
        disposeSessionContext(existing, "Session replaced while starting a new Gemini session.", {
          removeFromSessions: true,
        });
      }

      const cwd = input.cwd ?? process.cwd();
      const binaryPath = trimToUndefined(input.providerOptions?.gemini?.binaryPath) ?? "gemini";
      const runtimeModeId = runtimeModeToGeminiModeId(input.runtimeMode);
      const selectedGeminiModel =
        input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;
      const launchConfig = yield* prepareGeminiLaunchConfig({
        threadId: input.threadId,
        ...(selectedGeminiModel ? { selectedModel: selectedGeminiModel } : {}),
      });
      const child = yield* spawnGeminiProcess(
        input.threadId,
        binaryPath,
        cwd,
        launchConfig.env,
      ).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            if (launchConfig.systemSettingsPath) {
              void fs.unlink(launchConfig.systemSettingsPath).catch(() => {
                // Ignore cleanup failures for temporary settings files.
              });
            }
          }),
        ),
      );
      const requestedResumeSessionId = readResumeSessionId(input.resumeCursor);
      const resumeTurns = readResumeTurns(input.resumeCursor);
      const context = makeSessionContext({
        threadId: input.threadId,
        runtimeMode: input.runtimeMode,
        runtimeModeId,
        cwd,
        binaryPath,
        child,
        turns: resumeTurns,
        ...(launchConfig.systemSettingsPath
          ? { systemSettingsPath: launchConfig.systemSettingsPath }
          : {}),
      });

      attachProcessListeners(context);
      sessions.set(input.threadId, context);
      const bootstrapInput = {
        allowResumeFallback: true,
        ...(requestedResumeSessionId ? { resumeSessionId: requestedResumeSessionId } : {}),
        ...(input.modelSelection?.provider === PROVIDER
          ? {
              model: input.modelSelection.model,
              apiModelId: resolveGeminiApiModelId(
                input.modelSelection.model,
                input.modelSelection.options,
              ),
            }
          : {}),
      };
      yield* bootstrapSessionContext(context, bootstrapInput).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            disposeSessionContext(context, "Gemini session failed during startup.", {
              removeFromSessions: true,
            });
          }),
        ),
      );

      yield* offerRuntimeEvent({
        ...makeEventBase(context),
        type: "session.started",
        payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
      });
      yield* offerRuntimeEvent({
        ...makeEventBase(context),
        type: "session.configured",
        payload: {
          config: {
            cwd,
            modeId: context.currentModeId ?? runtimeModeId,
            ...(context.session.model ? { model: context.session.model } : {}),
          },
        },
      });
      yield* emitSessionState(context, "ready");
      yield* offerRuntimeEvent({
        ...makeEventBase(context),
        type: "thread.started",
        payload: {
          providerThreadId: context.sessionId,
        },
      });

      return context.session;
    },
  );

  const sendTurn: GeminiAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    if (context.turnState) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "A Gemini turn is already in progress for this thread.",
      });
    }

    if (input.modelSelection?.provider === PROVIDER) {
      yield* setGeminiModel(context, {
        model: input.modelSelection.model,
        acpModelId: resolveGeminiApiModelId(
          input.modelSelection.model,
          input.modelSelection.options,
        ),
      });
    }

    if (input.interactionMode === "plan") {
      yield* setGeminiMode(context, "plan");
    } else {
      yield* setGeminiMode(context, context.runtimeModeId);
    }

    const prompt = yield* buildPromptBlocks(input);
    if (prompt.length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Either input text or at least one attachment is required.",
      });
    }

    const turnId = TurnId.makeUnsafe(crypto.randomUUID());
    context.turnState = {
      turnId,
      startedAt: new Date().toISOString(),
      interactionMode: input.interactionMode === "plan" ? "plan" : "default",
      assistantItemId: RuntimeItemId.makeUnsafe(`gemini-assistant-${crypto.randomUUID()}`),
      reasoningItemId: undefined,
      items: [],
      assistantTextStarted: false,
      reasoningTextStarted: false,
      assistantText: "",
      reasoningText: "",
    };
    updateGeminiSession(context, {
      status: "running",
      activeTurnId: turnId,
      ...(input.modelSelection?.provider === PROVIDER ? { model: input.modelSelection.model } : {}),
    });

    yield* emitSessionState(context, "running");
    yield* offerRuntimeEvent({
      ...makeEventBase(context),
      turnId,
      type: "turn.started",
      payload: context.session.model ? { model: context.session.model } : {},
    });

    runFork(runPromptTurn(context, turnId, prompt));

    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: buildResumeCursor(context),
    };
  });

  const interruptTurn: GeminiAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      if (turnId && context.turnState && context.turnState.turnId !== turnId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "interruptTurn",
          issue: `Turn '${turnId}' is not active for thread '${threadId}'.`,
        });
      }
      if (!context.turnState) {
        return;
      }
      yield* sendNotification(context, "session/cancel", {
        sessionId: context.sessionId,
      });
    });

  const respondToRequest: GeminiAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue: `Unknown Gemini approval request '${requestId}'.`,
        });
      }

      yield* writeJsonMessage(context, {
        id: pending.acpRequestId,
        result: makeApprovalOutcome(decision, pending.options),
      });
      context.pendingApprovals.delete(requestId);

      yield* offerRuntimeEvent({
        ...makeEventBase(context),
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
        requestId: RuntimeRequestId.makeUnsafe(requestId),
        type: "request.resolved",
        payload: {
          requestType: pending.requestType,
          decision,
          resolution: makeApprovalOutcome(decision, pending.options),
        },
        providerRefs: {
          providerRequestId: String(pending.acpRequestId),
          ...(pending.providerItemId
            ? { providerItemId: ProviderItemId.makeUnsafe(pending.providerItemId) }
            : {}),
        },
        raw: {
          source: "gemini.acp.message",
          method: "session/request_permission",
          payload: {
            decision,
          },
        },
      });
    });

  const respondToUserInput: GeminiAdapterShape["respondToUserInput"] = (
    _threadId,
    _requestId,
    _answers,
  ) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "respondToUserInput",
        issue:
          "Gemini ACP does not expose structured user-input answers. Gemini Ask User requests can only be approved or declined.",
      }),
    );

  const stopSession: GeminiAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      context.stopped = true;
      killChildProcess(context.child);
    });

  const listSessions: GeminiAdapterShape["listSessions"] = () =>
    Effect.succeed(
      Array.from(sessions.values())
        .filter((context) => !context.stopped)
        .map((context) => context.session),
    );

  const hasSession: GeminiAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(Boolean(sessions.get(threadId) && !sessions.get(threadId)?.stopped));

  const readThread: GeminiAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      return snapshotThread(context);
    });

  const rollbackThread: GeminiAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      const context = yield* requireSession(threadId);
      if (context.turnState) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Cannot roll back a Gemini thread while a turn is in progress.",
        });
      }

      const nextLength = Math.max(0, context.turns.length - numTurns);
      if (nextLength === context.turns.length) {
        return snapshotThread(context);
      }

      const nextTurns = context.turns.slice(0, nextLength).map(cloneStoredTurn);
      const cwd = context.session.cwd ?? process.cwd();

      let resumeSessionId: string | undefined;
      let sessionFilePath: string | undefined;
      if (nextLength > 0) {
        const targetTurn = nextTurns[nextLength - 1];
        if (!targetTurn) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Gemini session snapshot is unavailable for the requested rollback target.",
          });
        }
        const targetSnapshotSessionId = targetTurn.snapshotSessionId;
        if (!targetSnapshotSessionId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Gemini session snapshot is unavailable for the requested rollback target.",
          });
        }

        const sourceSnapshotPath = yield* Effect.tryPromise({
          try: () =>
            findGeminiSessionFileById(targetSnapshotSessionId, targetTurn.snapshotFilePath),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: `Failed to locate Gemini rollback snapshot: ${toMessage(cause, "lookup failed")}`,
              cause,
            }),
        });
        if (!sourceSnapshotPath) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Gemini rollback snapshot file could not be found.",
          });
        }

        resumeSessionId = crypto.randomUUID();
        sessionFilePath = yield* Effect.tryPromise({
          try: () => cloneGeminiSessionFile(sourceSnapshotPath, resumeSessionId as string),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: `Failed to restore Gemini rollback snapshot: ${toMessage(cause, "restore failed")}`,
              cause,
            }),
        });
      }

      const launchConfig = yield* prepareGeminiLaunchConfig({
        threadId,
        ...(context.session.model ? { selectedModel: context.session.model } : {}),
      });
      const child = yield* spawnGeminiProcess(
        threadId,
        context.binaryPath,
        cwd,
        launchConfig.env,
      ).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            if (launchConfig.systemSettingsPath) {
              void fs.unlink(launchConfig.systemSettingsPath).catch(() => {
                // Ignore cleanup failures for temporary settings files.
              });
            }
          }),
        ),
      );
      const nextContext = makeSessionContext({
        threadId,
        runtimeMode: context.session.runtimeMode,
        runtimeModeId: context.runtimeModeId,
        cwd,
        binaryPath: context.binaryPath,
        child,
        turns: nextTurns,
        ...(sessionFilePath ? { sessionFilePath } : {}),
        ...(launchConfig.systemSettingsPath
          ? { systemSettingsPath: launchConfig.systemSettingsPath }
          : {}),
      });
      attachProcessListeners(nextContext);

      const rollbackBootstrapInput = {
        allowResumeFallback: false,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(context.session.model
          ? {
              model: context.session.model,
              apiModelId: context.currentModelId ?? context.session.model,
            }
          : {}),
        ...(sessionFilePath ? { sessionFilePath } : {}),
      };
      yield* bootstrapSessionContext(nextContext, rollbackBootstrapInput).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            disposeSessionContext(nextContext, "Gemini rollback session failed during startup.");
          }),
        ),
      );

      disposeSessionContext(context, "Session replaced during rollback.");

      sessions.set(threadId, nextContext);
      return snapshotThread(nextContext);
    },
  );

  const stopAll: GeminiAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.keys()), (threadId) => stopSession(threadId), {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.asVoid);

  const listModels: NonNullable<GeminiAdapterShape["listModels"]> = (input) =>
    probeGeminiCapabilities({
      binaryPath: trimToUndefined(input.binaryPath) ?? "gemini",
      cwd: os.homedir(),
    }).pipe(
      Effect.map(
        (result) =>
          ({
            models: result.models,
            source: "gemini.acp",
            cached: false,
          }) satisfies ProviderListModelsResult,
      ),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: toMessage(cause, "Failed to list Gemini models."),
            cause,
          }),
      ),
    );

  const getComposerCapabilities: NonNullable<GeminiAdapterShape["getComposerCapabilities"]> = () =>
    Effect.succeed({
      provider: PROVIDER,
      supportsSkillMentions: false,
      supportsSkillDiscovery: false,
      supportsNativeSlashCommandDiscovery: false,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: true,
      supportsThreadCompaction: false,
      supportsThreadImport: false,
    } satisfies ProviderComposerCapabilities);

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const context of Array.from(sessions.values())) {
        disposeSessionContext(context, "Gemini adapter is shutting down.", {
          removeFromSessions: true,
        });
      }
    }).pipe(Effect.ignore, Effect.andThen(Queue.shutdown(runtimeEventQueue))),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      supportsSkillMentions: false,
      supportsSkillDiscovery: false,
      supportsNativeSlashCommandDiscovery: false,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: true,
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    listModels,
    getComposerCapabilities,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies GeminiAdapterShape;
});

export const GeminiAdapterLive = Layer.effect(GeminiAdapter, makeGeminiAdapter());

export function makeGeminiAdapterLive(options?: GeminiAdapterLiveOptions) {
  return Layer.effect(GeminiAdapter, makeGeminiAdapter(options));
}
