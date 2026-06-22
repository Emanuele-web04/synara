/**
 * GeminiAdapterLive - Scoped live implementation for the Gemini provider adapter.
 *
 * Wraps Gemini CLI ACP sessions behind the generic provider adapter contract
 * and emits canonical provider runtime events.
 *
 * @module GeminiAdapterLive
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import readline from "node:readline";

import {
  EventId,
  type ProviderComposerCapabilities,
  type ProviderListModelsResult,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { resolveGeminiApiModelId } from "@t3tools/shared/model";
import { Effect, FileSystem, Layer, Queue, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { probeGeminiCapabilities } from "../geminiAcpProbe.ts";
import { GeminiAdapter, type GeminiAdapterShape } from "../Services/GeminiAdapter.ts";
import { asRecord, asString, trimToUndefined } from "../geminiValue.ts";
import { withProviderPlanModePrompt } from "../planMode.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  bootstrapSessionContext,
  setGeminiMode,
  setGeminiModel,
} from "./GeminiAdapter.bootstrap.ts";
import { PROVIDER } from "./GeminiAdapter.config.ts";
import { makeGeminiEmitters } from "./GeminiAdapter.emitters.ts";
import { makeGeminiMessageHandlers } from "./GeminiAdapter.handlers.ts";
import { prepareGeminiLaunchConfig, spawnGeminiProcess } from "./GeminiAdapter.process.ts";
import { sendNotification, sendRequest, writeJsonMessage } from "./GeminiAdapter.transport.ts";
import { makeGeminiTurnFinalizer } from "./GeminiAdapter.turn.ts";
import {
  buildResumeCursor,
  cloneGeminiSessionFile,
  cloneStoredTurn,
  cloneUnknownArray,
  findGeminiSessionFileById,
  killChildProcess,
  makeApprovalOutcome,
  readResumeSessionId,
  readResumeTurns,
  releaseProcessResources,
  resolveStartedGeminiSessionId,
  toMessage,
} from "./GeminiAdapter.events.ts";
import { runtimeModeToGeminiModeId } from "./GeminiAdapter.models.ts";
import { updateGeminiSession } from "./GeminiAdapter.state.ts";
import type {
  GeminiAdapterLiveOptions,
  GeminiSessionContext,
  GeminiStoredTurn,
} from "./GeminiAdapter.types.ts";

export type { GeminiAdapterLiveOptions } from "./GeminiAdapter.types.ts";
export {
  buildGeminiThinkingModelConfigAliases,
  geminiRequestTimeoutMs,
} from "./GeminiAdapter.models.ts";
export { resolveStartedGeminiSessionId } from "./GeminiAdapter.events.ts";

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

  const {
    emitSessionState,
    emitRuntimeWarning,
    emitRuntimeError,
    emitUsage,
    emitTextDelta,
    emitToolLifecycle,
  } = makeGeminiEmitters({ offerRuntimeEvent, makeEventBase });

  const { finishTurn } = makeGeminiTurnFinalizer({
    offerRuntimeEvent,
    makeEventBase,
    emitUsage,
    emitRuntimeWarning,
    emitSessionState,
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

  const { handleParsedMessage } = makeGeminiMessageHandlers({
    offerRuntimeEvent,
    makeEventBase,
    emitToolLifecycle,
    emitTextDelta,
    emitUsage,
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

  const buildPromptBlocks = Effect.fn("buildPromptBlocks")(function* (
    input: ProviderSendTurnInput,
  ) {
    const blocks: Array<Record<string, unknown>> = [];

    const planPromptText = trimToUndefined(
      withProviderPlanModePrompt({
        text: input.input?.trim() ?? "",
        interactionMode: input.interactionMode,
      }),
    );
    const promptText = appendFileAttachmentsPromptBlock({
      text: planPromptText,
      attachments: input.attachments,
      attachmentsDir: serverConfig.attachmentsDir,
      include: "all-files",
    });
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
