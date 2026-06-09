import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import {
  ApprovalRequestId,
  EventId,
  type ProviderComposerCapabilities,
  type ProviderListModelsResult,
  type ProviderListPluginsResult,
  type ProviderForkThreadInput,
  type ProviderReadPluginResult,
  type ProviderForkThreadResult,
  type ProviderListSkillsResult,
  type ProviderStartReviewInput,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ServerVoiceTranscriptionInput,
  type ServerVoiceTranscriptionResult,
} from "@t3tools/contracts";
import { getModelSelectionBooleanOptionValue } from "@t3tools/shared/model";
import { Deferred, Effect, ServiceMap, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { CODEX_DEFAULT_MODEL, CODEX_DISCOVERY_SESSION_IDLE_MS } from "./codexAppServer.config.ts";
import {
  classifyCodexStderrLine,
  isIgnorableCodexProcessLine,
  isJsonObjectLine,
  isRecoverableThreadResumeError,
  normalizeCodexProcessLine,
  normalizeCodexUserVisibleErrorMessage,
  normalizeProviderThreadId,
  readCodexAccountSnapshot,
  readResumeCursorThreadId,
  shouldRetrySkillsListWithCwdFallback,
  toTurnId,
} from "./codexAppServer.protocol.ts";
import {
  findLatestReviewTurnId,
  isExitedReviewModeNotification,
  isExitedReviewTurn,
  isResponse,
  isServerNotification,
  isServerRequest,
  isTurnInterruptTimeout,
  parseModelListResponse,
  parsePluginListResponse,
  parsePluginReadResponse,
  parseSkillsListResponse,
  parseThreadSnapshot,
  readArray,
  readBoolean,
  readObject,
  readProviderConversationId,
  readRouteFields,
  readString,
  readThreadIdFromResponse,
  requestKindForMethod,
  toCodexReviewTarget,
} from "./codexAppServer.parsers.ts";
import {
  buildCodexCollaborationMode,
  buildCodexInitializeParams,
  CODEX_ALWAYS_ALLOW_SESSION_TURN_OVERRIDES,
  ensureIsolatedScratchWorkspace,
  mapCodexRuntimeMode,
  normalizeCodexModelSlug,
  readCodexProviderOptions,
  readResumeThreadId,
  resolveCodexModelForAccount,
  resolveCodexTurnOverrides,
  toCodexUserInputAnswers,
} from "./codexAppServer.session.ts";
import type {
  CodexAccountSnapshot,
  CodexApprovalPolicy,
  CodexAppServerSendTurnInput,
  CodexAppServerStartSessionInput,
  CodexPluginListInput,
  CodexPluginReadInput,
  CodexSessionContext,
  CodexSkillListInput,
  CodexStartupDiscovery,
  CodexThreadSnapshot,
  CodexThreadTurnSnapshot,
  CodexTransportFactory,
  CodexTransportFactoryInput,
  CodexTurnSandboxPolicy,
  CodexVoiceTranscriptionAuthContext,
  CodexAppServerManagerEvents,
  CodexAppServerManagerOptions,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  PendingApprovalRequest,
} from "./codexAppServer.types.ts";
import { isNonFatalCodexErrorMessage } from "./codexErrorClassification.ts";
import { buildCodexProcessEnv } from "./codexProcessEnv.ts";
import { selectAvailableCodexModel } from "./provider/codexModelSelection.ts";
import { assertSupportedCodexCliVersion } from "./provider/process/codexCliVersionGate.ts";
import {
  makeCodexProcessTransport,
  type JsonRpcLineTransport,
  type ProcessExit,
} from "./provider/process/JsonRpcLineTransport.ts";
import { transcribeVoiceWithChatGptSession } from "./voiceTranscription.ts";

export {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "./codexAppServer.config.ts";
export {
  classifyCodexStderrLine,
  isJsonObjectLine,
  isRecoverableThreadResumeError,
  readCodexAccountSnapshot,
} from "./codexAppServer.protocol.ts";
export {
  buildCodexInitializeParams,
  ensureIsolatedScratchWorkspace,
  normalizeCodexModelSlug,
  resolveCodexModelForAccount,
} from "./codexAppServer.session.ts";
export type {
  CodexAppServerManagerEvents,
  CodexAppServerManagerOptions,
  CodexAppServerSendTurnInput,
  CodexAppServerStartSessionInput,
  CodexThreadSnapshot,
  CodexThreadTurnSnapshot,
  CodexTransportFactory,
  CodexTransportFactoryInput,
} from "./codexAppServer.types.ts";

export class CodexAppServerManager extends EventEmitter<CodexAppServerManagerEvents> {
  private readonly sessions = new Map<ThreadId, CodexSessionContext>();
  private readonly discoverySessions = new Map<string, CodexSessionContext>();
  private readonly discoverySessionIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly skillsCache = new Map<string, ProviderListSkillsResult>();
  private readonly pluginsCache = new Map<string, ProviderListPluginsResult>();
  private readonly pluginDetailCache = new Map<string, ProviderReadPluginResult>();
  private readonly modelCache = new Map<string, ProviderListModelsResult>();
  private readonly localStartupDiscoveryCache = new Map<string, CodexStartupDiscovery>();
  private readonly localStartupDiscoveryInFlight = new Map<
    string,
    Promise<CodexStartupDiscovery>
  >();

  private runPromise: (effect: Effect.Effect<unknown, never>) => Promise<unknown>;
  private readonly services: ServiceMap.ServiceMap<never> | undefined;
  private readonly transportFactory: CodexTransportFactory | undefined;
  constructor(services?: ServiceMap.ServiceMap<never>, options?: CodexAppServerManagerOptions) {
    super();
    this.services = services;
    this.transportFactory = options?.createTransport;
    this.runPromise = services ? Effect.runPromiseWith(services) : Effect.runPromise;
  }

  // The production services map carries `ChildProcessSpawner`; its type is erased
  // to `never`, so transport effects are run through the same map with their
  // requirement cast away. Tests that never spawn (the protocol-level harnesses)
  // do not exercise this path.
  private runTransportEffect<A>(
    effect: Effect.Effect<A, never, ChildProcessSpawner.ChildProcessSpawner>,
  ): Promise<A> {
    const erased = effect as unknown as Effect.Effect<A, never>;
    return (this.services ? Effect.runPromiseWith(this.services) : Effect.runPromise)(erased);
  }

  private async createTransport(
    input: CodexTransportFactoryInput,
    perSessionFactory?: CodexTransportFactory,
  ): Promise<JsonRpcLineTransport> {
    const factory = perSessionFactory ?? this.transportFactory;
    if (factory) {
      return factory(input);
    }
    const env = buildCodexProcessEnv(input.homePath ? { homePath: input.homePath } : {});
    return this.runTransportEffect(
      makeCodexProcessTransport({
        command: input.binaryPath,
        args: ["app-server"],
        cwd: input.cwd,
        env,
        shell: process.platform === "win32",
      }),
    );
  }

  private async resolveStartupDiscovery(
    context: CodexSessionContext,
    cacheKey: string | undefined,
  ): Promise<CodexStartupDiscovery> {
    const cached = cacheKey ? this.localStartupDiscoveryCache.get(cacheKey) : undefined;
    if (cached) {
      return cached;
    }

    const inFlight = cacheKey ? this.localStartupDiscoveryInFlight.get(cacheKey) : undefined;
    if (inFlight) {
      return inFlight;
    }

    const promise = (async (): Promise<CodexStartupDiscovery> => {
      let advertisedModelSlugs: ReadonlyArray<string> = [];
      let account: CodexAccountSnapshot = {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      };

      try {
        const modelListResponse = await this.sendRequest(context, "model/list", {});
        console.log("codex model/list response", modelListResponse);
        advertisedModelSlugs = parseModelListResponse(modelListResponse).map((model) => model.slug);
      } catch (error) {
        console.log("codex model/list failed", error);
      }

      try {
        const accountReadResponse = await this.sendRequest(context, "account/read", {});
        console.log("codex account/read response", accountReadResponse);
        account = readCodexAccountSnapshot(accountReadResponse);
        console.log("codex subscription status", {
          type: account.type,
          planType: account.planType,
          sparkEnabled: account.sparkEnabled,
        });
      } catch (error) {
        console.log("codex account/read failed", error);
      }

      return { advertisedModelSlugs, account };
    })();

    if (!cacheKey) {
      return promise;
    }

    this.localStartupDiscoveryInFlight.set(cacheKey, promise);
    try {
      const discovery = await promise;
      if (discovery.account.type !== "unknown") {
        this.localStartupDiscoveryCache.set(cacheKey, discovery);
      }
      return discovery;
    } finally {
      this.localStartupDiscoveryInFlight.delete(cacheKey);
    }
  }

  private async isContextAlive(context: CodexSessionContext): Promise<boolean> {
    return this.runTransportEffect(context.transport.isAlive);
  }

  // `stopSession`/`stopDiscoverySession` keep their synchronous signatures (the
  // call sites and tests are sync), so transport teardown is fired and the
  // promise is swallowed. `close` kills the process tree and interrupts the
  // pump fibers via its scope finalizers.
  private closeTransport(context: CodexSessionContext): void {
    void this.runPromise(context.transport.close).catch(() => {});
  }

  async startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSession> {
    const threadId = input.threadId;
    const now = new Date().toISOString();
    let context: CodexSessionContext | undefined;

    try {
      const existing = this.sessions.get(threadId);
      if (existing) {
        this.stopSession(threadId);
      }

      const resolvedCwd = input.cwd ?? ensureIsolatedScratchWorkspace(threadId);

      const session: ProviderSession = {
        provider: "codex",
        status: "connecting",
        runtimeMode: input.runtimeMode,
        model: normalizeCodexModelSlug(input.model),
        cwd: resolvedCwd,
        threadId,
        createdAt: now,
        updatedAt: now,
      };

      const codexOptions = readCodexProviderOptions(input);
      const codexBinaryPath = codexOptions.binaryPath ?? "codex";
      const codexHomePath = codexOptions.homePath;
      this.assertSupportedCodexCliVersion({
        binaryPath: codexBinaryPath,
        cwd: resolvedCwd,
        ...(codexHomePath ? { homePath: codexHomePath } : {}),
        hasSuppliedTransport: input.createTransport !== undefined,
      });
      const transport = await this.createTransport(
        {
          binaryPath: codexBinaryPath,
          cwd: resolvedCwd,
          ...(codexHomePath ? { homePath: codexHomePath } : {}),
        },
        input.createTransport,
      );

      context = {
        session,
        account: {
          type: "unknown",
          planType: null,
          sparkEnabled: true,
        },
        transport,
        pending: new Map(),
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        collabReceiverTurns: new Map(),
        collabReceiverParents: new Map(),
        reviewTurnIds: new Set(),
        nextRequestId: 1,
        stopping: false,
      };

      this.sessions.set(threadId, context);
      this.attachProcessListeners(context);

      this.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

      const startupStartedAt = Date.now();
      await this.sendRequest(context, "initialize", buildCodexInitializeParams());
      const initializeResolvedAt = Date.now();

      this.writeMessage(context, { method: "initialized" });
      const discoveryCacheKey =
        input.createTransport === undefined
          ? `${codexBinaryPath}\u001f${codexHomePath ?? ""}`
          : undefined;
      const usedDiscoveryCache =
        discoveryCacheKey !== undefined && this.localStartupDiscoveryCache.has(discoveryCacheKey);
      const discoveryStartedAt = Date.now();
      const discovery = await this.resolveStartupDiscovery(context, discoveryCacheKey);
      const discoveryResolvedAt = Date.now();
      const advertisedModelSlugs = discovery.advertisedModelSlugs;
      context.account = discovery.account;

      const normalizedModel = resolveCodexModelForAccount(
        normalizeCodexModelSlug(input.model),
        context.account,
      );
      // Remote-only: a sandbox codex may advertise a different model catalog than
      // the host, so a request it does not recognize would wedge the turn. Resolve
      // against what the sandbox actually advertised, falling back to the product
      // default. The local path is untouched (the gate skips it), so it stays
      // byte-for-byte unchanged.
      const effectiveModel =
        input.createTransport !== undefined
          ? this.selectSandboxCodexModel(normalizedModel, advertisedModelSlugs, {
              threadId,
            })
          : (normalizedModel ?? null);
      const sessionOverrides = {
        model: effectiveModel,
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
        cwd: resolvedCwd,
        ...mapCodexRuntimeMode(input.runtimeMode ?? "full-access"),
      };

      const threadStartParams = {
        ...sessionOverrides,
        experimentalRawEvents: false,
      };
      const resumeThreadId = readResumeThreadId(input);
      this.emitLifecycleEvent(
        context,
        "session/threadOpenRequested",
        resumeThreadId
          ? `Attempting to resume thread ${resumeThreadId}.`
          : "Starting a new Codex thread.",
      );
      await Effect.logInfo("codex app-server opening thread", {
        threadId,
        requestedRuntimeMode: input.runtimeMode,
        requestedModel: normalizedModel ?? null,
        requestedCwd: resolvedCwd,
        resumeThreadId: resumeThreadId ?? null,
      }).pipe(this.runPromise);

      let threadOpenMethod: "thread/start" | "thread/resume" = "thread/start";
      let threadOpenResponse: unknown;
      if (resumeThreadId) {
        try {
          threadOpenMethod = "thread/resume";
          threadOpenResponse = await this.sendRequest(context, "thread/resume", {
            ...sessionOverrides,
            threadId: resumeThreadId,
          });
        } catch (error) {
          if (!isRecoverableThreadResumeError(error)) {
            this.emitErrorEvent(
              context,
              "session/threadResumeFailed",
              error instanceof Error ? error.message : "Codex thread resume failed.",
            );
            await Effect.logWarning("codex app-server thread resume failed", {
              threadId,
              requestedRuntimeMode: input.runtimeMode,
              resumeThreadId,
              recoverable: false,
              cause: error instanceof Error ? error.message : String(error),
            }).pipe(this.runPromise);
            throw error;
          }

          threadOpenMethod = "thread/start";
          this.emitLifecycleEvent(
            context,
            "session/threadResumeFallback",
            `Could not resume thread ${resumeThreadId}; started a new thread instead.`,
          );
          await Effect.logWarning("codex app-server thread resume fell back to fresh start", {
            threadId,
            requestedRuntimeMode: input.runtimeMode,
            resumeThreadId,
            recoverable: true,
            cause: error instanceof Error ? error.message : String(error),
          }).pipe(this.runPromise);
          threadOpenResponse = await this.sendRequest(context, "thread/start", threadStartParams);
        }
      } else {
        threadOpenMethod = "thread/start";
        threadOpenResponse = await this.sendRequest(context, "thread/start", threadStartParams);
      }

      const threadOpenRecord = readObject(threadOpenResponse);
      const threadIdRaw =
        readString(readObject(threadOpenRecord, "thread"), "id") ??
        readString(threadOpenRecord, "threadId");
      if (!threadIdRaw) {
        throw new Error(`${threadOpenMethod} response did not include a thread id.`);
      }
      const providerThreadId = threadIdRaw;

      this.updateSession(context, {
        status: "ready",
        resumeCursor: { threadId: providerThreadId },
      });
      this.emitLifecycleEvent(
        context,
        "session/threadOpenResolved",
        `Codex ${threadOpenMethod} resolved.`,
      );
      await Effect.logInfo("codex app-server thread open resolved", {
        threadId,
        threadOpenMethod,
        requestedResumeThreadId: resumeThreadId ?? null,
        resolvedThreadId: providerThreadId,
        requestedRuntimeMode: input.runtimeMode,
      }).pipe(this.runPromise);
      this.emitLifecycleEvent(context, "session/ready", `Connected to thread ${providerThreadId}`);
      await Effect.logInfo("codex app-server startup timings", {
        threadId,
        initializeMs: initializeResolvedAt - startupStartedAt,
        discoveryMs: discoveryResolvedAt - discoveryStartedAt,
        threadOpenMs: Date.now() - discoveryResolvedAt,
        totalMs: Date.now() - startupStartedAt,
        usedDiscoveryCache,
      }).pipe(this.runPromise);
      return { ...context.session };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start Codex session.";
      if (context) {
        this.updateSession(context, {
          status: "error",
          lastError: message,
        });
        this.emitErrorEvent(context, "session/startFailed", message);
        this.stopSession(threadId);
      } else {
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "error",
          provider: "codex",
          threadId,
          createdAt: new Date().toISOString(),
          method: "session/startFailed",
          message,
        });
      }
      throw new Error(message, { cause: error });
    }
  }

  async sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    context.collabReceiverTurns.clear();

    // Normal sends never interrupt active work. The orchestration layer decides
    // when a queued follow-up is ready to become a provider turn.
    const turnInput: Array<
      | { type: "text"; text: string; text_elements: [] }
      | { type: "image"; url: string }
      | { type: "skill"; name: string; path: string }
      | { type: "mention"; name: string; path: string }
    > = [];
    if (input.input) {
      turnInput.push({
        type: "text",
        text: input.input,
        text_elements: [],
      });
    }
    for (const attachment of input.attachments ?? []) {
      if (attachment.type === "image") {
        turnInput.push({
          type: "image",
          url: attachment.url,
        });
      }
    }
    for (const skill of input.skills ?? []) {
      turnInput.push({
        type: "skill",
        name: skill.name,
        path: skill.path,
      });
    }
    for (const mention of input.mentions ?? []) {
      turnInput.push({
        type: "mention",
        name: mention.name,
        path: mention.path,
      });
    }
    if (turnInput.length === 0) {
      throw new Error("Turn input must include text or attachments.");
    }

    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing provider resume thread id.");
    }
    const turnStartParams: {
      threadId: string;
      input: Array<
        | { type: "text"; text: string; text_elements: [] }
        | { type: "image"; url: string }
        | { type: "skill"; name: string; path: string }
        | { type: "mention"; name: string; path: string }
      >;
      model?: string;
      serviceTier?: string | null;
      effort?: string;
      approvalPolicy?: CodexApprovalPolicy;
      sandboxPolicy?: CodexTurnSandboxPolicy;
      collaborationMode?: {
        mode: "default" | "plan";
        settings: {
          model: string;
          reasoning_effort: string;
          developer_instructions: string;
        };
      };
    } = {
      threadId: providerThreadId,
      input: turnInput,
      ...resolveCodexTurnOverrides(context),
    };
    const normalizedModel = resolveCodexModelForAccount(
      normalizeCodexModelSlug(input.model ?? context.session.model),
      context.account,
    );
    if (normalizedModel) {
      turnStartParams.model = normalizedModel;
    }
    if (input.serviceTier !== undefined) {
      turnStartParams.serviceTier = input.serviceTier;
    }
    if (input.effort) {
      turnStartParams.effort = input.effort;
    }
    const collaborationMode = buildCodexCollaborationMode({
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
    });
    if (collaborationMode) {
      if (!turnStartParams.model) {
        turnStartParams.model = collaborationMode.settings.model;
      }
      turnStartParams.collaborationMode = collaborationMode;
    }

    const response = await this.sendRequest(context, "turn/start", turnStartParams);
    const turnIdRaw = readString(readObject(readObject(response), "turn"), "id");
    if (!turnIdRaw) {
      throw new Error("turn/start response did not include a turn id.");
    }
    const turnId = TurnId.makeUnsafe(turnIdRaw);

    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    });

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  }

  async steerTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    context.collabReceiverTurns.clear();

    const activeTurnId = context.session.activeTurnId;
    if (context.session.status !== "running" || activeTurnId === undefined) {
      return this.sendTurn(input);
    }

    const turnInput: Array<
      | { type: "text"; text: string; text_elements: [] }
      | { type: "image"; url: string }
      | { type: "skill"; name: string; path: string }
      | { type: "mention"; name: string; path: string }
    > = [];
    if (input.input) {
      turnInput.push({
        type: "text",
        text: input.input,
        text_elements: [],
      });
    }
    for (const attachment of input.attachments ?? []) {
      if (attachment.type === "image") {
        turnInput.push({
          type: "image",
          url: attachment.url,
        });
      }
    }
    for (const skill of input.skills ?? []) {
      turnInput.push({
        type: "skill",
        name: skill.name,
        path: skill.path,
      });
    }
    for (const mention of input.mentions ?? []) {
      turnInput.push({
        type: "mention",
        name: mention.name,
        path: mention.path,
      });
    }
    if (turnInput.length === 0) {
      throw new Error("Turn input must include text or attachments.");
    }

    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing provider resume thread id.");
    }

    const response = await this.sendRequest(context, "turn/steer", {
      threadId: providerThreadId,
      input: turnInput,
      expectedTurnId: activeTurnId,
    });

    const turnIdRaw = readString(readObject(response), "turnId");
    if (!turnIdRaw) {
      throw new Error("turn/steer response did not include a turn id.");
    }
    const turnId = TurnId.makeUnsafe(turnIdRaw);

    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    });

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  }

  async startReview(input: ProviderStartReviewInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }

    const response = await this.sendRequest(context, "review/start", {
      threadId: providerThreadId,
      delivery: "inline",
      target: toCodexReviewTarget(input.target),
    });

    const turn = readObject(readObject(response), "turn");
    const turnIdRaw = readString(turn, "id");
    if (!turnIdRaw) {
      throw new Error("review/start response did not include a turn id.");
    }
    const turnId = TurnId.makeUnsafe(turnIdRaw);
    context.reviewTurnIds.add(turnId);
    console.log("[codex-review] review/start acknowledged", {
      threadId: context.session.threadId,
      providerThreadId,
      turnId,
      target: input.target.type,
    });

    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    });

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  }

  async interruptTurn(
    threadId: ThreadId,
    turnId?: TurnId,
    providerThreadIdOverride?: string,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const effectiveTurnId = turnId ?? context.session.activeTurnId;

    const providerThreadId =
      providerThreadIdOverride ??
      readResumeThreadId({
        threadId: context.session.threadId,
        runtimeMode: context.session.runtimeMode,
        resumeCursor: context.session.resumeCursor,
      });
    if (!effectiveTurnId || !providerThreadId) {
      console.log("[codex-review] turn/interrupt skipped", {
        threadId,
        requestedTurnId: turnId ?? null,
        activeTurnId: context.session.activeTurnId ?? null,
        providerThreadId: providerThreadId ?? null,
      });
      return;
    }

    console.log("[codex-review] turn/interrupt requested", {
      threadId,
      providerThreadId,
      turnId: effectiveTurnId,
      isTrackedReviewTurn: context.reviewTurnIds.has(effectiveTurnId),
    });
    try {
      await this.sendRequest(context, "turn/interrupt", {
        threadId: providerThreadId,
        turnId: effectiveTurnId,
      });
      console.log("[codex-review] turn/interrupt acknowledged", {
        threadId,
        providerThreadId,
        turnId: effectiveTurnId,
      });
    } catch (error) {
      console.log("[codex-review] turn/interrupt failed", {
        threadId,
        providerThreadId,
        turnId: effectiveTurnId,
        isTrackedReviewTurn: context.reviewTurnIds.has(effectiveTurnId),
        error: error instanceof Error ? error.message : String(error),
      });
      if (!context.reviewTurnIds.has(effectiveTurnId) || !isTurnInterruptTimeout(error)) {
        throw error;
      }

      const snapshot = await this.readThread(threadId);
      const latestReviewTurnId = findLatestReviewTurnId(snapshot);
      console.log("[codex-review] review interrupt recovery snapshot", {
        threadId,
        currentTurnId: effectiveTurnId,
        latestReviewTurnId: latestReviewTurnId ?? null,
        latestReviewTurnExited: latestReviewTurnId
          ? isExitedReviewTurn(snapshot, latestReviewTurnId)
          : false,
        snapshotTurnIds: snapshot.turns.map((turn) => String(turn.id)),
      });

      if (latestReviewTurnId && isExitedReviewTurn(snapshot, latestReviewTurnId)) {
        console.log("[codex-review] settling review from thread/read exitedReviewMode", {
          threadId,
          turnId: latestReviewTurnId,
        });
        this.settleTrackedReview(context, {
          completedTurnId: latestReviewTurnId,
          reason: "review exited via thread/read",
        });
        return;
      }

      if (latestReviewTurnId && latestReviewTurnId !== effectiveTurnId) {
        console.log("[codex-review] retrying turn/interrupt with refreshed review turn", {
          threadId,
          previousTurnId: effectiveTurnId,
          nextTurnId: latestReviewTurnId,
        });
        await this.sendRequest(context, "turn/interrupt", {
          threadId: providerThreadId,
          turnId: latestReviewTurnId,
        });
        context.reviewTurnIds.add(latestReviewTurnId);
        this.updateSession(context, {
          activeTurnId: latestReviewTurnId,
        });
        return;
      }

      throw error;
    }
  }

  async readThread(threadId: ThreadId): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }

    const response = await this.sendRequest(context, "thread/read", {
      threadId: providerThreadId,
      includeTurns: true,
    });
    return parseThreadSnapshot("thread/read", response);
  }

  async readExternalThread(input: {
    externalThreadId: string;
    cwd?: string;
  }): Promise<CodexThreadSnapshot> {
    const context = await this.resolveContextForDiscovery(undefined, input.cwd);
    const response = await this.sendRequest(context, "thread/read", {
      threadId: input.externalThreadId,
      includeTurns: true,
    });
    return parseThreadSnapshot("thread/read", response);
  }

  async forkThread(input: ProviderForkThreadInput): Promise<ProviderForkThreadResult> {
    const threadId = input.threadId;
    const now = new Date().toISOString();
    let context: CodexSessionContext | undefined;

    try {
      const existing = this.sessions.get(threadId);
      if (existing) {
        this.stopSession(threadId);
      }

      const sourceProviderThreadId = readResumeCursorThreadId(input.sourceResumeCursor);
      if (!sourceProviderThreadId) {
        throw new Error("Provider fork is missing the source thread resume id.");
      }

      const resolvedCwd = input.cwd ?? ensureIsolatedScratchWorkspace(threadId);
      const session: ProviderSession = {
        provider: "codex",
        status: "connecting",
        runtimeMode: input.runtimeMode,
        model:
          input.modelSelection?.provider === "codex"
            ? normalizeCodexModelSlug(input.modelSelection.model)
            : undefined,
        cwd: resolvedCwd,
        threadId,
        createdAt: now,
        updatedAt: now,
      };

      const codexOptions = readCodexProviderOptions({
        threadId,
        ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
        runtimeMode: input.runtimeMode,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      });
      const codexBinaryPath = codexOptions.binaryPath ?? "codex";
      const codexHomePath = codexOptions.homePath;
      this.assertSupportedCodexCliVersion({
        binaryPath: codexBinaryPath,
        cwd: resolvedCwd,
        ...(codexHomePath ? { homePath: codexHomePath } : {}),
      });
      const transport = await this.createTransport({
        binaryPath: codexBinaryPath,
        cwd: resolvedCwd,
        ...(codexHomePath ? { homePath: codexHomePath } : {}),
      });

      context = {
        session,
        account: {
          type: "unknown",
          planType: null,
          sparkEnabled: true,
        },
        transport,
        pending: new Map(),
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        collabReceiverTurns: new Map(),
        collabReceiverParents: new Map(),
        reviewTurnIds: new Set(),
        nextRequestId: 1,
        stopping: false,
      };

      this.sessions.set(threadId, context);
      this.attachProcessListeners(context);
      this.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

      await this.sendRequest(context, "initialize", buildCodexInitializeParams());
      this.writeMessage(context, { method: "initialized" });
      try {
        const accountReadResponse = await this.sendRequest(context, "account/read", {});
        context.account = readCodexAccountSnapshot(accountReadResponse);
      } catch {
        // Fork can proceed without account metadata; model fallback will stay best-effort.
      }

      const normalizedModel =
        input.modelSelection?.provider === "codex"
          ? resolveCodexModelForAccount(
              normalizeCodexModelSlug(input.modelSelection.model),
              context.account,
            )
          : undefined;
      const useFastServiceTier =
        input.modelSelection?.provider === "codex" &&
        getModelSelectionBooleanOptionValue(input.modelSelection, "fastMode") === true;
      const forkParams = {
        threadId: sourceProviderThreadId,
        ...(normalizedModel ? { model: normalizedModel } : {}),
        ...(useFastServiceTier ? { serviceTier: "fast" as const } : {}),
        cwd: resolvedCwd,
        ...mapCodexRuntimeMode(input.runtimeMode),
      };

      this.emitLifecycleEvent(
        context,
        "session/threadOpenRequested",
        `Forking Codex thread ${sourceProviderThreadId}.`,
      );
      const response = await this.sendRequest(context, "thread/fork", forkParams);
      const forkedProviderThreadId = readThreadIdFromResponse("thread/fork", response);

      this.updateSession(context, {
        status: "ready",
        resumeCursor: { threadId: forkedProviderThreadId },
      });
      this.emitLifecycleEvent(context, "session/threadOpenResolved", "Codex thread/fork resolved.");
      this.emitLifecycleEvent(
        context,
        "session/ready",
        `Connected to thread ${forkedProviderThreadId}`,
      );

      return {
        threadId,
        resumeCursor: {
          threadId: forkedProviderThreadId,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to fork Codex thread.";
      if (context) {
        this.updateSession(context, {
          status: "error",
          lastError: message,
        });
        this.emitErrorEvent(context, "session/threadForkFailed", message);
        this.stopSession(threadId);
      }
      throw new Error(message, { cause: error });
    }
  }

  async rollbackThread(threadId: ThreadId, numTurns: number): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error("numTurns must be an integer >= 1.");
    }

    const response = await this.sendRequest(context, "thread/rollback", {
      threadId: providerThreadId,
      numTurns,
    });
    this.updateSession(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    return parseThreadSnapshot("thread/rollback", response);
  }

  async compactThread(threadId: ThreadId): Promise<void> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }

    await Effect.logInfo("codex app-server compact requested", {
      threadId: context.session.threadId,
      providerThreadId,
      runtimeMode: context.session.runtimeMode,
      activeTurnId: context.session.activeTurnId ?? null,
    }).pipe(this.runPromise);

    this.updateSession(context, {
      status: "running",
    });
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      ...(context.session.activeTurnId ? { turnId: context.session.activeTurnId } : {}),
      method: "thread/compacting",
      message: "Compacting context",
      payload: {
        threadId: providerThreadId,
        state: "compacting",
      },
    });
    try {
      await this.sendRequest(context, "thread/compact/start", {
        threadId: providerThreadId,
      });
      await Effect.logInfo("codex app-server compact start acknowledged", {
        threadId: context.session.threadId,
        providerThreadId,
      }).pipe(this.runPromise);
    } catch (error) {
      this.updateSession(context, {
        status: "error",
        lastError: error instanceof Error ? error.message : context.session.lastError,
      });
      await Effect.logWarning("codex app-server compact failed", {
        threadId: context.session.threadId,
        providerThreadId,
        cause: error,
      }).pipe(this.runPromise);
      throw error;
    }
  }

  private resolveApprovalRequest(
    context: CodexSessionContext,
    pendingRequest: PendingApprovalRequest,
    decision: ProviderApprovalDecision,
  ): void {
    this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: {
        decision,
      },
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/requestApproval/decision",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      requestKind: pendingRequest.requestKind,
      payload: {
        requestId: pendingRequest.requestId,
        requestKind: pendingRequest.requestKind,
        decision,
      },
    });
  }

  private resolveRemainingSessionApprovalRequests(context: CodexSessionContext): void {
    const remainingRequests = Array.from(context.pendingApprovals.values());
    context.pendingApprovals.clear();
    for (const pendingRequest of remainingRequests) {
      this.resolveApprovalRequest(context, pendingRequest, "acceptForSession");
    }
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingApprovals.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending approval request: ${requestId}`);
    }

    context.pendingApprovals.delete(requestId);
    if (decision === "acceptForSession") {
      context.sessionApprovalOverride = CODEX_ALWAYS_ALLOW_SESSION_TURN_OVERRIDES;
    }
    this.resolveApprovalRequest(context, pendingRequest, decision);
    if (decision === "acceptForSession") {
      this.resolveRemainingSessionApprovalRequests(context);
    }
  }

  async respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingUserInputs.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending user input request: ${requestId}`);
    }

    context.pendingUserInputs.delete(requestId);
    const codexAnswers = toCodexUserInputAnswers(answers);
    this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: {
        answers: codexAnswers,
      },
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/tool/requestUserInput/answered",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      payload: {
        requestId: pendingRequest.requestId,
        answers: codexAnswers,
      },
    });
  }

  stopSession(threadId: ThreadId): void {
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }

    context.stopping = true;

    for (const pending of context.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Session stopped before request completed."));
    }
    context.pending.clear();
    context.pendingApprovals.clear();
    context.pendingUserInputs.clear();

    this.closeTransport(context);

    this.updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
    });
    this.emitLifecycleEvent(context, "session/closed", "Session stopped");
    this.sessions.delete(threadId);
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values(), ({ session }) => ({
      ...session,
    }));
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  stopAll(): void {
    for (const threadId of this.sessions.keys()) {
      this.stopSession(threadId);
    }
    for (const discoveryKey of this.discoverySessions.keys()) {
      this.stopDiscoverySession(discoveryKey);
    }
  }

  async listSkills(input: CodexSkillListInput): Promise<ProviderListSkillsResult> {
    const cwd = input.cwd.trim();
    const cacheKey = JSON.stringify({
      cwd,
      threadId: input.threadId?.trim() || null,
    });
    if (!input.forceReload) {
      const cached = this.skillsCache.get(cacheKey);
      if (cached) {
        return {
          ...cached,
          cached: true,
        };
      }
    }

    const context = await this.resolveContextForDiscovery(input.threadId, cwd);
    let response: Record<string, unknown>;
    try {
      response = await this.sendRequest<Record<string, unknown>>(context, "skills/list", {
        cwds: [cwd],
        ...(input.forceReload ? { forceReload: true } : {}),
      });
    } catch (error) {
      if (!shouldRetrySkillsListWithCwdFallback(error)) {
        throw error;
      }
      response = await this.sendRequest<Record<string, unknown>>(context, "skills/list", {
        cwd,
        ...(input.forceReload ? { forceReload: true } : {}),
      });
    }
    const skills = parseSkillsListResponse(response, cwd);
    const result: ProviderListSkillsResult = {
      skills,
      source: "codex-app-server",
      cached: false,
    };
    this.skillsCache.set(cacheKey, result);
    return result;
  }

  async listPlugins(input: CodexPluginListInput): Promise<ProviderListPluginsResult> {
    const cwd = input.cwd?.trim() || null;
    const cacheKey = JSON.stringify({
      cwd,
      threadId: input.threadId?.trim() || null,
      forceRemoteSync: input.forceRemoteSync === true,
    });
    if (!input.forceReload) {
      const cached = this.pluginsCache.get(cacheKey);
      if (cached) {
        return {
          ...cached,
          cached: true,
        };
      }
    }

    const context = await this.resolveContextForDiscovery(input.threadId, cwd ?? undefined);
    const response = await this.sendRequest<Record<string, unknown>>(context, "plugin/list", {
      ...(cwd ? { cwds: [cwd] } : {}),
      ...(input.forceRemoteSync ? { forceRemoteSync: true } : {}),
    });
    const result: ProviderListPluginsResult = {
      ...parsePluginListResponse(response),
      source: "codex-app-server",
      cached: false,
    };
    this.pluginsCache.set(cacheKey, result);
    return result;
  }

  async readPlugin(input: CodexPluginReadInput): Promise<ProviderReadPluginResult> {
    const marketplacePath = input.marketplacePath.trim();
    const pluginName = input.pluginName.trim();
    const cacheKey = JSON.stringify({
      marketplacePath,
      pluginName,
    });
    const cached = this.pluginDetailCache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        cached: true,
      };
    }

    const context = await this.resolveContextForDiscovery(undefined);
    const response = await this.sendRequest<Record<string, unknown>>(context, "plugin/read", {
      marketplacePath,
      pluginName,
    });
    const result: ProviderReadPluginResult = {
      plugin: parsePluginReadResponse(response),
      source: "codex-app-server",
      cached: false,
    };
    this.pluginDetailCache.set(cacheKey, result);
    return result;
  }

  async listModels(threadId?: string): Promise<ProviderListModelsResult> {
    const cacheKey = threadId?.trim() || "__default__";
    const cached = this.modelCache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        cached: true,
      };
    }

    const context = await this.resolveContextForDiscovery(threadId);
    const response = await this.sendRequest<Record<string, unknown>>(context, "model/list", {
      cursor: null,
      limit: 50,
      includeHidden: false,
    });
    const models = parseModelListResponse(response);
    const result: ProviderListModelsResult = {
      models,
      source: "codex-app-server",
      cached: false,
    };
    this.modelCache.set(cacheKey, result);
    return result;
  }

  async transcribeVoice(
    input: ServerVoiceTranscriptionInput,
  ): Promise<ServerVoiceTranscriptionResult> {
    return transcribeVoiceWithChatGptSession({
      request: input,
      resolveAuth: (refreshToken) =>
        this.resolveVoiceTranscriptionAuth({
          cwd: input.cwd,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          refreshToken,
        }),
    });
  }

  getComposerCapabilities(): ProviderComposerCapabilities {
    return {
      provider: "codex",
      supportsSkillMentions: true,
      supportsSkillDiscovery: true,
      supportsNativeSlashCommandDiscovery: false,
      supportsPluginMentions: true,
      supportsPluginDiscovery: true,
      supportsRuntimeModelList: true,
      supportsThreadCompaction: true,
      supportsThreadImport: true,
    };
  }

  private requireSession(threadId: ThreadId): CodexSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown session for thread: ${threadId}`);
    }

    if (context.session.status === "closed") {
      throw new Error(`Session is closed for thread: ${threadId}`);
    }

    return context;
  }

  private async resolveContextForDiscovery(
    threadId?: string,
    cwd?: string,
  ): Promise<CodexSessionContext> {
    const normalizedThreadId = threadId?.trim();
    const normalizedCwd = cwd?.trim() || undefined;
    if (normalizedThreadId) {
      try {
        const session = this.requireSession(ThreadId.makeUnsafe(normalizedThreadId));
        if (!normalizedCwd || session.session.cwd === normalizedCwd) {
          return session;
        }
      } catch {
        // Discovery is read-only metadata, so if the current draft thread does not
        // have a live Codex session yet we can still service repo-scoped
        // discovery through a dedicated discovery session for that cwd.
      }
    }
    if (normalizedCwd) {
      for (const activeSession of this.sessions.values()) {
        if (
          !activeSession.stopping &&
          activeSession.session.cwd === normalizedCwd &&
          (await this.isContextAlive(activeSession))
        ) {
          return activeSession;
        }
      }
      return this.getOrCreateDiscoverySession(normalizedCwd);
    }
    const firstActive = this.sessions.values().next().value;
    if (firstActive) {
      return firstActive;
    }
    return this.getOrCreateDiscoverySession(process.cwd());
  }

  private async resolveVoiceTranscriptionAuth(input: {
    readonly cwd?: string;
    readonly threadId?: string;
    readonly refreshToken: boolean;
  }): Promise<CodexVoiceTranscriptionAuthContext> {
    // Voice transcription should always resolve auth from a fresh discovery context
    // instead of reusing a possibly stale thread-bound session token.
    const context = await this.getOrCreateDiscoverySession(input.cwd?.trim() || process.cwd());
    const readAuthStatus = async (refreshToken: boolean) => {
      const response = await this.sendRequest<Record<string, unknown>>(context, "getAuthStatus", {
        includeToken: true,
        refreshToken,
      });
      const authMethod = readString(response, "authMethod");
      return {
        authMethod,
        token: readString(response, "authToken"),
      };
    };

    let { authMethod, token } = await readAuthStatus(input.refreshToken);
    if (!token && !input.refreshToken) {
      ({ authMethod, token } = await readAuthStatus(true));
    }

    if (!token) {
      throw new Error("No ChatGPT session token is available. Sign in to ChatGPT in Codex.");
    }
    if (authMethod !== "chatgpt" && authMethod !== "chatgptAuthTokens") {
      throw new Error("Voice transcription requires a ChatGPT-authenticated Codex session.");
    }

    return {
      authMethod,
      token,
    };
  }

  private async getOrCreateDiscoverySession(cwd: string): Promise<CodexSessionContext> {
    const normalizedCwd = cwd.trim() || process.cwd();
    const existing = this.discoverySessions.get(normalizedCwd);
    if (existing && !existing.stopping && (await this.isContextAlive(existing))) {
      this.scheduleDiscoverySessionIdleStop(normalizedCwd);
      return existing;
    }

    const now = new Date().toISOString();
    this.assertSupportedCodexCliVersion({
      binaryPath: "codex",
      cwd: normalizedCwd,
    });
    const transport = await this.createTransport({
      binaryPath: "codex",
      cwd: normalizedCwd,
    });
    const context: CodexSessionContext = {
      session: {
        provider: "codex",
        status: "connecting",
        runtimeMode: "full-access",
        model: CODEX_DEFAULT_MODEL,
        cwd: normalizedCwd,
        threadId: ThreadId.makeUnsafe(`__codex_discovery__:${normalizedCwd}`),
        createdAt: now,
        updatedAt: now,
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      transport,
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      nextRequestId: 1,
      stopping: false,
      discovery: true,
    };

    this.discoverySessions.set(normalizedCwd, context);
    this.attachProcessListeners(context);
    try {
      await this.sendRequest(context, "initialize", buildCodexInitializeParams());
      this.writeMessage(context, { method: "initialized" });
      try {
        const accountReadResponse = await this.sendRequest(context, "account/read", {});
        context.account = readCodexAccountSnapshot(accountReadResponse);
      } catch {
        // Discovery can still function without account metadata.
      }
      this.updateSession(context, { status: "ready" });
      this.scheduleDiscoverySessionIdleStop(normalizedCwd);
      return context;
    } catch (error) {
      this.stopDiscoverySession(normalizedCwd);
      throw error;
    }
  }

  private scheduleDiscoverySessionIdleStop(discoveryKey: string): void {
    const existingTimer = this.discoverySessionIdleTimers.get(discoveryKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      const context = this.discoverySessions.get(discoveryKey);
      if (!context || context.stopping) {
        this.discoverySessionIdleTimers.delete(discoveryKey);
        return;
      }
      if (
        context.pending.size > 0 ||
        context.pendingApprovals.size > 0 ||
        context.pendingUserInputs.size > 0
      ) {
        this.scheduleDiscoverySessionIdleStop(discoveryKey);
        return;
      }

      this.stopDiscoverySession(discoveryKey);
    }, CODEX_DISCOVERY_SESSION_IDLE_MS);
    timer.unref();
    this.discoverySessionIdleTimers.set(discoveryKey, timer);
  }

  private stopDiscoverySession(discoveryKey: string): void {
    const idleTimer = this.discoverySessionIdleTimers.get(discoveryKey);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.discoverySessionIdleTimers.delete(discoveryKey);
    }

    const context = this.discoverySessions.get(discoveryKey);
    if (!context) {
      return;
    }

    context.stopping = true;
    for (const pending of context.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Discovery session stopped before request completed."));
    }
    context.pending.clear();
    this.closeTransport(context);

    this.discoverySessions.delete(discoveryKey);
  }

  private attachProcessListeners(context: CodexSessionContext): void {
    const onInboundLine = (line: string) => {
      if (context.stopping || isIgnorableCodexProcessLine(line)) {
        return;
      }
      this.handleStdoutLine(context, line);
    };

    const onStderrLine = (line: string) => {
      if (context.stopping) {
        return;
      }
      const classified = classifyCodexStderrLine(line);
      if (!classified) {
        return;
      }
      this.emitErrorEvent(context, "process/stderr", classified.message);
    };

    const onExit = ({ code, signal }: ProcessExit) => {
      if (context.stopping) {
        return;
      }

      const message = `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      this.updateSession(context, {
        status: "closed",
        activeTurnId: undefined,
        lastError: code === 0 ? context.session.lastError : message,
      });
      this.emitLifecycleEvent(context, "session/exited", message);
      if (context.discovery) {
        const discoveryKey = context.session.cwd ?? "";
        if (discoveryKey) {
          this.discoverySessions.delete(discoveryKey);
        }
      } else {
        this.sessions.delete(context.session.threadId);
      }
    };

    void this.runPromise(
      Stream.runForEach(context.transport.inbound, (line) =>
        Effect.sync(() => onInboundLine(line)),
      ).pipe(Effect.ignore),
    );
    void this.runPromise(
      Stream.runForEach(context.transport.stderr, (line) =>
        Effect.sync(() => onStderrLine(line)),
      ).pipe(Effect.ignore),
    );
    void this.runPromise(
      Deferred.await(context.transport.exit).pipe(Effect.map((status) => onExit(status))),
    );
  }

  private handleStdoutLine(context: CodexSessionContext, line: string): void {
    if (isIgnorableCodexProcessLine(line)) {
      return;
    }

    // A line whose first non-whitespace char is not `{` is not a JSON-RPC frame:
    // it is codex process/log output. On a remote PTY transport stdout and stderr
    // are merged, so codex's own log lines are interleaved into this inbound
    // stream rather than arriving on the (empty) stderr side channel. Route them
    // through the stderr classifier — emitting `process/stderr` only for
    // ERROR-level codex logs — to restore the local-transport split where such
    // lines were warnings, never a user-visible `protocol/parseError` flood.
    if (!isJsonObjectLine(line)) {
      const classified = classifyCodexStderrLine(line);
      if (classified) {
        this.emitErrorEvent(context, "process/stderr", classified.message);
      }
      return;
    }

    // Parse the ANSI-stripped line, not the raw one: on the merged PTY stream a
    // real frame can carry non-SGR ANSI (bracketed-paste, OSC) that `JSON.parse`
    // rejects. `isJsonObjectLine` gated on the stripped form, so parsing must use
    // the same normalization or a stripped-but-real frame is silently dropped.
    const normalizedLine = normalizeCodexProcessLine(line);
    let parsed: unknown;
    try {
      parsed = JSON.parse(normalizedLine);
    } catch {
      // The frame gate already filtered non-JSON log noise; a line that looks
      // like a JSON object yet fails to parse is a rare malformed frame. Keep it
      // out of the user-visible error channel — log at debug and drop it.
      if (process.env.SYNARA_DEBUG_CODEX_TRANSPORT === "1") {
        console.debug("[codex] dropped unparseable inbound frame", line);
      }
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      this.emitErrorEvent(
        context,
        "protocol/invalidMessage",
        "Received non-object protocol message.",
      );
      return;
    }

    if (isServerRequest(parsed)) {
      this.handleServerRequest(context, parsed);
      return;
    }

    if (isServerNotification(parsed)) {
      this.handleServerNotification(context, parsed);
      return;
    }

    if (isResponse(parsed)) {
      this.handleResponse(context, parsed);
      return;
    }

    this.emitErrorEvent(
      context,
      "protocol/unrecognizedMessage",
      "Received protocol message in an unknown shape.",
    );
  }

  private handleServerNotification(
    context: CodexSessionContext,
    notification: JsonRpcNotification,
  ): void {
    const rawRoute = readRouteFields(notification.params);
    this.rememberCollabReceiverTurns(context, notification.params, rawRoute.turnId);
    const childParentTurnId = this.readChildParentTurnId(context, notification.params);
    const providerThreadId = normalizeProviderThreadId(
      readProviderConversationId(notification.params),
    );
    const providerParentThreadId = this.readChildParentProviderThreadId(
      context,
      notification.params,
    );
    const isChildConversation = childParentTurnId !== undefined;
    if (
      isChildConversation &&
      this.shouldSuppressChildConversationNotification(notification.method)
    ) {
      return;
    }
    const textDelta = this.readNotificationTextDelta(notification);

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: notification.method,
      ...(rawRoute.turnId ? { turnId: rawRoute.turnId } : {}),
      ...(childParentTurnId ? { parentTurnId: childParentTurnId } : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      ...(providerThreadId ? { providerThreadId } : {}),
      ...(providerParentThreadId ? { providerParentThreadId } : {}),
      textDelta,
      payload: notification.params,
    });

    if (notification.method === "thread/started") {
      const startedThreadId = normalizeProviderThreadId(
        readString(readObject(notification.params)?.thread, "id"),
      );
      if (startedThreadId && !isChildConversation) {
        this.updateSession(context, {
          resumeCursor: { threadId: startedThreadId },
        });
      }
      return;
    }

    if (notification.method === "turn/started") {
      if (isChildConversation) {
        return;
      }
      const turnId = toTurnId(readString(readObject(notification.params)?.turn, "id"));
      if (
        turnId !== undefined &&
        context.session.activeTurnId !== undefined &&
        context.reviewTurnIds.has(context.session.activeTurnId)
      ) {
        context.reviewTurnIds.add(turnId);
        console.log("[codex-review] extending tracked review turn set on turn/started", {
          threadId: context.session.threadId,
          previousTurnId: context.session.activeTurnId,
          nextTurnId: turnId,
        });
      }
      this.updateSession(context, {
        status: "running",
        activeTurnId: turnId,
      });
      return;
    }

    if (notification.method === "turn/completed") {
      if (isChildConversation) {
        return;
      }
      context.collabReceiverTurns.clear();
      if (rawRoute.turnId) {
        context.reviewTurnIds.delete(rawRoute.turnId);
      }
      const turn = readObject(notification.params, "turn");
      const status = readString(turn, "status");
      const errorMessageRaw = readString(readObject(turn, "error"), "message");
      const errorMessage =
        errorMessageRaw !== undefined
          ? normalizeCodexUserVisibleErrorMessage(errorMessageRaw)
          : undefined;
      this.updateSession(context, {
        status: status === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        lastError: errorMessage ?? context.session.lastError,
      });
      return;
    }

    if (notification.method === "turn/aborted") {
      if (isChildConversation) {
        return;
      }
      context.collabReceiverTurns.clear();
      if (rawRoute.turnId) {
        context.reviewTurnIds.delete(rawRoute.turnId);
      }
      this.updateSession(context, {
        status: "ready",
        activeTurnId: undefined,
        lastError: undefined,
      });
      return;
    }

    if (isExitedReviewModeNotification(notification)) {
      if (isChildConversation) {
        return;
      }
      const item = readObject(notification.params, "item");
      const reviewTurnId = toTurnId(readString(item, "id")) ?? rawRoute.turnId;
      const reviewTurnTracked =
        reviewTurnId !== undefined ? context.reviewTurnIds.has(reviewTurnId) : false;
      const activeTurnTracked =
        context.session.activeTurnId !== undefined &&
        context.reviewTurnIds.has(context.session.activeTurnId);
      console.log("[codex-review] exitedReviewMode notification", {
        threadId: context.session.threadId,
        reviewTurnId: reviewTurnId ?? null,
        activeTurnId: context.session.activeTurnId ?? null,
        reviewTurnTracked,
        activeTurnTracked,
      });
      if (
        reviewTurnId !== undefined &&
        context.session.activeTurnId !== undefined &&
        reviewTurnId !== context.session.activeTurnId &&
        !reviewTurnTracked &&
        !activeTurnTracked
      ) {
        console.log("[codex-review] exitedReviewMode ignored due to turn mismatch", {
          threadId: context.session.threadId,
          reviewTurnId,
          activeTurnId: context.session.activeTurnId,
        });
        return;
      }
      // `review/start` can emit the final review result via `exitedReviewMode`
      // before the terminal `turn/completed` notification arrives. If that
      // completion never shows up, settle the session here instead of leaving
      // native review stuck in "running" forever.
      console.log("[codex-review] settling review from exitedReviewMode notification", {
        threadId: context.session.threadId,
        reviewTurnId: reviewTurnId ?? null,
      });
      this.settleTrackedReview(
        context,
        reviewTurnId !== undefined
          ? {
              completedTurnId: reviewTurnId,
              reason: "review exited via exitedReviewMode",
            }
          : {
              reason: "review exited via exitedReviewMode",
            },
      );
      return;
    }

    if (notification.method === "error") {
      if (isChildConversation) {
        return;
      }
      const rawMessage = readString(readObject(notification.params)?.error, "message");
      const message =
        rawMessage !== undefined ? normalizeCodexUserVisibleErrorMessage(rawMessage) : undefined;
      const willRetry = readBoolean(notification.params, "willRetry");
      const isNonFatalWarning =
        message !== undefined && !willRetry && isNonFatalCodexErrorMessage(message);

      if (willRetry) {
        this.updateSession(context, {
          status: "running",
        });
        return;
      }

      if (isNonFatalWarning) {
        return;
      }

      this.updateSession(context, {
        status: "error",
        lastError: message ?? context.session.lastError,
      });
    }
  }

  private readNotificationTextDelta(notification: JsonRpcNotification): string | undefined {
    switch (notification.method) {
      case "item/agentMessage/delta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
      case "item/plan/delta":
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        return readString(notification.params, "delta");
      default:
        return undefined;
    }
  }

  private handleServerRequest(context: CodexSessionContext, request: JsonRpcRequest): void {
    const rawRoute = readRouteFields(request.params);
    const childParentTurnId = this.readChildParentTurnId(context, request.params);
    const providerThreadId = normalizeProviderThreadId(readProviderConversationId(request.params));
    const providerParentThreadId = this.readChildParentProviderThreadId(context, request.params);
    const requestKind = requestKindForMethod(request.method);
    let requestId: ApprovalRequestId | undefined;
    if (requestKind) {
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      const pendingRequest: PendingApprovalRequest = {
        requestId,
        jsonRpcId: request.id,
        method:
          requestKind === "command"
            ? "item/commandExecution/requestApproval"
            : requestKind === "file-read"
              ? "item/fileRead/requestApproval"
              : "item/fileChange/requestApproval",
        requestKind,
        threadId: context.session.threadId,
        ...(rawRoute.turnId ? { turnId: rawRoute.turnId } : {}),
        ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      };
      if (context.sessionApprovalOverride) {
        this.resolveApprovalRequest(context, pendingRequest, "acceptForSession");
        return;
      }
      context.pendingApprovals.set(requestId, pendingRequest);
    }

    if (request.method === "item/tool/requestUserInput") {
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      context.pendingUserInputs.set(requestId, {
        requestId,
        jsonRpcId: request.id,
        threadId: context.session.threadId,
        ...(rawRoute.turnId ? { turnId: rawRoute.turnId } : {}),
        ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      });
    }

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "request",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: request.method,
      ...(rawRoute.turnId ? { turnId: rawRoute.turnId } : {}),
      ...(childParentTurnId ? { parentTurnId: childParentTurnId } : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      ...(providerThreadId ? { providerThreadId } : {}),
      ...(providerParentThreadId ? { providerParentThreadId } : {}),
      requestId,
      requestKind,
      payload: request.params,
    });

    if (requestKind) {
      return;
    }

    if (request.method === "item/tool/requestUserInput") {
      return;
    }

    this.writeMessage(context, {
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported server request: ${request.method}`,
      },
    });
  }

  private handleResponse(context: CodexSessionContext, response: JsonRpcResponse): void {
    const key = String(response.id);
    const pending = context.pending.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    context.pending.delete(key);

    if (response.error?.message) {
      pending.reject(new Error(`${pending.method} failed: ${String(response.error.message)}`));
      return;
    }

    pending.resolve(response.result);
  }

  private async sendRequest<TResponse>(
    context: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs = 20_000,
  ): Promise<TResponse> {
    const id = context.nextRequestId;
    context.nextRequestId += 1;

    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        context.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      context.pending.set(String(id), {
        method,
        timeout,
        resolve,
        reject,
      });
      this.writeMessage(context, {
        method,
        id,
        params,
      });
    });

    return result as TResponse;
  }

  private writeMessage(context: CodexSessionContext, message: unknown): void {
    void this.runPromise(
      context.transport.send(message).pipe(
        Effect.catchTag("TransportClosedError", (error) =>
          Effect.sync(() => {
            if (!context.stopping) {
              this.emitErrorEvent(context, "process/error", error.detail);
            }
          }),
        ),
      ),
    );
  }

  private emitLifecycleEvent(context: CodexSessionContext, method: string, message: string): void {
    if (context.discovery) {
      return;
    }
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "session",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitErrorEvent(context: CodexSessionContext, method: string, message: string): void {
    if (context.discovery) {
      return;
    }
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "error",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitEvent(event: ProviderEvent): void {
    this.emit("event", event);
  }

  private settleTrackedReview(
    context: CodexSessionContext,
    input: {
      readonly completedTurnId?: TurnId;
      readonly reason: string;
    },
  ): void {
    const terminalTurnId =
      context.session.activeTurnId !== undefined &&
      context.reviewTurnIds.has(context.session.activeTurnId)
        ? context.session.activeTurnId
        : input.completedTurnId !== undefined && context.reviewTurnIds.has(input.completedTurnId)
          ? input.completedTurnId
          : context.reviewTurnIds.values().next().value;

    this.updateSession(context, {
      status: "ready",
      activeTurnId: undefined,
      lastError: undefined,
    });

    context.reviewTurnIds.clear();

    if (!terminalTurnId) {
      return;
    }

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "turn/completed",
      turnId: terminalTurnId,
      message: input.reason,
      payload: {
        turn: {
          id: terminalTurnId,
          status: "completed",
        },
      },
    });
  }

  private assertSupportedCodexCliVersion(input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly homePath?: string;
    readonly hasSuppliedTransport?: boolean;
  }): void {
    // The CLI version gate runs `codex --version` against this host, so it only
    // applies to the local-process transport. A supplied transport (in-memory
    // test fake, or a remote sandbox runtime) has no local binary to probe —
    // whether supplied at construction or per session.
    if (this.transportFactory || input.hasSuppliedTransport) {
      return;
    }
    assertSupportedCodexCliVersion(input);
  }

  // Resolve the model to send to a sandbox-backed codex against the catalog it
  // advertised via `model/list`. Falls back to the product default when the
  // request is absent from the catalog so a mismatch degrades to a working model
  // instead of wedging the turn (g32). An empty catalog trusts the request.
  private selectSandboxCodexModel(
    requested: string | undefined,
    available: ReadonlyArray<string>,
    context: { readonly threadId: string },
  ): string | null {
    const selection = selectAvailableCodexModel({
      requested,
      available,
      preferredFallback: CODEX_DEFAULT_MODEL,
    });
    if (selection.fellBack) {
      console.log("codex model fallback (sandbox catalog mismatch)", {
        threadId: context.threadId,
        requested: requested ?? null,
        selected: selection.model,
        available,
      });
    }
    return selection.model;
  }

  private updateSession(context: CodexSessionContext, updates: Partial<ProviderSession>): void {
    context.session = {
      ...context.session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  }

  private readChildParentTurnId(context: CodexSessionContext, params: unknown): TurnId | undefined {
    const providerConversationId = readProviderConversationId(params);
    if (!providerConversationId) {
      return undefined;
    }
    return context.collabReceiverTurns.get(providerConversationId);
  }

  private readChildParentProviderThreadId(
    context: CodexSessionContext,
    params: unknown,
  ): string | undefined {
    const providerConversationId = readProviderConversationId(params);
    if (!providerConversationId) {
      return undefined;
    }
    return context.collabReceiverParents.get(providerConversationId);
  }

  private rememberCollabReceiverTurns(
    context: CodexSessionContext,
    params: unknown,
    parentTurnId: TurnId | undefined,
  ): void {
    if (!parentTurnId) {
      return;
    }
    const payload = readObject(params);
    const item = readObject(payload, "item") ?? payload;
    const itemType = readString(item, "type") ?? readString(item, "kind");
    if (itemType !== "collabAgentToolCall") {
      return;
    }
    const parentProviderThreadId = normalizeProviderThreadId(readProviderConversationId(params));

    const receiverThreadIds =
      readArray(item, "receiverThreadIds")
        ?.map((value) => (typeof value === "string" ? value : null))
        .filter((value): value is string => value !== null) ?? [];
    for (const receiverThreadId of receiverThreadIds) {
      context.collabReceiverTurns.set(receiverThreadId, parentTurnId);
      if (parentProviderThreadId) {
        context.collabReceiverParents.set(receiverThreadId, parentProviderThreadId);
      }
    }
  }

  private shouldSuppressChildConversationNotification(method: string): boolean {
    // Intentionally do NOT suppress `turn/plan/updated` or `item/plan/delta` here,
    // even for child conversations. These are the events that let the active plan
    // card advance ("1 out of 5" → "2 out of 5" ...) and render streaming plan text;
    // suppressing them freezes the plan UI at its initial all-pending snapshot.
    return (
      method === "thread/started" ||
      method === "thread/status/changed" ||
      method === "thread/archived" ||
      method === "thread/unarchived" ||
      method === "thread/closed" ||
      method === "thread/compacted" ||
      method === "thread/name/updated" ||
      method === "thread/tokenUsage/updated" ||
      method === "turn/started" ||
      method === "turn/completed" ||
      method === "turn/aborted"
    );
  }
}
