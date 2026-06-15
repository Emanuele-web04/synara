/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps `CodexAppServerManager` behind the `CodexAdapter` service contract and
 * maps manager failures into the shared `ProviderAdapterError` algebra.
 *
 * @module CodexAdapterLive
 */
import {
  type ProviderComposerCapabilities,
  type ProviderEvent,
  type ProviderListModelsResult,
  type ProviderListPluginsResult,
  type ProviderReadPluginResult,
  type ProviderListSkillsResult,
  type ProviderRuntimeEvent,
  type ServerVoiceTranscriptionResult,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Queue, ServiceMap, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { CodexAdapter, type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import {
  CodexAppServerManager,
  type CodexAppServerStartSessionInput,
  type CodexTransportFactoryInput,
} from "../../codexAppServerManager.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { synaraSkillsDir } from "../skillsCatalog.ts";
import { PROVIDER, toMessage, toRequestError } from "./CodexAdapter.errors.ts";
import { mapToRuntimeEvents } from "./CodexAdapter.events.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

export interface CodexAdapterLiveOptions {
  readonly manager?: CodexAppServerManager;
  readonly makeManager?: (services?: ServiceMap.ServiceMap<never>) => CodexAppServerManager;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const makeCodexAdapter = (options?: CodexAdapterLiveOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const manager = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        if (options?.manager) {
          return options.manager;
        }
        const services = yield* Effect.services<never>();
        return (
          options?.makeManager?.(services) ??
          new CodexAppServerManager(services, {
            synaraSkillsDir: synaraSkillsDir(serverConfig.baseDir),
          })
        );
      }),
      (manager) =>
        Effect.sync(() => {
          try {
            manager.stopAll();
          } catch {
            // Finalizers should never fail and block shutdown.
          }
        }),
    );

    const startSession: CodexAdapterShape["startSession"] = (input, serverOptions) => {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      // For a sandbox-backed thread, run `codex app-server` inside the provisioned
      // instance instead of spawning locally. The runtime supplies the instance;
      // codex supplies the spawn (binary + `app-server`). The host `homePath`
      // (codex CODEX_HOME) is deliberately NOT forwarded: the sandbox owns codex
      // and its auth under its own HOME, and forwarding a host path would point
      // the remote agent at a directory that does not exist there. The
      // local-forward fake inherits the host process env, so it resolves codex
      // the same way the local path does.
      const remoteTransport = serverOptions?.remoteTransport;
      const managerInput: CodexAppServerStartSessionInput = {
        threadId: input.threadId,
        provider: "codex",
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
        ...(input.approvalPolicy !== undefined ? { approvalPolicy: input.approvalPolicy } : {}),
        ...(input.sandboxMode !== undefined ? { sandboxMode: input.sandboxMode } : {}),
        ...(input.approvalPolicy === "never" && input.sandboxMode === "read-only"
          ? { reviewProfile: "review-chat" as const }
          : {}),
        ...(remoteTransport
          ? {
              createTransport: (codexInput: CodexTransportFactoryInput) =>
                remoteTransport({
                  command: codexInput.binaryPath,
                  args: ["app-server"],
                  cwd: codexInput.cwd,
                }),
            }
          : {}),
        runtimeMode: input.runtimeMode,
        ...(input.modelSelection?.provider === "codex"
          ? { model: input.modelSelection.model }
          : {}),
        ...(input.modelSelection?.provider === "codex" &&
        input.modelSelection.options?.reasoningEffort !== undefined
          ? { effort: input.modelSelection.options.reasoningEffort }
          : {}),
        ...(input.modelSelection?.provider === "codex" && input.modelSelection.options?.fastMode
          ? { serviceTier: "fast" }
          : {}),
      };

      return Effect.tryPromise({
        try: () => manager.startSession(managerInput),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start Codex adapter session."),
            cause,
          }),
      }).pipe(Effect.map((session) => session));
    };

    const sendTurn: CodexAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const codexAttachments = yield* Effect.forEach(
          input.attachments ?? [],
          (attachment) =>
            Effect.gen(function* () {
              if (attachment.type !== "image") {
                return null;
              }
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* toRequestError(
                  input.threadId,
                  "turn/start",
                  new Error(`Invalid attachment id '${attachment.id}'.`),
                );
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
                url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
              };
            }),
          { concurrency: 1 },
        );
        const managerInput = {
          threadId: input.threadId,
          ...(input.input !== undefined ? { input: input.input } : {}),
          ...(input.skills !== undefined ? { skills: input.skills } : {}),
          ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
          ...(input.modelSelection?.provider === "codex"
            ? { model: input.modelSelection.model }
            : {}),
          ...(input.modelSelection?.provider === "codex" &&
          input.modelSelection.options?.reasoningEffort !== undefined
            ? { effort: input.modelSelection.options.reasoningEffort }
            : {}),
          ...(input.modelSelection?.provider === "codex" && input.modelSelection.options?.fastMode
            ? { serviceTier: "fast" }
            : {}),
          ...(input.interactionMode !== undefined
            ? { interactionMode: input.interactionMode }
            : {}),
          ...(codexAttachments.length > 0
            ? { attachments: codexAttachments.filter((attachment) => attachment !== null) }
            : {}),
        };

        return yield* Effect.tryPromise({
          try: () => manager.sendTurn(managerInput),
          catch: (cause) => toRequestError(input.threadId, "turn/start", cause),
        }).pipe(
          Effect.map((result) => ({
            ...result,
            threadId: input.threadId,
          })),
        );
      });

    const steerTurn: CodexAdapterShape["steerTurn"] = (input) =>
      Effect.gen(function* () {
        const codexAttachments = yield* Effect.forEach(
          input.attachments ?? [],
          (attachment) =>
            Effect.gen(function* () {
              if (attachment.type !== "image") {
                return null;
              }
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* toRequestError(
                  input.threadId,
                  "turn/steer",
                  new Error(`Invalid attachment id '${attachment.id}'.`),
                );
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "turn/steer",
                      detail: toMessage(cause, "Failed to read attachment file."),
                      cause,
                    }),
                ),
              );
              return {
                type: "image" as const,
                url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
              };
            }),
          { concurrency: 1 },
        );
        const managerInput = {
          threadId: input.threadId,
          ...(input.input !== undefined ? { input: input.input } : {}),
          ...(input.skills !== undefined ? { skills: input.skills } : {}),
          ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
          ...(input.modelSelection?.provider === "codex"
            ? { model: input.modelSelection.model }
            : {}),
          ...(input.modelSelection?.provider === "codex" &&
          input.modelSelection.options?.reasoningEffort !== undefined
            ? { effort: input.modelSelection.options.reasoningEffort }
            : {}),
          ...(input.modelSelection?.provider === "codex" && input.modelSelection.options?.fastMode
            ? { serviceTier: "fast" }
            : {}),
          ...(input.interactionMode !== undefined
            ? { interactionMode: input.interactionMode }
            : {}),
          ...(codexAttachments.length > 0
            ? { attachments: codexAttachments.filter((attachment) => attachment !== null) }
            : {}),
        };

        return yield* Effect.tryPromise({
          try: () => manager.steerTurn(managerInput),
          catch: (cause) => toRequestError(input.threadId, "turn/steer", cause),
        }).pipe(
          Effect.map((result) => ({
            ...result,
            threadId: input.threadId,
          })),
        );
      });

    const startReview: CodexAdapterShape["startReview"] = (input) =>
      Effect.tryPromise({
        try: () => manager.startReview(input),
        catch: (cause) => toRequestError(input.threadId, "review/start", cause),
      }).pipe(
        Effect.map((result) => ({
          ...result,
          threadId: input.threadId,
        })),
      );

    const injectThreadItems: NonNullable<CodexAdapterShape["injectThreadItems"]> = (input) =>
      Effect.tryPromise({
        try: () => manager.injectThreadItems(input),
        catch: (cause) => toRequestError(input.threadId, "thread/inject_items", cause),
      });

    const interruptTurn: CodexAdapterShape["interruptTurn"] = (
      threadId,
      turnId,
      providerThreadId,
    ) =>
      Effect.tryPromise({
        try: () => manager.interruptTurn(threadId, turnId, providerThreadId),
        catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
      });

    const readThread: CodexAdapterShape["readThread"] = (threadId) =>
      Effect.tryPromise({
        try: () => manager.readThread(threadId),
        catch: (cause) => toRequestError(threadId, "thread/read", cause),
      }).pipe(
        Effect.map((snapshot) => ({
          threadId,
          turns: snapshot.turns,
          cwd: snapshot.cwd ?? null,
        })),
      );

    const readExternalThread: NonNullable<CodexAdapterShape["readExternalThread"]> = (input) =>
      Effect.tryPromise({
        try: () => manager.readExternalThread(input),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/read",
            detail: toMessage(cause, "Failed to read external Codex thread."),
            cause,
          }),
      }).pipe(
        Effect.map((snapshot) => ({
          threadId: ThreadId.makeUnsafe(snapshot.threadId),
          turns: snapshot.turns,
          cwd: snapshot.cwd ?? null,
        })),
      );

    const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, numTurns) => {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          }),
        );
      }

      return Effect.tryPromise({
        try: () => manager.rollbackThread(threadId, numTurns),
        catch: (cause) => toRequestError(threadId, "thread/rollback", cause),
      }).pipe(
        Effect.map((snapshot) => ({
          threadId,
          turns: snapshot.turns,
        })),
      );
    };

    const compactThread: NonNullable<CodexAdapterShape["compactThread"]> = (threadId) =>
      Effect.tryPromise({
        try: () => manager.compactThread(threadId),
        catch: (cause) => toRequestError(threadId, "thread/compact/start", cause),
      });

    const forkThread: CodexAdapterShape["forkThread"] = (input) =>
      Effect.tryPromise({
        try: () => manager.forkThread(input),
        catch: (cause) => toRequestError(input.sourceThreadId, "thread/fork", cause),
      });

    const respondToRequest: CodexAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToRequest(threadId, requestId, decision),
        catch: (cause) => toRequestError(threadId, "item/requestApproval/decision", cause),
      });

    const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToUserInput(threadId, requestId, answers),
        catch: (cause) => toRequestError(threadId, "item/tool/requestUserInput", cause),
      });

    const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
      Effect.sync(() => {
        manager.stopSession(threadId);
      });

    const listSessions: CodexAdapterShape["listSessions"] = () =>
      Effect.sync(() => manager.listSessions());

    const hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => manager.hasSession(threadId));

    const stopAll: CodexAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        manager.stopAll();
      });

    const getComposerCapabilities: NonNullable<CodexAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed(manager.getComposerCapabilities() satisfies ProviderComposerCapabilities);

    const listSkills: NonNullable<CodexAdapterShape["listSkills"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.listSkills({
            cwd: input.cwd,
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            ...(input.forceReload !== undefined ? { forceReload: input.forceReload } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "skills/list",
            detail: toMessage(cause, "skills/list failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderListSkillsResult));

    const listPlugins: NonNullable<CodexAdapterShape["listPlugins"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.listPlugins({
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            ...(input.forceRemoteSync !== undefined
              ? { forceRemoteSync: input.forceRemoteSync }
              : {}),
            ...(input.forceReload !== undefined ? { forceReload: input.forceReload } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "plugin/list",
            detail: toMessage(cause, "plugin/list failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderListPluginsResult));

    const readPlugin: NonNullable<CodexAdapterShape["readPlugin"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.readPlugin({
            marketplacePath: input.marketplacePath,
            pluginName: input.pluginName,
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "plugin/read",
            detail: toMessage(cause, "plugin/read failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderReadPluginResult));

    const listModels: NonNullable<CodexAdapterShape["listModels"]> = (_input) =>
      Effect.tryPromise({
        try: () => manager.listModels(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: toMessage(cause, "model/list failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderListModelsResult));

    const transcribeVoice: NonNullable<CodexAdapterShape["transcribeVoice"]> = (input) =>
      Effect.tryPromise({
        try: () => manager.transcribeVoice(input),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "voice/transcribe",
            detail: toMessage(cause, "voice/transcribe failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ServerVoiceTranscriptionResult));

    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const writeNativeEvent = (event: ProviderEvent) =>
          Effect.gen(function* () {
            if (!nativeEventLogger) {
              return;
            }
            yield* nativeEventLogger.write(event, event.threadId);
          });

        const services = yield* Effect.services<never>();
        const listener = (event: ProviderEvent) =>
          Effect.gen(function* () {
            yield* writeNativeEvent(event);
            const runtimeEvents = mapToRuntimeEvents(event, event.threadId);
            if (runtimeEvents.length === 0) {
              yield* Effect.logDebug("ignoring unhandled Codex provider event", {
                method: event.method,
                threadId: event.threadId,
                turnId: event.turnId,
                itemId: event.itemId,
              });
              return;
            }
            yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
          }).pipe(Effect.runPromiseWith(services));
        manager.on("event", listener);
        return listener;
      }),
      (listener) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            manager.off("event", listener);
          });
          yield* Queue.shutdown(runtimeEventQueue);
        }),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: true,
        supportsPluginDiscovery: true,
        supportsRuntimeModelList: true,
        supportsTurnSteering: true,
        supportsLiveTurnDiffPatch: true,
      },
      startSession,
      sendTurn,
      steerTurn,
      startReview,
      injectThreadItems,
      interruptTurn,
      readThread,
      readExternalThread,
      rollbackThread,
      compactThread,
      forkThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      getComposerCapabilities,
      listSkills,
      listPlugins,
      readPlugin,
      listModels,
      transcribeVoice,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies CodexAdapterShape;
  });

export const CodexAdapterLive = Layer.effect(CodexAdapter, makeCodexAdapter());

export function makeCodexAdapterLive(options?: CodexAdapterLiveOptions) {
  return Layer.effect(CodexAdapter, makeCodexAdapter(options));
}
