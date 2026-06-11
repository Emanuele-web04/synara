import { randomUUID } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ProviderComposerCapabilities,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Cause, Effect, Exit, Layer, Queue, Ref, Scope, Stream } from "effect";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../Errors.ts";
import { KiloAdapter, type KiloAdapterShape } from "../Services/KiloAdapter.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  buildOpenCodePermissionRules,
  type OpenCodeInventory,
  OpenCodeRuntime,
  OpenCodeRuntimeLive,
  OpenCodeRuntimeError,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
} from "../opencodeRuntime.ts";
import { withProviderPlanModePrompt } from "../planMode.ts";
import type { OpenCodeMessageSnapshot } from "./OpenCodeAdapter.types.ts";
import {
  KILO_ADAPTER_CONFIG,
  OPENCODE_ADAPTER_CONFIG,
  OPENCODE_PROMPT_ACCEPTED_ACTIVITY_TIMEOUT_MS,
  OPENCODE_PROMPT_ACCEPTED_RECOVERY_DELAYS_MS,
  OPENCODE_PROMPT_SUBMISSION_INLINE_WAIT_MS,
} from "./OpenCodeAdapter.config.ts";
import {
  buildOpenCodeModelContextLimitMap,
  flattenOpenCodeAgents,
  flattenOpenCodeModels,
  mergeOpenCodeCliModelDescriptors,
  resolvePreferredOpenCodeModelProviders,
} from "./OpenCodeAdapter.models.ts";
import {
  buildOpenCodeThreadSnapshot,
  buildProviderEventBase,
  extractResumeSessionId,
  nowIso,
} from "./OpenCodeAdapter.events.ts";
import {
  clearActiveTurnState,
  ensureSessionContext,
  type OpenCodeAdapterLiveOptions,
  type OpenCodeEmitDeps,
  type OpenCodeSessionContext,
  replaceModelContextLimits,
  stopOpenCodeContext,
  toProcessError,
  toRequestError,
  updateProviderSession,
} from "./OpenCodeAdapter.runtime.ts";
import { makeOpenCodeEmitters } from "./OpenCodeAdapter.emitters.ts";
import { makeOpenCodeTurn } from "./OpenCodeAdapter.turn.ts";
import { makeOpenCodePrompt } from "./OpenCodeAdapter.prompt.ts";
import { makeOpenCodeEventHandler } from "./OpenCodeAdapter.eventHandler.ts";

export {
  flattenOpenCodeCliModels,
  flattenOpenCodeModels,
  resolvePreferredOpenCodeModelProviders,
} from "./OpenCodeAdapter.models.ts";
export { normalizeOpenCodeTokenUsage } from "./OpenCodeAdapter.token.ts";

export type { OpenCodeAdapterLiveOptions } from "./OpenCodeAdapter.runtime.ts";

export function makeOpenCodeAdapterLive(options?: OpenCodeAdapterLiveOptions) {
  const adapterConfig = options?.adapterConfig ?? OPENCODE_ADAPTER_CONFIG;
  return Layer.effect(
    OpenCodeAdapter,
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const openCodeRuntime = yield* OpenCodeRuntime;
      const provider = adapterConfig.provider;
      const buildEventBase = (
        input: Omit<
          Parameters<typeof buildProviderEventBase>[0],
          "provider" | "runtimeEventSource"
        >,
      ) =>
        buildProviderEventBase({
          provider,
          runtimeEventSource: adapterConfig.runtimeEventSource,
          ...input,
        });
      const toAdapterRequestError = (cause: OpenCodeRuntimeError) =>
        toRequestError(provider, cause);
      const toAdapterProcessError = (threadId: ThreadId, cause: unknown) =>
        toProcessError(provider, threadId, cause);
      const ensureAdapterSessionContext = (threadId: ThreadId) =>
        ensureSessionContext(provider, sessions, threadId);
      const promptAcceptedActivityTimeoutMs =
        options?.promptAcceptedActivityTimeoutMs ?? OPENCODE_PROMPT_ACCEPTED_ACTIVITY_TIMEOUT_MS;
      const promptAcceptedRecoveryDelaysMs =
        options?.promptAcceptedRecoveryDelaysMs?.filter(
          (delayMs) => Number.isFinite(delayMs) && delayMs > 0,
        ) ?? OPENCODE_PROMPT_ACCEPTED_RECOVERY_DELAYS_MS;
      const promptSubmissionInlineWaitMs =
        options?.promptSubmissionInlineWaitMs ?? OPENCODE_PROMPT_SUBMISSION_INLINE_WAIT_MS;
      const nativeEventLogger =
        options?.nativeEventLogger ??
        (options?.nativeEventLogPath !== undefined
          ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
              stream: "native",
            })
          : undefined);
      const managedNativeEventLogger =
        options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
      const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const sessions = new Map<ThreadId, OpenCodeSessionContext>();

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const contexts = [...sessions.values()];
          sessions.clear();
          yield* Effect.forEach(
            contexts,
            (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
            { concurrency: "unbounded", discard: true },
          );
          if (managedNativeEventLogger !== undefined) {
            yield* managedNativeEventLogger.close();
          }
        }),
      );

      const emit = (event: ProviderRuntimeEvent) =>
        Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
      const writeNativeEvent = (
        threadId: ThreadId,
        event: {
          readonly observedAt: string;
          readonly event: Record<string, unknown>;
        },
      ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
      const writeNativeEventBestEffort = (
        threadId: ThreadId,
        event: {
          readonly observedAt: string;
          readonly event: Record<string, unknown>;
        },
      ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

      const emitDeps: OpenCodeEmitDeps = {
        provider,
        adapterConfig,
        emit,
        buildEventBase,
        sessions,
      };
      const emitters = makeOpenCodeEmitters(emitDeps);

      const turn = makeOpenCodeTurn({ ...emitDeps, emitters });
      const { captureOpenCodeRecoveryBaseline } = turn;

      const { schedulePromptAcceptedWatchdog, submitOpenCodePrompt, submitOpenCodePromptAsync } =
        makeOpenCodePrompt({
          ...emitDeps,
          turn,
          toAdapterRequestError,
          promptAcceptedActivityTimeoutMs,
          promptAcceptedRecoveryDelaysMs,
          promptSubmissionInlineWaitMs,
        });

      const { rememberCurrentMessageSnapshots, startKiloTurnSnapshotWatchdog, startEventPump } =
        makeOpenCodeEventHandler({
          ...emitDeps,
          emitters,
          turn,
          writeNativeEventBestEffort,
        });

      const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
        function* (input) {
          const providerOptions = input.providerOptions?.[adapterConfig.providerOptionsKey];
          const binaryPath = providerOptions?.binaryPath?.trim() || adapterConfig.defaultBinaryPath;
          const serverUrl = providerOptions?.serverUrl?.trim();
          const serverPassword = providerOptions?.serverPassword?.trim();
          const experimentalWebSockets =
            adapterConfig.providerOptionsKey === "opencode" &&
            providerOptions &&
            "experimentalWebSockets" in providerOptions
              ? providerOptions.experimentalWebSockets === true
              : undefined;
          const directory = input.cwd ?? serverConfig.cwd;
          const initialParsedModel =
            input.modelSelection?.provider === adapterConfig.provider
              ? parseOpenCodeModelSlug(input.modelSelection.model)
              : null;
          const initialAgent =
            input.modelSelection?.provider === adapterConfig.provider
              ? input.modelSelection.options?.agent
              : undefined;
          const initialVariant =
            input.modelSelection?.provider === adapterConfig.provider
              ? input.modelSelection.options?.variant
              : undefined;
          const existing = sessions.get(input.threadId);
          if (existing) {
            yield* stopOpenCodeContext(existing);
            sessions.delete(input.threadId);
          }

          const resumedSessionId = extractResumeSessionId(input.resumeCursor);

          const started = yield* Effect.gen(function* () {
            const sessionScope = yield* Scope.make();
            const startedExit = yield* Effect.exit(
              Effect.gen(function* () {
                const server = yield* openCodeRuntime.connectToOpenCodeServer({
                  binaryPath,
                  cliSpec: adapterConfig.cliSpec,
                  ...(serverUrl ? { serverUrl } : {}),
                  ...(experimentalWebSockets !== undefined ? { experimentalWebSockets } : {}),
                });
                const client = openCodeRuntime.createOpenCodeSdkClient({
                  baseUrl: server.url,
                  directory,
                  cliSpec: adapterConfig.cliSpec,
                  ...(server.external && serverPassword ? { serverPassword } : {}),
                });
                const openCodeSessionId =
                  resumedSessionId ??
                  (yield* runOpenCodeSdk("session.create", () => {
                    const sessionCreateInput = {
                      ...(initialParsedModel
                        ? {
                            model: {
                              providerID: initialParsedModel.providerID,
                              id: initialParsedModel.modelID,
                              ...(initialVariant ? { variant: initialVariant } : {}),
                            },
                          }
                        : {}),
                      ...(initialAgent ? { agent: initialAgent } : {}),
                      permission: buildOpenCodePermissionRules(input.runtimeMode),
                      title: `Synara ${input.threadId}`,
                    };
                    return client.session.create(
                      sessionCreateInput as unknown as Parameters<typeof client.session.create>[0],
                    );
                  }).pipe(
                    Effect.flatMap((sessionResult) =>
                      sessionResult.data?.id
                        ? Effect.succeed(sessionResult.data.id)
                        : Effect.fail(
                            new OpenCodeRuntimeError({
                              operation: "session.create",
                              detail: `${adapterConfig.displayName} session.create returned no session payload.`,
                            }),
                          ),
                    ),
                  ));

                return { sessionScope, server, client, openCodeSessionId };
              }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
            );
            if (Exit.isFailure(startedExit)) {
              yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
              return yield* toAdapterProcessError(input.threadId, Cause.squash(startedExit.cause));
            }
            return startedExit.value;
          });

          const raceWinner = sessions.get(input.threadId);
          if (raceWinner) {
            yield* runOpenCodeSdk("session.abort", () =>
              started.client.session.abort({
                sessionID: started.openCodeSessionId,
              }),
            ).pipe(Effect.ignore);
            yield* Scope.close(started.sessionScope, Exit.void).pipe(Effect.ignore);
            return raceWinner.session;
          }

          const createdAt = nowIso();
          const modelContextLimitBySlug = yield* openCodeRuntime
            .loadOpenCodeInventory(started.client)
            .pipe(
              Effect.map(buildOpenCodeModelContextLimitMap),
              Effect.catchCause(() => Effect.succeed(new Map<string, number>())),
            );
          const session: ProviderSession = {
            provider,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd: directory,
            ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
            threadId: input.threadId,
            resumeCursor: { openCodeSessionId: started.openCodeSessionId },
            createdAt,
            updatedAt: createdAt,
          };

          const context: OpenCodeSessionContext = {
            session,
            client: started.client,
            server: started.server,
            directory,
            openCodeSessionId: started.openCodeSessionId,
            pendingPermissions: new Map(),
            pendingQuestions: new Map(),
            pendingTextDeltasByPartId: new Map(),
            partById: new Map(),
            partSnapshotKeyById: new Map(),
            emittedTextByPartId: new Map(),
            messageRoleById: new Map(),
            messageSnapshotKeyById: new Map(),
            completedAssistantPartIds: new Set(),
            turns: [],
            modelContextLimitBySlug,
            lastKnownTokenUsage: undefined,
            lastEmittedTokenUsageKey: undefined,
            latestTurnCostUsd: undefined,
            activeTurnId: undefined,
            activeTurnEventSerial: 0,
            activeTurnProviderActivitySerial: 0,
            activeTurnCompletionActivitySerial: 0,
            activeTurnSawToolCallFinish: false,
            activeTurnSawFinalAssistant: false,
            activeTurnToolCallIdleWatchdogStarted: false,
            activeInteractionMode: undefined,
            activeAgent: undefined,
            activeVariant: undefined,
            stopped: yield* Ref.make(false),
            sessionScope: started.sessionScope,
          };
          sessions.set(input.threadId, context);
          yield* startEventPump(context);

          yield* emit({
            ...buildEventBase({ threadId: input.threadId }),
            type: "session.started",
            payload: {
              message: resumedSessionId
                ? `${adapterConfig.displayName} session resumed`
                : `${adapterConfig.displayName} session started`,
              resume: { openCodeSessionId: started.openCodeSessionId },
            },
          });
          yield* emit({
            ...buildEventBase({ threadId: input.threadId }),
            type: "thread.started",
            payload: {
              providerThreadId: started.openCodeSessionId,
            },
          });

          return session;
        },
      );

      const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
        const context = ensureAdapterSessionContext(input.threadId);
        const turnId = TurnId.makeUnsafe(`${adapterConfig.turnIdPrefix}-${randomUUID()}`);
        const modelSelection =
          input.modelSelection ??
          (context.session.model ? { provider, model: context.session.model } : undefined);
        const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
        if (!parsedModel) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "sendTurn",
            issue: `${adapterConfig.displayName} model selection must use the 'provider/model' format.`,
          });
        }

        const text = withProviderPlanModePrompt({
          text: input.input?.trim() ?? "",
          interactionMode: input.interactionMode,
        }).trim();
        const fileParts = toOpenCodeFileParts({
          attachments: input.attachments,
          resolveAttachmentPath: (attachment) =>
            resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            }),
        });
        if ((!text || text.length === 0) && fileParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "sendTurn",
            issue: `${adapterConfig.displayName} turns require text input or at least one attachment.`,
          });
        }

        const agent =
          input.modelSelection?.provider === provider
            ? input.modelSelection.options?.agent
            : undefined;
        const variant =
          input.modelSelection?.provider === provider
            ? input.modelSelection.options?.variant
            : undefined;

        context.activeTurnId = turnId;
        context.activeTurnEventSerial = 0;
        context.activeTurnProviderActivitySerial = 0;
        context.activeTurnCompletionActivitySerial = 0;
        context.activeTurnSawToolCallFinish = false;
        context.activeTurnSawFinalAssistant = false;
        context.activeTurnToolCallIdleWatchdogStarted = false;
        context.activeInteractionMode = input.interactionMode === "plan" ? "plan" : "default";
        // Always pin Synara's interaction mode to OpenCode's primary agent.
        // Otherwise a user config with default agent=plan can trap default turns in plan mode.
        context.activeAgent =
          agent ??
          (input.interactionMode === "plan" ? adapterConfig.planAgent : adapterConfig.defaultAgent);
        context.activeVariant = variant;
        updateProviderSession(
          context,
          {
            status: "running",
            activeTurnId: turnId,
            model: modelSelection?.model ?? context.session.model,
          },
          { clearLastError: true },
        );

        yield* emit({
          ...buildEventBase({ threadId: input.threadId, turnId }),
          type: "turn.started",
          payload: {
            model: modelSelection?.model ?? context.session.model,
            ...(variant ? { effort: variant } : {}),
          },
        });

        if (provider === "kilo") {
          const baselineMessageIds = yield* rememberCurrentMessageSnapshots(context).pipe(
            Effect.catchCause(() => Effect.succeed(new Set<string>())),
          );
          const recoveryBaselineMessageIds = yield* captureOpenCodeRecoveryBaseline(context);
          const providerActivitySerial = context.activeTurnProviderActivitySerial;
          yield* schedulePromptAcceptedWatchdog(context, {
            turnId,
            providerActivitySerial,
            excludedMessageIds: recoveryBaselineMessageIds,
          });
          yield* submitOpenCodePrompt(context, {
            turnId,
            promptInput: {
              sessionID: context.openCodeSessionId,
              messageID: `msg_${randomUUID()}`,
              model: parsedModel,
              ...(context.activeAgent ? { agent: context.activeAgent } : {}),
              ...(context.activeVariant ? { variant: context.activeVariant } : {}),
              noReply: false,
              parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
            },
          });
          yield* startKiloTurnSnapshotWatchdog(context, turnId, baselineMessageIds);
        } else {
          yield* submitOpenCodePromptAsync(context, {
            turnId,
            promptInput: {
              sessionID: context.openCodeSessionId,
              model: parsedModel,
              ...(context.activeAgent ? { agent: context.activeAgent } : {}),
              ...(context.activeVariant ? { variant: context.activeVariant } : {}),
              parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
            },
          });
        }

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: { openCodeSessionId: context.openCodeSessionId },
        };
      });

      const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
        function* (threadId, turnId) {
          const context = ensureAdapterSessionContext(threadId);
          const activeTurnId = turnId ?? context.activeTurnId;
          yield* runOpenCodeSdk("session.abort", () =>
            context.client.session.abort({
              sessionID: context.openCodeSessionId,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));
          clearActiveTurnState(context);
          updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
          if (activeTurnId) {
            yield* emit({
              ...buildEventBase({ threadId, turnId: activeTurnId }),
              type: "turn.aborted",
              payload: {
                reason: "Interrupted by user.",
              },
            });
          }
        },
      );

      const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
        "respondToRequest",
      )(function* (threadId, requestId, decision) {
        const context = ensureAdapterSessionContext(threadId);
        if (!context.pendingPermissions.has(requestId)) {
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "permission.reply",
            detail: `Unknown pending permission request: ${requestId}`,
          });
        }

        yield* runOpenCodeSdk("permission.reply", () =>
          context.client.permission.reply({
            requestID: requestId,
            reply: toOpenCodePermissionReply(decision),
          }),
        ).pipe(Effect.mapError(toAdapterRequestError));
      });

      const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
        "respondToUserInput",
      )(function* (threadId, requestId, answers) {
        const context = ensureAdapterSessionContext(threadId);
        const request = context.pendingQuestions.get(requestId);
        if (!request) {
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "question.reply",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }

        yield* runOpenCodeSdk("question.reply", () =>
          context.client.question.reply({
            requestID: requestId,
            answers: toOpenCodeQuestionAnswers(request, answers),
          }),
        ).pipe(Effect.mapError(toAdapterRequestError));
      });

      const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
        function* (threadId) {
          const context = ensureAdapterSessionContext(threadId);
          yield* stopOpenCodeContext(context);
          sessions.delete(threadId);
          yield* emit({
            ...buildEventBase({ threadId }),
            type: "session.exited",
            payload: {
              reason: "Session stopped.",
              recoverable: false,
              exitKind: "graceful",
            },
          });
        },
      );

      const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
        Effect.sync(() => [...sessions.values()].map((context) => context.session));

      const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
        Effect.sync(() => sessions.has(threadId));

      const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
        function* (threadId) {
          const context = ensureAdapterSessionContext(threadId);
          const messages = yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({
              sessionID: context.openCodeSessionId,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));

          return buildOpenCodeThreadSnapshot({
            threadId,
            messages: (messages.data ?? []).flatMap((entry) =>
              entry.info.role === "user" || entry.info.role === "assistant"
                ? [
                    {
                      info: {
                        id: entry.info.id,
                        role: entry.info.role,
                      },
                      parts: entry.parts,
                    } satisfies OpenCodeMessageSnapshot,
                  ]
                : [],
            ),
            cwd: context.directory,
          });
        },
      );

      const readExternalThread: NonNullable<OpenCodeAdapterShape["readExternalThread"]> = (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const directory = input.cwd ?? serverConfig.cwd;
            const server = yield* openCodeRuntime
              .connectToOpenCodeServer({
                binaryPath: adapterConfig.defaultBinaryPath,
                cliSpec: adapterConfig.cliSpec,
              })
              .pipe(Effect.mapError(toAdapterRequestError));
            const client = openCodeRuntime.createOpenCodeSdkClient({
              baseUrl: server.url,
              directory,
              cliSpec: adapterConfig.cliSpec,
            });
            const session = yield* runOpenCodeSdk("session.get", () =>
              client.session.get({
                sessionID: input.externalThreadId,
              }),
            ).pipe(Effect.mapError(toAdapterRequestError));
            const messages = yield* runOpenCodeSdk("session.messages", () =>
              client.session.messages({
                sessionID: input.externalThreadId,
              }),
            ).pipe(Effect.mapError(toAdapterRequestError));

            return buildOpenCodeThreadSnapshot({
              threadId: ThreadId.makeUnsafe(input.externalThreadId),
              messages: (messages.data ?? []).flatMap((entry) =>
                entry.info.role === "user" || entry.info.role === "assistant"
                  ? [
                      {
                        info: {
                          id: entry.info.id,
                          role: entry.info.role,
                        },
                        parts: entry.parts,
                      } satisfies OpenCodeMessageSnapshot,
                    ]
                  : [],
              ),
              cwd: session.data?.directory ?? directory,
            });
          }),
        );

      const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
        function* (threadId, numTurns) {
          const context = ensureAdapterSessionContext(threadId);
          const messages = yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({
              sessionID: context.openCodeSessionId,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));

          const assistantMessages = (messages.data ?? []).filter(
            (entry) => entry.info.role === "assistant",
          );
          const targetIndex = assistantMessages.length - numTurns - 1;
          const target = targetIndex >= 0 ? assistantMessages[targetIndex] : null;
          yield* runOpenCodeSdk("session.revert", () =>
            context.client.session.revert({
              sessionID: context.openCodeSessionId,
              ...(target ? { messageID: target.info.id } : {}),
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));

          return yield* readThread(threadId);
        },
      );

      const compactThread: NonNullable<OpenCodeAdapterShape["compactThread"]> = (threadId) =>
        Effect.gen(function* () {
          const context = ensureAdapterSessionContext(threadId);
          const parsedModel = parseOpenCodeModelSlug(context.session.model);
          if (!parsedModel) {
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "compactThread",
              issue: `${adapterConfig.displayName} compaction requires a current 'provider/model' selection.`,
            });
          }

          yield* runOpenCodeSdk("session.summarize", () =>
            context.client.session.summarize({
              sessionID: context.openCodeSessionId,
              providerID: parsedModel.providerID,
              modelID: parsedModel.modelID,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));
        });

      const forkThread: NonNullable<OpenCodeAdapterShape["forkThread"]> = (input) =>
        Effect.gen(function* () {
          const sourceContext = sessions.get(input.sourceThreadId);
          const sourceSessionId =
            sourceContext?.openCodeSessionId ?? extractResumeSessionId(input.sourceResumeCursor);
          if (!sourceSessionId) {
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "forkThread",
              issue: `${adapterConfig.displayName} native fork requires a resumable source session id.`,
            });
          }

          const providerOptions = input.providerOptions?.[adapterConfig.providerOptionsKey];
          const binaryPath = providerOptions?.binaryPath?.trim() || adapterConfig.defaultBinaryPath;
          const serverUrl = providerOptions?.serverUrl?.trim();
          const serverPassword = providerOptions?.serverPassword?.trim();
          const experimentalWebSockets =
            adapterConfig.providerOptionsKey === "opencode" &&
            providerOptions &&
            "experimentalWebSockets" in providerOptions
              ? providerOptions.experimentalWebSockets === true
              : undefined;
          const directory = input.cwd ?? sourceContext?.directory ?? serverConfig.cwd;

          let client: OpencodeClient;
          if (sourceContext) {
            client = sourceContext.client;
          } else {
            client = yield* Effect.scoped(
              Effect.gen(function* () {
                const server = yield* openCodeRuntime
                  .connectToOpenCodeServer({
                    binaryPath,
                    cliSpec: adapterConfig.cliSpec,
                    ...(serverUrl ? { serverUrl } : {}),
                    ...(experimentalWebSockets !== undefined ? { experimentalWebSockets } : {}),
                  })
                  .pipe(Effect.mapError(toAdapterRequestError));
                return openCodeRuntime.createOpenCodeSdkClient({
                  baseUrl: server.url,
                  directory,
                  cliSpec: adapterConfig.cliSpec,
                  ...(server.external && serverPassword ? { serverPassword } : {}),
                });
              }),
            );
          }

          const forked = yield* runOpenCodeSdk("session.fork", () =>
            client.session.fork({
              sessionID: sourceSessionId,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));

          const forkedSessionId = forked.data?.id?.trim();
          if (!forkedSessionId) {
            return yield* new ProviderAdapterRequestError({
              provider,
              method: "session.fork",
              detail: `${adapterConfig.displayName} session.fork returned no session payload.`,
            });
          }

          const session = yield* startSession({
            threadId: input.threadId,
            provider,
            cwd: directory,
            ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
            ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
            resumeCursor: { openCodeSessionId: forkedSessionId },
            runtimeMode: input.runtimeMode,
          });

          return {
            threadId: input.threadId,
            ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
          };
        });

      const withDiscoveryInventory = <A>(
        input: {
          readonly binaryPath?: string | null;
        },
        fn: (input: {
          readonly client: OpencodeClient;
          readonly inventory: OpenCodeInventory;
          readonly credentialProviderIDs: ReadonlyArray<string>;
        }) => Effect.Effect<A, ProviderAdapterRequestError>,
      ): Effect.Effect<A, ProviderAdapterRequestError> =>
        Effect.gen(function* () {
          const activeContext = [...sessions.values()][0];
          if (activeContext) {
            const inventory = yield* openCodeRuntime
              .loadOpenCodeInventory(activeContext.client)
              .pipe(Effect.mapError(toAdapterRequestError));
            replaceModelContextLimits(activeContext, buildOpenCodeModelContextLimitMap(inventory));
            const credentialProviderIDs = yield* openCodeRuntime.loadOpenCodeCredentialProviderIDs(
              activeContext.client,
              adapterConfig.cliSpec,
            );
            return yield* fn({
              client: activeContext.client,
              inventory,
              credentialProviderIDs,
            });
          }

          return yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* openCodeRuntime
                .connectToOpenCodeServer({
                  binaryPath: input.binaryPath?.trim() || adapterConfig.defaultBinaryPath,
                  cliSpec: adapterConfig.cliSpec,
                })
                .pipe(Effect.mapError(toAdapterRequestError));
              const client = openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory: serverConfig.cwd,
                cliSpec: adapterConfig.cliSpec,
              });
              const inventory = yield* openCodeRuntime
                .loadOpenCodeInventory(client)
                .pipe(Effect.mapError(toAdapterRequestError));
              const credentialProviderIDs =
                yield* openCodeRuntime.loadOpenCodeCredentialProviderIDs(
                  client,
                  adapterConfig.cliSpec,
                );
              return yield* fn({ client, inventory, credentialProviderIDs });
            }),
          );
        });

      const listModels: NonNullable<OpenCodeAdapterShape["listModels"]> = (input) => {
        const binaryPath = input.binaryPath?.trim() || adapterConfig.defaultBinaryPath;
        const freeOnlyProviderID = adapterConfig.provider === "kilo" ? "kilo" : undefined;
        return withDiscoveryInventory({ binaryPath }, ({ inventory, credentialProviderIDs }) =>
          Effect.gen(function* () {
            const preferredProviderIDs = new Set(
              resolvePreferredOpenCodeModelProviders({
                inventory,
                credentialProviderIDs,
              }).map((provider) => provider.id),
            );
            const inventoryModels = flattenOpenCodeModels({
              inventory,
              credentialProviderIDs,
              ...(freeOnlyProviderID ? { freeOnlyProviderID } : {}),
            });
            const cliModels = yield* openCodeRuntime
              .listOpenCodeCliModels({ binaryPath, cliSpec: adapterConfig.cliSpec })
              .pipe(Effect.catch(() => Effect.succeed([])));
            const preferredCliModels = cliModels.filter((model) =>
              preferredProviderIDs.has(model.providerID),
            );
            const models = mergeOpenCodeCliModelDescriptors({
              inventory,
              models: inventoryModels,
              cliModels: preferredCliModels.length > 0 ? preferredCliModels : cliModels,
              ...(freeOnlyProviderID ? { freeOnlyProviderID } : {}),
            });
            yield* Effect.logDebug(`${adapterConfig.displayName} model discovery resolved`, {
              binaryPath,
              connectedProviders: inventory.providerList.connected,
              inventoryModelCount: inventoryModels.length,
              cliModelCount: cliModels.length,
              modelCount: models.length,
              sampleModels: models.slice(0, 12).map((model) => model.slug),
            });
            return {
              models,
              source:
                cliModels.length > 0
                  ? adapterConfig.cliModelSource
                  : adapterConfig.fallbackModelSource,
              cached: false,
            };
          }).pipe(
            Effect.catch(() =>
              Effect.succeed({
                models: flattenOpenCodeModels({
                  inventory,
                  credentialProviderIDs,
                  ...(freeOnlyProviderID ? { freeOnlyProviderID } : {}),
                }),
                source: adapterConfig.fallbackModelSource,
                cached: false,
              }),
            ),
          ),
        );
      };

      const listAgents: NonNullable<OpenCodeAdapterShape["listAgents"]> = () =>
        withDiscoveryInventory({}, ({ inventory }) =>
          Effect.succeed({
            agents: flattenOpenCodeAgents(inventory.agents),
            source: adapterConfig.fallbackModelSource,
            cached: false,
          }),
        );

      const getComposerCapabilities: NonNullable<
        OpenCodeAdapterShape["getComposerCapabilities"]
      > = () =>
        Effect.succeed({
          provider,
          supportsSkillMentions: false,
          supportsSkillDiscovery: false,
          supportsNativeSlashCommandDiscovery: false,
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: true,
          supportsThreadCompaction: true,
          supportsThreadImport: true,
        } satisfies ProviderComposerCapabilities);

      const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
        Effect.gen(function* () {
          const contexts = [...sessions.values()];
          sessions.clear();
          yield* Effect.forEach(
            contexts,
            (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
            { concurrency: "unbounded", discard: true },
          );
        });

      return {
        provider,
        capabilities: {
          sessionModelSwitch: "in-session",
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
        readExternalThread,
        rollbackThread,
        compactThread,
        forkThread,
        stopAll,
        listModels,
        listAgents,
        getComposerCapabilities,
        get streamEvents() {
          return Stream.fromQueue(runtimeEvents);
        },
      } as OpenCodeAdapterShape;
    }),
  ).pipe(
    Layer.provide(
      options?.runtime ? Layer.succeed(OpenCodeRuntime, options.runtime) : OpenCodeRuntimeLive,
    ),
    Layer.provide(NodeServices.layer),
  );
}

export const OpenCodeAdapterLive = makeOpenCodeAdapterLive();

export function makeKiloAdapterLive(options?: Omit<OpenCodeAdapterLiveOptions, "adapterConfig">) {
  const kiloOpenCodeCompatibleLayer = makeOpenCodeAdapterLive({
    ...options,
    adapterConfig: KILO_ADAPTER_CONFIG,
  });
  return Layer.effect(
    KiloAdapter,
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      return adapter as unknown as KiloAdapterShape;
    }),
  ).pipe(Layer.provide(kiloOpenCodeCompatibleLayer));
}

export const KiloAdapterLive = makeKiloAdapterLive();
