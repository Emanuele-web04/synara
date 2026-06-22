/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import {
  query,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ThreadId,
  TurnId,
  type ProviderComposerCapabilities,
  type ProviderListCommandsInput,
  type ProviderListCommandsResult,
  type ProviderListSkillsInput,
  type ProviderListSkillsResult,
  type ProviderListAgentsResult,
  type ProviderListModelsResult,
} from "@t3tools/contracts";
import {
  hasEffortLevel,
  getModelCapabilities,
  resolveApiModelId,
  trimOrNull,
} from "@t3tools/shared/model";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Queue,
  Random,
  Ref,
  Stream,
} from "effect";

import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { ClaudeAdapter, type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import {
  CLAUDE_SETTING_SOURCES,
  EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND,
  PROVIDER,
} from "./ClaudeAdapter.config.ts";
import {
  asCanonicalTurnId,
  asRuntimeRequestId,
  buildClaudeSdkSubagents,
  interruptionMessageFromClaudeCause,
  isClaudeInterruptedCause,
  mapSupportedCommands,
  messageFromClaudeStreamCause,
  neverResolvingUserMessageStream,
  readClaudeResumeState,
  toError,
  toMessage,
  toPermissionMode,
  toRequestError,
} from "./ClaudeAdapter.events.ts";
import {
  getEffectiveClaudeCodeEffort,
  resolveSelectedClaudeContextWindowMaxTokens,
} from "./ClaudeAdapter.models.ts";
import { makeClaudeEmitters } from "./ClaudeAdapter.emitters.ts";
import { makeClaudeMessageHandlers } from "./ClaudeAdapter.messageHandlers.ts";
import { makeClaudeCanUseTool } from "./ClaudeAdapter.permissions.ts";
import { buildUserMessageEffect } from "./ClaudeAdapter.userMessage.ts";
import {
  type ClaudeQueryRuntime,
  type ClaudeAdapterLiveOptions,
  type ClaudeSessionContext,
  hasPendingUserInterrupt,
  nativeProviderRefs,
} from "./ClaudeAdapter.runtime.ts";
import type {
  ClaudeTurnState,
  PendingApproval,
  PendingUserInput,
  PromptQueueItem,
  ToolInFlight,
} from "./ClaudeAdapter.types.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

export type { ClaudeAdapterLiveOptions } from "./ClaudeAdapter.runtime.ts";

function makeClaudeAdapter(options?: ClaudeAdapterLiveOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const createQuery =
      options?.createQuery ??
      ((input: {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }) => query({ prompt: input.prompt, options: input.options }) as ClaudeQueryRuntime);

    const sessions = new Map<ThreadId, ClaudeSessionContext>();
    let cachedModels: ProviderListModelsResult | null = null;
    let cachedAgents: ProviderListAgentsResult | null = null;
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    const emitters = makeClaudeEmitters({
      offerRuntimeEvent,
      makeEventStamp,
      nowIso,
      nativeEventLogger,
    });
    const {
      snapshotThread,
      updateResumeCursor,
      emitRuntimeError,
      emitProposedPlanCompleted,
      completeTurn,
    } = emitters;

    const { handleSdkMessage } = makeClaudeMessageHandlers({
      emitters,
      offerRuntimeEvent,
      makeEventStamp,
      nowIso,
    });

    const runSdkStream = (context: ClaudeSessionContext): Effect.Effect<void, Error> =>
      Stream.fromAsyncIterable(context.query, (cause) =>
        toError(cause, "Claude runtime stream failed."),
      ).pipe(
        Stream.takeWhile(() => !context.stopped),
        Stream.runForEach((message) => handleSdkMessage(context, message)),
      );

    const handleStreamExit = (
      context: ClaudeSessionContext,
      exit: Exit.Exit<void, Error>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.stopped) {
          return;
        }

        if (Exit.isFailure(exit)) {
          if (hasPendingUserInterrupt(context) || isClaudeInterruptedCause(exit.cause)) {
            if (context.turnState) {
              yield* completeTurn(
                context,
                "interrupted",
                interruptionMessageFromClaudeCause(exit.cause),
              );
            }
          } else {
            const message = messageFromClaudeStreamCause(
              exit.cause,
              "Claude runtime stream failed.",
            );
            yield* emitRuntimeError(context, message, Cause.pretty(exit.cause));
            yield* completeTurn(context, "failed", message);
          }
        } else if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Claude runtime stream ended.");
        }

        yield* stopSessionInternal(context, {
          emitExitEvent: true,
        });
      });

    const stopSessionInternal = (
      context: ClaudeSessionContext,
      options?: { readonly emitExitEvent?: boolean },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.stopped) return;

        context.stopped = true;

        for (const [requestId, pending] of context.pendingApprovals) {
          yield* Deferred.succeed(pending.decision, "cancel");
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "request.resolved",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: {
              requestType: pending.requestType,
              decision: "cancel",
            },
            providerRefs: nativeProviderRefs(context),
          });
        }
        context.pendingApprovals.clear();

        if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Session stopped.");
        }

        yield* Queue.shutdown(context.promptQueue);

        const streamFiber = context.streamFiber;
        context.streamFiber = undefined;
        if (streamFiber && streamFiber.pollUnsafe() === undefined) {
          yield* Fiber.interrupt(streamFiber);
        }

        // @effect-diagnostics-next-line tryCatchInEffectGen:off
        try {
          context.query.close();
        } catch (cause) {
          yield* emitRuntimeError(context, "Failed to close Claude runtime query.", cause);
        }

        const updatedAt = yield* nowIso;
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt,
        };

        if (options?.emitExitEvent !== false) {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "session.exited",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            payload: {
              reason: "Session stopped",
              exitKind: "graceful",
            },
            providerRefs: {},
          });
        }

        sessions.delete(context.session.threadId);
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
      const context = sessions.get(threadId);
      if (!context) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      if (context.stopped || context.session.status === "closed") {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      return Effect.succeed(context);
    };

    const startSession: ClaudeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const startedAt = yield* nowIso;
        const resumeState = readClaudeResumeState(input.resumeCursor);
        const threadId = input.threadId;
        const existingResumeSessionId = resumeState?.resume;
        const newSessionId =
          existingResumeSessionId === undefined ? yield* Random.nextUUIDv4 : undefined;
        const sessionId = existingResumeSessionId ?? newSessionId;

        const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
        const prompt = Stream.fromQueue(promptQueue).pipe(
          Stream.filter((item) => item.type === "message"),
          Stream.map((item) => item.message),
          Stream.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
          ),
          Stream.toAsyncIterable,
        );

        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
        const inFlightTools = new Map<number, ToolInFlight>();

        const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

        const canUseTool = makeClaudeCanUseTool({
          contextRef,
          pendingApprovals,
          pendingUserInputs,
          runtimeMode: input.runtimeMode,
          offerRuntimeEvent,
          makeEventStamp,
          emitProposedPlanCompleted,
        });

        const providerOptions = input.providerOptions?.claudeAgent;
        const modelSelection =
          input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;
        const requestedEffort = trimOrNull(modelSelection?.options?.effort ?? null);
        const requestedContextWindow = trimOrNull(modelSelection?.options?.contextWindow ?? null);
        const caps = getModelCapabilities("claudeAgent", modelSelection?.model);
        const apiModelId = modelSelection ? resolveApiModelId(modelSelection) : undefined;
        const effort =
          requestedEffort && hasEffortLevel(caps, requestedEffort) ? requestedEffort : null;
        const fastMode = modelSelection?.options?.fastMode === true && caps.supportsFastMode;
        const thinking =
          typeof modelSelection?.options?.thinking === "boolean" && caps.supportsThinkingToggle
            ? modelSelection.options.thinking
            : undefined;
        const effectiveEffort = getEffectiveClaudeCodeEffort(effort);
        const ultracode = effort === "ultracode" && hasEffortLevel(caps, "xhigh");
        const permissionMode =
          toPermissionMode(providerOptions?.permissionMode) ??
          (input.runtimeMode === "full-access" ? "bypassPermissions" : undefined);
        const settings = {
          ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
          ...(fastMode ? { fastMode: true } : {}),
          ...(ultracode ? { ultracode: true } : {}),
        };
        const claudeSubagents = buildClaudeSdkSubagents();

        const queryOptions: ClaudeQueryOptions = {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          // Keep Claude context-window selection model-driven so session start
          // and in-session switches both use the same API model contract.
          ...(apiModelId ? { model: apiModelId } : {}),
          pathToClaudeCodeExecutable: providerOptions?.binaryPath ?? "claude",
          settingSources: [...CLAUDE_SETTING_SOURCES],
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND,
          },
          ...(Object.keys(claudeSubagents).length > 0 ? { agents: claudeSubagents } : {}),
          // Keep the runtime value explicit so Opus 4.7 can pass xhigh through to the SDK.
          ...(effectiveEffort
            ? { effort: effectiveEffort as "low" | "medium" | "high" | "xhigh" | "max" }
            : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          ...(providerOptions?.maxThinkingTokens !== undefined
            ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
            : {}),
          ...(Object.keys(settings).length > 0 ? { settings } : {}),
          ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
          ...(newSessionId ? { sessionId: newSessionId } : {}),
          includePartialMessages: true,
          canUseTool,
          env: process.env,
          ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
        };

        const queryRuntime = yield* Effect.try({
          try: () =>
            createQuery({
              prompt,
              options: queryOptions,
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: toMessage(cause, "Failed to start Claude runtime session."),
              cause,
            }),
        });

        // Populate model cache in background from first session
        if (!cachedModels) {
          queryRuntime
            .supportedModels()
            .then((models) => {
              cachedModels = {
                models: models.map((m) => ({ slug: m.value, name: m.displayName })),
                source: "sdk",
                cached: false,
              };
            })
            .catch(() => {
              /* ignore discovery failures */
            });
        }

        // Populate agent cache in background from first session
        if (!cachedAgents) {
          queryRuntime
            .supportedAgents()
            .then((agents) => {
              cachedAgents = {
                agents: agents.map((a) => ({
                  name: a.name,
                  displayName: a.name,
                  ...(a.description ? { description: a.description } : {}),
                  ...(a.model ? { model: a.model } : {}),
                })),
                source: "sdk",
                cached: false,
              };
            })
            .catch(() => {
              /* ignore discovery failures */
            });
        }

        const session: ProviderSession = {
          threadId,
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(modelSelection?.model ? { model: modelSelection.model } : {}),
          ...(threadId ? { threadId } : {}),
          resumeCursor: {
            ...(threadId ? { threadId } : {}),
            ...(sessionId ? { resume: sessionId } : {}),
            ...(resumeState?.resumeSessionAt
              ? { resumeSessionAt: resumeState.resumeSessionAt }
              : {}),
            turnCount: resumeState?.turnCount ?? 0,
          },
          createdAt: startedAt,
          updatedAt: startedAt,
        };

        const context: ClaudeSessionContext = {
          session,
          promptQueue,
          query: queryRuntime,
          streamFiber: undefined,
          startedAt,
          basePermissionMode: permissionMode,
          currentApiModelId: apiModelId,
          resumeSessionId: sessionId,
          pendingApprovals,
          pendingUserInputs,
          turns: [],
          inFlightTools,
          turnState: undefined,
          interruptRequestedTurnId: undefined,
          lastKnownContextWindow: undefined,
          lastKnownTokenUsage: undefined,
          lastAssistantUuid: resumeState?.resumeSessionAt,
          lastThreadStartedId: undefined,
          lastThinkingItemId: undefined,
          lastEmittedThinkingTokens: undefined,
          stopped: false,
          warnedUnhandledSdkKinds: new Set(),
        };
        yield* Ref.set(contextRef, context);
        sessions.set(threadId, context);

        const sessionStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.started",
          eventId: sessionStartedStamp.eventId,
          provider: PROVIDER,
          createdAt: sessionStartedStamp.createdAt,
          threadId,
          payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
          providerRefs: {},
        });

        const configuredStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.configured",
          eventId: configuredStamp.eventId,
          provider: PROVIDER,
          createdAt: configuredStamp.createdAt,
          threadId,
          payload: {
            config: {
              ...(modelSelection?.model ? { model: modelSelection.model } : {}),
              ...(apiModelId ? { apiModelId } : {}),
              ...(requestedContextWindow ? { contextWindow: requestedContextWindow } : {}),
              ...(input.cwd ? { cwd: input.cwd } : {}),
              ...(effectiveEffort ? { effort: effectiveEffort } : {}),
              ...(permissionMode ? { permissionMode } : {}),
              ...(providerOptions?.maxThinkingTokens !== undefined
                ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
                : {}),
              ...(fastMode ? { fastMode: true } : {}),
              ...(ultracode ? { ultracode: true } : {}),
            },
          },
          providerRefs: {},
        });

        const readyStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          eventId: readyStamp.eventId,
          provider: PROVIDER,
          createdAt: readyStamp.createdAt,
          threadId,
          payload: {
            state: "ready",
          },
          providerRefs: {},
        });

        const streamFiber = Effect.runFork(runSdkStream(context));
        context.streamFiber = streamFiber;
        streamFiber.addObserver((exit) => {
          if (context.stopped) {
            return;
          }
          if (context.streamFiber === streamFiber) {
            context.streamFiber = undefined;
          }
          Effect.runFork(handleStreamExit(context, exit));
        });

        return {
          ...session,
        };
      });

    const sendTurn: ClaudeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const modelSelection =
          input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;
        const requestedContextWindowMaxTokens = resolveSelectedClaudeContextWindowMaxTokens(
          modelSelection?.model,
          modelSelection?.options?.contextWindow,
        );

        if (context.turnState) {
          // Auto-close a stale synthetic turn (from background agent responses
          // between user prompts) to prevent blocking the user's next turn.
          yield* completeTurn(context, "completed");
        }

        if (modelSelection?.model) {
          const apiModelId = resolveApiModelId(modelSelection);
          yield* Effect.tryPromise({
            try: () => context.query.setModel(apiModelId),
            catch: (cause) => toRequestError(input.threadId, "turn/setModel", cause),
          });
          context.currentApiModelId = apiModelId;
          if (requestedContextWindowMaxTokens !== undefined) {
            context.lastKnownContextWindow = requestedContextWindowMaxTokens;
          }
        }

        // Apply interaction mode by switching the SDK's permission mode.
        // "plan" maps directly to the SDK's "plan" permission mode;
        // "default" restores the session's original permission mode.
        // When interactionMode is absent we leave the current mode unchanged.
        if (input.interactionMode === "plan") {
          yield* Effect.tryPromise({
            try: () => context.query.setPermissionMode("plan"),
            catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
          });
        } else if (input.interactionMode === "default") {
          yield* Effect.tryPromise({
            try: () => context.query.setPermissionMode(context.basePermissionMode ?? "default"),
            catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
          });
        }

        const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
        const turnState: ClaudeTurnState = {
          turnId,
          startedAt: yield* nowIso,
          interactionMode: input.interactionMode === "plan" ? "plan" : "default",
          items: [],
          assistantTextBlocks: new Map(),
          assistantTextBlockOrder: [],
          reasoningBlocks: new Map(),
          capturedProposedPlanKeys: new Set(),
          sawFileChange: false,
          nextSyntheticAssistantBlockIndex: -1,
        };

        const updatedAt = yield* nowIso;
        context.lastThinkingItemId = undefined;
        context.lastEmittedThinkingTokens = undefined;
        context.turnState = turnState;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt,
        };

        const turnStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.started",
          eventId: turnStartedStamp.eventId,
          provider: PROVIDER,
          createdAt: turnStartedStamp.createdAt,
          threadId: context.session.threadId,
          turnId,
          payload: modelSelection?.model ? { model: modelSelection.model } : {},
          providerRefs: {},
        });

        const message = yield* buildUserMessageEffect(input, {
          fileSystem,
          attachmentsDir: serverConfig.attachmentsDir,
        });

        yield* Queue.offer(context.promptQueue, {
          type: "message",
          message,
        }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)));

        return {
          threadId: context.session.threadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: ClaudeAdapterShape["interruptTurn"] = (threadId, _turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (context.turnState) {
          context.interruptRequestedTurnId = context.turnState.turnId;
        }
        yield* Effect.tryPromise({
          try: () => context.query.interrupt(),
          catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
        });
      });

    const readThread: ClaudeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        return yield* snapshotThread(context);
      });

    const rollbackThread: ClaudeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const nextLength = Math.max(0, context.turns.length - numTurns);
        context.turns.splice(nextLength);
        yield* updateResumeCursor(context);
        return yield* snapshotThread(context);
      });

    const respondToRequest: ClaudeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/requestApproval/decision",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }

        context.pendingApprovals.delete(requestId);
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/tool/respondToUserInput",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }

        context.pendingUserInputs.delete(requestId);
        yield* Deferred.succeed(pending.answers, answers);
      });

    const stopSession: ClaudeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* stopSessionInternal(context, {
          emitExitEvent: true,
        });
      });

    const listSessions: ClaudeAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

    const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      });

    // Native command discovery cache — avoids spawning a process per query.
    let commandsCache: { result: ProviderListCommandsResult; cwd: string } | null = null;
    let pendingCommandDiscovery: Promise<ProviderListCommandsResult> | null = null;

    async function discoverCommandsViaTemporaryProcess(
      cwd: string,
    ): Promise<ProviderListCommandsResult> {
      // Spawn a lightweight Claude Code process for native command discovery.
      // The SDK's supportedCommands() awaits an internal initialization promise
      // that only resolves when the async generator is iterated (driving the
      // subprocess handshake). We iterate in the background to unblock it.
      const tempQuery = createQuery({
        prompt: neverResolvingUserMessageStream(),
        options: {
          cwd,
          pathToClaudeCodeExecutable: "claude",
          settingSources: [...CLAUDE_SETTING_SOURCES],
          permissionMode: "plan" as PermissionMode,
          persistSession: false,
        },
      });

      try {
        // Drive the iterator so the subprocess completes its init handshake.
        // This runs in the background; close() in the finally block stops it.
        void (async () => {
          for await (const message of tempQuery) {
            void message;
            /* consume until closed */
          }
        })().catch(() => undefined);

        const commands = await tempQuery.supportedCommands();
        return mapSupportedCommands(commands);
      } finally {
        tempQuery.close();
      }
    }

    const listCommands: NonNullable<ClaudeAdapterShape["listCommands"]> = (
      input: ProviderListCommandsInput,
    ) =>
      Effect.gen(function* () {
        // 1. Try an active session first (cheapest path).
        const context = input.threadId
          ? sessions.get(ThreadId.makeUnsafe(input.threadId))
          : [...sessions.values()].find((s) => !s.stopped);

        if (context && !context.stopped) {
          const commands = yield* Effect.tryPromise({
            try: () => context.query.supportedCommands(),
            catch: (cause) => toRequestError(context.session.threadId, "listCommands", cause),
          });
          const result = mapSupportedCommands(commands);
          commandsCache = { result, cwd: input.cwd };
          return result;
        }

        // 2. Return from cache if valid and not force-reloading.
        if (commandsCache && commandsCache.cwd === input.cwd && !input.forceReload) {
          return { ...commandsCache.result, cached: true } satisfies ProviderListCommandsResult;
        }

        // 3. Spawn a temporary process for discovery (deduplicating concurrent requests).
        const discoveryPromise =
          pendingCommandDiscovery ?? discoverCommandsViaTemporaryProcess(input.cwd);
        pendingCommandDiscovery = discoveryPromise;

        const result = yield* Effect.tryPromise({
          try: () => discoveryPromise,
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: ThreadId.makeUnsafe("discovery"),
              detail: toMessage(cause, "Failed to discover Claude commands."),
              cause,
            }),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              pendingCommandDiscovery = null;
            }),
          ),
          Effect.tapError(() =>
            Effect.sync(() => {
              pendingCommandDiscovery = null;
            }),
          ),
        );

        commandsCache = { result, cwd: input.cwd };
        return result;
      });

    const listSkills: NonNullable<ClaudeAdapterShape["listSkills"]> = (
      _input: ProviderListSkillsInput,
    ) =>
      Effect.succeed({
        skills: [],
        source: "unsupported",
        cached: false,
      } satisfies ProviderListSkillsResult);

    const stopAll: ClaudeAdapterShape["stopAll"] = () =>
      Effect.forEach(
        sessions,
        ([, context]) =>
          stopSessionInternal(context, {
            emitExitEvent: true,
          }),
        { discard: true },
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        sessions,
        ([, context]) =>
          stopSessionInternal(context, {
            emitExitEvent: false,
          }),
        { discard: true },
      ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
    );

    const composerCapabilities: ProviderComposerCapabilities = {
      provider: PROVIDER,
      supportsSkillMentions: false,
      supportsSkillDiscovery: false,
      supportsNativeSlashCommandDiscovery: true,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: true,
      supportsThreadCompaction: false,
      supportsThreadImport: true,
    };

    const getComposerCapabilities: NonNullable<
      ClaudeAdapterShape["getComposerCapabilities"]
    > = () => Effect.succeed(composerCapabilities);

    const listModels: NonNullable<ClaudeAdapterShape["listModels"]> = (_input) =>
      Effect.sync(() => {
        if (cachedModels) {
          return { ...cachedModels, cached: true };
        }
        // Fallback: try to get models from any active session
        for (const [, context] of sessions) {
          if (!context.stopped && context.query) {
            // Trigger async cache population
            context.query
              .supportedModels()
              .then((models) => {
                cachedModels = {
                  models: models.map((m) => ({ slug: m.value, name: m.displayName })),
                  source: "sdk",
                  cached: false,
                };
              })
              .catch(() => {});
            break;
          }
        }
        // Return empty while waiting for cache
        return { models: [], source: "pending", cached: false };
      });

    const listAgents: NonNullable<ClaudeAdapterShape["listAgents"]> = () =>
      Effect.sync(() => {
        if (cachedAgents) {
          return { ...cachedAgents, cached: true };
        }
        for (const [, context] of sessions) {
          if (!context.stopped && context.query) {
            context.query
              .supportedAgents()
              .then((agents) => {
                cachedAgents = {
                  agents: agents.map((a) => ({
                    name: a.name,
                    displayName: a.name,
                    ...(a.description ? { description: a.description } : {}),
                    ...(a.model ? { model: a.model } : {}),
                  })),
                  source: "sdk",
                  cached: false,
                };
              })
              .catch(() => {});
            break;
          }
        }
        return { agents: [], source: "pending", cached: false };
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsLiveTurnDiffPatch: false,
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      getComposerCapabilities,
      listCommands,
      listSkills,
      listModels,
      listAgents,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeAdapterShape;
  });
}

export const ClaudeAdapterLive = Layer.effect(ClaudeAdapter, makeClaudeAdapter());

export function makeClaudeAdapterLive(options?: ClaudeAdapterLiveOptions) {
  return Layer.effect(ClaudeAdapter, makeClaudeAdapter(options));
}
