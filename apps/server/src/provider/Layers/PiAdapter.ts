import crypto from "node:crypto";
import path from "node:path";

import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type AgentSessionEvent,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  type ChatAttachment,
  EventId,
  type ProviderComposerCapabilities,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  type ProviderListSkillsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type UserInputQuestion,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Queue, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { classifyPiTurnFailure } from "../piTurnFailure.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { makePiEventHandler } from "./PiAdapter.events.ts";
import {
  findModelInRegistry,
  getPiSupportedThinkingOptions,
  normalizePiThinkingLevel,
} from "./PiAdapter.models.ts";
import {
  extensionDisplayName,
  extractResumeSessionFile,
  getSessionFile,
  makeAgentDir,
  makeSessionSnapshot,
  mapMessageHistory,
} from "./PiAdapter.session.ts";
import {
  classifyPiRuntimeError,
  isPiReloadCommand,
  runtimeErrorDetail,
  toMessage,
  trimToUndefined,
} from "./PiAdapter.shared.ts";
import { normalizeTokenUsage } from "./PiAdapter.token.ts";
import {
  DEFAULT_PI_THINKING_LEVEL,
  PROVIDER,
  type PiAdapterLiveOptions,
  type PiSessionContext,
} from "./PiAdapter.types.ts";

export { getPiSupportedThinkingOptions };
export type { PiAdapterLiveOptions };

interface PiUserInputOptionMapping {
  readonly value: string;
  readonly option: UserInputQuestion["options"][number];
}

export function makePiUserInputOptions(
  labels: ReadonlyArray<string>,
): ReadonlyArray<PiUserInputOptionMapping> {
  const labelCounts = new Map<string, number>();
  return labels.map((label, index) => {
    const baseLabel = trimToUndefined(label) ?? `Option ${index + 1}`;
    const count = (labelCounts.get(baseLabel) ?? 0) + 1;
    labelCounts.set(baseLabel, count);
    const displayLabel = count === 1 ? baseLabel : `${baseLabel} (${count})`;
    return {
      value: label,
      option: { label: displayLabel, description: baseLabel },
    };
  });
}

export const PLAIN_PI_EXTENSION_THEME = {
  fg(_color: string, text: string): string {
    return text;
  },
  bg(_color: string, text: string): string {
    return text;
  },
  bold(text: string): string {
    return text;
  },
  italic(text: string): string {
    return text;
  },
  underline(text: string): string {
    return text;
  },
  inverse(text: string): string {
    return text;
  },
  strikethrough(text: string): string {
    return text;
  },
  getThinkingBorderColor(_level: string): (text: string) => string {
    return (text) => text;
  },
} as const;

const makePiAdapter = (options?: PiAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, PiSessionContext>();
    const modelRegistries = new Map<string, ModelRegistry>();
    const ownsNativeEventLogger = options?.nativeEventLogger === undefined;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);

    const getModelRegistry = (agentDir: string): ModelRegistry => {
      const existing = modelRegistries.get(agentDir);
      if (existing) return existing;
      const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
      const registry = ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
      modelRegistries.set(agentDir, registry);
      return registry;
    };

    const makeEventBase = (
      context: PiSessionContext,
      options?: { readonly includeTurnId?: boolean },
    ) => ({
      eventId: EventId.makeUnsafe(crypto.randomUUID()),
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      ...(options?.includeTurnId !== false && context.activeTurnId
        ? { turnId: context.activeTurnId }
        : {}),
    });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) => {
      Effect.runPromise(Queue.offer(runtimeEventQueue, event)).catch(() => undefined);
      if (nativeEventLogger && event.raw) {
        Effect.runPromise(nativeEventLogger.write(event.raw, event.threadId)).catch(
          () => undefined,
        );
      }
    };

    const offerRuntimeError = (
      context: PiSessionContext,
      input: {
        readonly message: string;
        readonly cause?: unknown;
        readonly method: string;
        readonly messageType?: string;
      },
    ) => {
      offerRuntimeEvent({
        ...makeEventBase(context, { includeTurnId: false }),
        type: "runtime.error",
        payload: {
          message: input.message,
          class: classifyPiRuntimeError(input.message),
          ...(input.cause !== undefined ? { detail: runtimeErrorDetail(input.cause) } : {}),
        },
        raw: {
          source: "pi.sdk.event",
          method: input.method,
          ...(input.messageType ? { messageType: input.messageType } : {}),
          payload: input.cause ?? { message: input.message },
        },
      } satisfies ProviderRuntimeEvent);
    };

    const completePromptRejection = (context: PiSessionContext, turnId: TurnId, cause: unknown) => {
      if (context.activeTurnId !== turnId) {
        return;
      }

      const message = toMessage(cause, "Pi turn failed.");
      const failure = classifyPiTurnFailure(message);
      const completionBase = makeEventBase(context);
      if (failure.state === "failed") {
        offerRuntimeError(context, { message, method: "prompt", cause });
      }
      context.activeTurnId = undefined;
      context.activeAssistantItemId = undefined;
      context.activeReasoningItemId = undefined;
      context.activeToolItems.clear();
      context.session = makeSessionSnapshot(context);
      offerRuntimeEvent({
        ...completionBase,
        type: "turn.completed",
        payload: {
          state: failure.state,
          stopReason: failure.stopReason,
          errorMessage: message,
        },
        raw: { source: "pi.sdk.event", method: "prompt", payload: cause },
      } satisfies ProviderRuntimeEvent);
    };

    const recordItem = (context: PiSessionContext, item: unknown) => {
      const turn = context.activeTurnId
        ? context.turns.find((candidate) => candidate.id === context.activeTurnId)
        : context.turns.at(-1);
      turn?.items.push(item);
    };

    const requireSession = Effect.fn("PiAdapter.requireSession")(function* (threadId: ThreadId) {
      const context = sessions.get(threadId);
      if (!context) {
        return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      }
      if (context.stopped) {
        return yield* new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
      }
      return context;
    });

    const disposeSessionContext = async (context: PiSessionContext) => {
      context.unsubscribe?.();
      context.unsubscribe = undefined;
      context.stopped = true;
      await context.runtime.dispose();
    };

    const { handleSessionEvent } = makePiEventHandler({
      makeEventBase,
      offerRuntimeEvent,
      offerRuntimeError,
      recordItem,
    });

    const createSdkRuntime = async (input: {
      cwd: string;
      agentDir: string;
      sessionManager: SessionManager;
      modelId?: string;
      thinkingLevel?: ThinkingLevel;
    }) => {
      const registry = getModelRegistry(input.agentDir);
      const createRuntime: CreateAgentSessionRuntimeFactory = async ({
        cwd,
        agentDir,
        sessionManager,
        sessionStartEvent,
      }) => {
        const services = await createAgentSessionServices({
          cwd,
          agentDir,
          modelRegistry: registry,
        });
        const model = findModelInRegistry(services.modelRegistry, input.modelId);
        if (input.modelId && !model) {
          throw new Error(
            `Pi model '${input.modelId}' is not available. Use a discovered model or a provider-qualified custom model slug like 'openai/gpt-5.5'.`,
          );
        }
        return {
          ...(await createAgentSessionFromServices({
            services,
            sessionManager,
            ...(sessionStartEvent ? { sessionStartEvent } : {}),
            ...(model ? { model } : {}),
            thinkingLevel: input.thinkingLevel ?? DEFAULT_PI_THINKING_LEVEL,
          })),
          services,
          diagnostics: services.diagnostics,
        };
      };
      const runtime = await createAgentSessionRuntime(createRuntime, {
        cwd: input.sessionManager.getCwd(),
        agentDir: input.agentDir,
        sessionManager: input.sessionManager,
      });
      await runtime.session.bindExtensions({});
      return { runtime, modelRegistry: runtime.services.modelRegistry };
    };

    const startSession: PiAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        const cwd = trimToUndefined(input.cwd) ?? serverConfig.cwd;
        const agentDir = makeAgentDir(input.providerOptions?.pi?.agentDir);
        const sessionFile = extractResumeSessionFile(input.resumeCursor);
        const sessionManager = sessionFile
          ? SessionManager.open(sessionFile, undefined, cwd)
          : SessionManager.create(cwd);
        const modelId =
          input.modelSelection?.provider === "pi" ? input.modelSelection.model : undefined;
        const thinkingLevel =
          input.modelSelection?.provider === "pi"
            ? normalizePiThinkingLevel(input.modelSelection.options?.thinkingLevel)
            : undefined;
        const existingContext = sessions.get(input.threadId);
        if (existingContext) {
          sessions.delete(input.threadId);
          yield* Effect.tryPromise({
            try: () => disposeSessionContext(existingContext),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/restart",
                detail: toMessage(cause, "Failed to dispose previous Pi session."),
                cause,
              }),
          });
        }
        const { runtime, modelRegistry } = yield* Effect.tryPromise({
          try: () =>
            createSdkRuntime({
              cwd,
              agentDir,
              sessionManager,
              ...(modelId ? { modelId } : {}),
              ...(thinkingLevel ? { thinkingLevel } : {}),
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/start",
              detail: toMessage(cause, "Failed to start Pi session."),
              cause,
            }),
        });
        const now = new Date().toISOString();
        const model = runtime.session.model
          ? `${runtime.session.model.provider}/${runtime.session.model.id}`
          : modelId;
        const resumeCursor = getSessionFile(runtime.session);
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          threadId: input.threadId,
          createdAt: now,
          updatedAt: now,
          ...(model ? { model } : {}),
          ...(resumeCursor ? { resumeCursor } : {}),
        };
        const context: PiSessionContext = {
          runtime,
          modelRegistry,
          session,
          turns: [],
          activeTurnId: undefined,
          activeAssistantItemId: undefined,
          activeReasoningItemId: undefined,
          activeToolItems: new Map(),
          stopped: false,
          lastKnownTokenUsage: undefined,
          unsubscribe: undefined,
        };
        context.unsubscribe = runtime.session.subscribe((event) =>
          handleSessionEvent(context, event),
        );
        sessions.set(input.threadId, context);
        const loadedExtensions = runtime.session.resourceLoader.getExtensions().extensions;
        if (loadedExtensions.length > 0) {
          const extensionNames = loadedExtensions.map(extensionDisplayName);
          offerRuntimeEvent({
            ...makeEventBase(context, { includeTurnId: false }),
            type: "runtime.warning",
            payload: {
              message:
                "Pi extensions are loaded, but Synara does not yet support Pi extension UI APIs. Non-UI extension behavior should work, but extensions that call ctx.ui.* for prompts, widgets, confirmations, or status updates may not behave correctly.",
              detail: {
                extensionCount: loadedExtensions.length,
                extensions: extensionNames,
              },
            },
            raw: {
              source: "pi.sdk.event",
              method: "extension/ui-unsupported-warning",
              payload: { extensionCount: loadedExtensions.length, extensions: extensionNames },
            },
          } satisfies ProviderRuntimeEvent);
        }
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "session.started",
          payload: { message: "Pi session started", resume: session.resumeCursor },
        } satisfies ProviderRuntimeEvent);
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "thread.started",
          payload: { providerThreadId: runtime.session.sessionId },
        } satisfies ProviderRuntimeEvent);
        const initialUsage = normalizeTokenUsage(
          runtime.session.getSessionStats(),
          runtime.session.model?.contextWindow,
        );
        context.lastKnownTokenUsage = initialUsage;
        if (initialUsage) {
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "thread.token-usage.updated",
            payload: { usage: initialUsage },
          } satisfies ProviderRuntimeEvent);
        }
        return session;
      });

    const buildPromptPayload = (input: {
      readonly input?: string | undefined;
      readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
    }) =>
      Effect.gen(function* () {
        const text = input.input ?? "";
        const images = yield* Effect.forEach(
          input.attachments ?? [],
          (attachment) =>
            Effect.gen(function* () {
              if (attachment.type !== "image" || !attachment.mimeType) return undefined;
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "turn/start",
                  issue: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "turn/start",
                      detail: toMessage(cause, "Failed to read attachment file."),
                      cause,
                    }),
                ),
              );
              return {
                type: "image" as const,
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              };
            }),
          { concurrency: 1 },
        );
        return {
          text,
          images: images.filter((image): image is ImageContent => image !== undefined),
        };
      });

    const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        if (context.activeTurnId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "A Pi turn is already active for this thread.",
          });
        }
        if (input.modelSelection?.provider === "pi") {
          const model = findModelInRegistry(context.modelRegistry, input.modelSelection.model);
          if (!model) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "model/set",
              issue: `Pi model '${input.modelSelection.model}' is not available. Use a discovered model or a provider-qualified custom model slug like 'openai/gpt-5.5'.`,
            });
          }
          yield* Effect.tryPromise({
            try: () => context.runtime.session.setModel(model),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "model/set",
                detail: toMessage(cause, "Failed to set Pi model."),
                cause,
              }),
          });
          const thinkingLevel = normalizePiThinkingLevel(
            input.modelSelection.options?.thinkingLevel,
          );
          if (thinkingLevel) {
            context.runtime.session.setThinkingLevel(thinkingLevel);
          }
        }
        const payload = yield* buildPromptPayload(input);
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        context.activeTurnId = turnId;
        context.turns.push({ id: turnId, items: [] });
        context.session = makeSessionSnapshot(context);
        if (payload.images.length === 0 && isPiReloadCommand(payload.text)) {
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
            raw: { source: "pi.sdk.event", method: "reload", payload: { command: payload.text } },
          } satisfies ProviderRuntimeEvent);
          yield* Effect.tryPromise({
            try: () => context.runtime.session.reload(),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/reload",
                detail: toMessage(cause, "Failed to reload Pi resources."),
                cause,
              }),
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const message = error.message;
                offerRuntimeEvent({
                  ...makeEventBase(context),
                  type: "turn.completed",
                  payload: { state: "failed", stopReason: "error", errorMessage: message },
                  raw: { source: "pi.sdk.event", method: "reload", payload: error },
                } satisfies ProviderRuntimeEvent);
                offerRuntimeError(context, {
                  message,
                  method: "session/reload",
                  cause: error,
                });
                context.activeTurnId = undefined;
                context.session = makeSessionSnapshot(context);
                return yield* Effect.fail(error);
              }),
            ),
          );
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "turn.completed",
            payload: { state: "completed", stopReason: "reload" },
            raw: { source: "pi.sdk.event", method: "reload", payload: { command: payload.text } },
          } satisfies ProviderRuntimeEvent);
          context.activeTurnId = undefined;
          context.session = makeSessionSnapshot(context);
          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: getSessionFile(context.runtime.session),
          };
        }
        void context.runtime.session
          .prompt(payload.text, payload.images.length > 0 ? { images: payload.images } : undefined)
          .catch((cause) => {
            completePromptRejection(context, turnId, cause);
          });
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: getSessionFile(context.runtime.session),
        };
      });

    const steerTurn: NonNullable<PiAdapterShape["steerTurn"]> = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const payload = yield* buildPromptPayload(input);
        const turnId = context.activeTurnId ?? TurnId.makeUnsafe(crypto.randomUUID());
        if (!context.activeTurnId) {
          context.activeTurnId = turnId;
          context.turns.push({ id: turnId, items: [] });
        }
        if (context.runtime.session.isStreaming) {
          yield* Effect.tryPromise({
            try: () => context.runtime.session.steer(payload.text, payload.images),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/steer",
                detail: toMessage(cause, "Failed to steer Pi turn."),
                cause,
              }),
          });
        } else {
          void context.runtime.session
            .prompt(
              payload.text,
              payload.images.length > 0 ? { images: payload.images } : undefined,
            )
            .catch((cause) => {
              completePromptRejection(context, turnId, cause);
            });
        }
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: getSessionFile(context.runtime.session),
        };
      });

    const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          Effect.tryPromise({
            try: () => context.runtime.session.abort(),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/interrupt",
                detail: toMessage(cause, "Failed to interrupt Pi turn."),
                cause,
              }),
          }),
        ),
        Effect.asVoid,
      );

    const respondUnsupported = (threadId: ThreadId, method: string) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: `Pi does not expose Synara approval/user-input requests for thread ${threadId}.`,
        }),
      );

    const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          Effect.tryPromise({
            try: () => disposeSessionContext(context),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/stop",
                detail: toMessage(cause, "Failed to stop Pi session."),
                cause,
              }),
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                context.stopped = true;
                sessions.delete(threadId);
                offerRuntimeEvent({
                  ...makeEventBase(context),
                  type: "thread.state.changed",
                  payload: { state: "closed", detail: { reason: "stopped" } },
                } satisfies ProviderRuntimeEvent);
                offerRuntimeEvent({
                  ...makeEventBase(context),
                  type: "session.exited",
                  payload: { reason: "stopped", exitKind: "graceful" },
                } satisfies ProviderRuntimeEvent);
              }),
            ),
          ),
        ),
        Effect.asVoid,
      );

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values()).map(makeSessionSnapshot));

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const snapshotThread = (context: PiSessionContext): ProviderThreadSnapshot => {
      const historyItems = mapMessageHistory(context.runtime.session);
      const activeTurn = context.activeTurnId
        ? context.turns.find((turn) => turn.id === context.activeTurnId)
        : undefined;
      const turns = [
        ...(historyItems.length > 0
          ? [
              {
                id: TurnId.makeUnsafe(`pi-history-${context.runtime.session.sessionId}`),
                items: historyItems,
              },
            ]
          : []),
        ...(activeTurn ? [{ id: activeTurn.id, items: [...activeTurn.items] }] : []),
      ];
      return {
        threadId: context.session.threadId,
        ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
        turns:
          turns.length > 0
            ? turns
            : context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
      };
    };

    const readThread: PiAdapterShape["readThread"] = (threadId) =>
      requireSession(threadId).pipe(Effect.map(snapshotThread));

    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const nextLength = Math.max(0, context.turns.length - Math.max(0, numTurns));
        context.turns.splice(nextLength);
        const leafId = context.turns.at(-1)?.leafId;
        if (leafId) {
          context.runtime.session.sessionManager.branch(leafId);
        } else if (nextLength === 0) {
          context.runtime.session.sessionManager.resetLeaf();
        }
        return snapshotThread(context);
      });

    const compactThread: NonNullable<PiAdapterShape["compactThread"]> = (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          Effect.tryPromise({
            try: () => context.runtime.session.compact(),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread/compact",
                detail: toMessage(cause, "Failed to compact Pi thread."),
                cause,
              }),
          }),
        ),
        Effect.asVoid,
      );

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.keys()), (threadId) => stopSession(threadId), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.asVoid);

    const listModels: NonNullable<PiAdapterShape["listModels"]> = (input) =>
      Effect.tryPromise({
        try: async () => {
          const agentDir = makeAgentDir(input.agentDir);
          const registry = getModelRegistry(agentDir);
          registry.refresh();
          const models = registry.getAvailable().map((model) => {
            const supportedThinkingOptions = getPiSupportedThinkingOptions(model);
            return {
              slug: `${model.provider}/${model.id}`,
              name: model.name,
              upstreamProviderId: model.provider,
              upstreamProviderName: registry.getProviderDisplayName(model.provider),
              ...(supportedThinkingOptions.length > 0
                ? {
                    supportedReasoningEfforts: supportedThinkingOptions.map((option) => ({
                      value: option.value,
                      label: option.label,
                      description: option.description,
                    })),
                    ...(supportedThinkingOptions.some(
                      (option) => option.value === DEFAULT_PI_THINKING_LEVEL,
                    )
                      ? { defaultReasoningEffort: DEFAULT_PI_THINKING_LEVEL }
                      : {}),
                  }
                : {}),
            };
          });
          return { models, source: "pi.sdk", cached: false } satisfies ProviderListModelsResult;
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: toMessage(cause, "Failed to list Pi models."),
            cause,
          }),
      });

    const listSkills: NonNullable<PiAdapterShape["listSkills"]> = (input) =>
      Effect.tryPromise({
        try: async () => {
          const active = input.threadId
            ? sessions.get(ThreadId.makeUnsafe(input.threadId))
            : undefined;
          const loader = active?.runtime.session.resourceLoader;
          if (active && input.forceReload) {
            await active.runtime.session.reload();
          }
          const services = loader
            ? undefined
            : await createAgentSessionServices({
                cwd: input.cwd,
                agentDir: makeAgentDir(input.agentDir),
              });
          if (services && input.forceReload) {
            await services.resourceLoader.reload();
          }
          const result = (loader ?? services!.resourceLoader).getSkills();
          return {
            skills: result.skills.map((skill) => {
              const description = trimToUndefined(skill.description);
              const scope = trimToUndefined(skill.sourceInfo.source);
              return {
                name: skill.name,
                ...(description ? { description } : {}),
                path: skill.filePath,
                enabled: !skill.disableModelInvocation,
                ...(scope ? { scope } : {}),
              };
            }),
            source: "pi.sdk",
            cached: false,
          } satisfies ProviderListSkillsResult;
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "skill/list",
            detail: toMessage(cause, "Failed to list Pi skills."),
            cause,
          }),
      });

    const listCommands: NonNullable<PiAdapterShape["listCommands"]> = (input) =>
      Effect.tryPromise({
        try: async () => {
          const active = input.threadId
            ? sessions.get(ThreadId.makeUnsafe(input.threadId))
            : undefined;
          const session = active?.runtime.session;
          const reloadCommand = {
            name: "reload",
            description: "Reload Pi extensions, skills, prompts, themes, tools, and settings",
          };
          if (session) {
            if (input.forceReload) {
              await session.reload();
            }
            const extensionCommands = session.extensionRunner
              .getRegisteredCommands()
              .map((command) => ({
                name: command.invocationName,
                description: trimToUndefined(command.description) ?? "Extension command",
              }));
            const promptCommands = session.promptTemplates.map((template) => ({
              name: template.name,
              description: trimToUndefined(template.description) ?? "Prompt template",
            }));
            const skillCommands = session.resourceLoader.getSkills().skills.map((skill) => ({
              name: `skill:${skill.name}`,
              description: trimToUndefined(skill.description) ?? "Skill",
            }));
            return {
              commands: [reloadCommand, ...extensionCommands, ...promptCommands, ...skillCommands],
              source: "pi.sdk",
              cached: false,
            } satisfies ProviderListCommandsResult;
          }
          const services = await createAgentSessionServices({
            cwd: input.cwd,
            agentDir: makeAgentDir(input.agentDir),
          });
          if (input.forceReload) {
            await services.resourceLoader.reload();
          }
          const promptCommands = services.resourceLoader.getPrompts().prompts.map((template) => ({
            name: template.name,
            description: trimToUndefined(template.description) ?? "Prompt template",
          }));
          const skillCommands = services.resourceLoader.getSkills().skills.map((skill) => ({
            name: `skill:${skill.name}`,
            description: trimToUndefined(skill.description) ?? "Skill",
          }));
          return {
            commands: [reloadCommand, ...promptCommands, ...skillCommands],
            source: "pi.sdk",
            cached: false,
          } satisfies ProviderListCommandsResult;
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "command/list",
            detail: toMessage(cause, "Failed to list Pi commands."),
            cause,
          }),
      });

    const getComposerCapabilities: NonNullable<PiAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: true,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.ignore,
        Effect.andThen(
          ownsNativeEventLogger && nativeEventLogger
            ? nativeEventLogger.close().pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.andThen(Queue.shutdown(runtimeEventQueue)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsTurnSteering: true,
      },
      startSession,
      sendTurn,
      steerTurn,
      interruptTurn,
      respondToRequest: (threadId) => respondUnsupported(threadId, "request/respond"),
      respondToUserInput: (threadId) => respondUnsupported(threadId, "user-input/respond"),
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      compactThread,
      stopAll,
      listModels,
      listSkills,
      listCommands,
      getComposerCapabilities,
      get streamEvents() {
        return Stream.fromQueue(runtimeEventQueue);
      },
    } satisfies PiAdapterShape;
  });

export const PiAdapterLive = Layer.effect(PiAdapter, makePiAdapter());

export function makePiAdapterLive(options?: PiAdapterLiveOptions) {
  return Layer.effect(PiAdapter, makePiAdapter(options));
}
