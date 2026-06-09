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
import { Deferred, Effect, ServiceMap, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { CODEX_DEFAULT_MODEL } from "./codexAppServer.config.ts";
import {
  type CodexDiscoveryQueryDeps,
  listModels as listModelsQuery,
  listPlugins as listPluginsQuery,
  listSkills as listSkillsQuery,
  readPlugin as readPluginQuery,
} from "./codexAppServer.discovery.ts";
import {
  type CodexDiscoverySessionDeps,
  getOrCreateDiscoverySession as getOrCreateDiscoverySessionFn,
  resolveContextForDiscovery as resolveContextForDiscoveryFn,
  resolveVoiceTranscriptionAuth as resolveVoiceTranscriptionAuthFn,
  scheduleDiscoverySessionIdleStop as scheduleDiscoverySessionIdleStopFn,
  stopDiscoverySession as stopDiscoverySessionFn,
} from "./codexAppServer.discoverySession.ts";
import {
  type CodexSessionOpenDeps,
  forkThread as forkThreadFn,
  startSession as startSessionFn,
} from "./codexAppServer.sessionOpen.ts";
import {
  type CodexHandlerDeps,
  handleResponse,
  handleServerNotification,
  handleServerRequest,
  handleStdoutLine,
  resolveApprovalRequest,
  settleTrackedReview,
} from "./codexAppServer.handlers.ts";
import {
  classifyCodexStderrLine,
  isIgnorableCodexProcessLine,
  readCodexAccountSnapshot,
} from "./codexAppServer.protocol.ts";
import {
  findLatestReviewTurnId,
  isExitedReviewTurn,
  isTurnInterruptTimeout,
  parseModelListResponse,
  parseThreadSnapshot,
} from "./codexAppServer.parsers.ts";
import {
  CODEX_ALWAYS_ALLOW_SESSION_TURN_OVERRIDES,
  readResumeThreadId,
  toCodexUserInputAnswers,
} from "./codexAppServer.session.ts";
import type {
  CodexAccountSnapshot,
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
  CodexVoiceTranscriptionAuthContext,
  CodexAppServerManagerEvents,
  CodexAppServerManagerOptions,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./codexAppServer.types.ts";
import {
  type CodexTurnDeps,
  sendTurn as sendTurnFn,
  startReview as startReviewFn,
  steerTurn as steerTurnFn,
} from "./codexAppServer.turns.ts";
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
  private readonly handlerDeps: CodexHandlerDeps;
  private readonly discoveryQueryDeps: CodexDiscoveryQueryDeps;
  private readonly discoverySessionDeps: CodexDiscoverySessionDeps;
  private readonly turnDeps: CodexTurnDeps;
  private readonly sessionOpenDeps: CodexSessionOpenDeps;
  constructor(services?: ServiceMap.ServiceMap<never>, options?: CodexAppServerManagerOptions) {
    super();
    this.services = services;
    this.transportFactory = options?.createTransport;
    this.runPromise = services ? Effect.runPromiseWith(services) : Effect.runPromise;
    this.handlerDeps = {
      emitEvent: (event) => this.emitEvent(event),
      emitErrorEvent: (context, method, message) => this.emitErrorEvent(context, method, message),
      writeMessage: (context, message) => this.writeMessage(context, message),
      updateSession: (context, updates) => this.updateSession(context, updates),
    };
    this.discoverySessionDeps = {
      sessions: this.sessions,
      discoverySessions: this.discoverySessions,
      discoverySessionIdleTimers: this.discoverySessionIdleTimers,
      requireSession: (...args) => this.requireSession(...args),
      isContextAlive: (...args) => this.isContextAlive(...args),
      assertSupportedCodexCliVersion: (...args) => this.assertSupportedCodexCliVersion(...args),
      createTransport: (...args) => this.createTransport(...args),
      attachProcessListeners: (...args) => this.attachProcessListeners(...args),
      sendRequest: (...args) => this.sendRequest(...args),
      writeMessage: (...args) => this.writeMessage(...args),
      updateSession: (...args) => this.updateSession(...args),
      closeTransport: (...args) => this.closeTransport(...args),
      getOrCreateDiscoverySession: (...args) => this.getOrCreateDiscoverySession(...args),
      scheduleDiscoverySessionIdleStop: (...args) => this.scheduleDiscoverySessionIdleStop(...args),
      stopDiscoverySession: (...args) => this.stopDiscoverySession(...args),
    };
    this.sessionOpenDeps = {
      sessions: this.sessions,
      localStartupDiscoveryCache: this.localStartupDiscoveryCache,
      runPromise: (effect) => this.runPromise(effect),
      stopSession: (...args) => this.stopSession(...args),
      assertSupportedCodexCliVersion: (...args) => this.assertSupportedCodexCliVersion(...args),
      createTransport: (...args) => this.createTransport(...args),
      attachProcessListeners: (...args) => this.attachProcessListeners(...args),
      emitLifecycleEvent: (...args) => this.emitLifecycleEvent(...args),
      emitErrorEvent: (...args) => this.emitErrorEvent(...args),
      emitEvent: (...args) => this.emitEvent(...args),
      sendRequest: (...args) => this.sendRequest(...args),
      writeMessage: (...args) => this.writeMessage(...args),
      updateSession: (...args) => this.updateSession(...args),
      resolveStartupDiscovery: (...args) => this.resolveStartupDiscovery(...args),
      selectSandboxCodexModel: (...args) => this.selectSandboxCodexModel(...args),
    };
    this.turnDeps = {
      requireSession: (...args) => this.requireSession(...args),
      sendRequest: (...args) => this.sendRequest(...args),
      updateSession: (...args) => this.updateSession(...args),
      sendTurn: (...args) => this.sendTurn(...args),
    };
    this.discoveryQueryDeps = {
      skillsCache: this.skillsCache,
      pluginsCache: this.pluginsCache,
      pluginDetailCache: this.pluginDetailCache,
      modelCache: this.modelCache,
      resolveContextForDiscovery: (...args) => this.resolveContextForDiscovery(...args),
      sendRequest: (...args) => this.sendRequest(...args),
    };
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
    return startSessionFn(this.sessionOpenDeps, input);
  }

  async sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    return sendTurnFn(this.turnDeps, input);
  }

  async steerTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    return steerTurnFn(this.turnDeps, input);
  }

  async startReview(input: ProviderStartReviewInput): Promise<ProviderTurnStartResult> {
    return startReviewFn(this.turnDeps, input);
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
        settleTrackedReview(this.handlerDeps, context, {
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
    return forkThreadFn(this.sessionOpenDeps, input);
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

  private resolveRemainingSessionApprovalRequests(context: CodexSessionContext): void {
    const remainingRequests = Array.from(context.pendingApprovals.values());
    context.pendingApprovals.clear();
    for (const pendingRequest of remainingRequests) {
      resolveApprovalRequest(this.handlerDeps, context, pendingRequest, "acceptForSession");
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
    resolveApprovalRequest(this.handlerDeps, context, pendingRequest, decision);
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
    return listSkillsQuery(this.discoveryQueryDeps, input);
  }

  async listPlugins(input: CodexPluginListInput): Promise<ProviderListPluginsResult> {
    return listPluginsQuery(this.discoveryQueryDeps, input);
  }

  async readPlugin(input: CodexPluginReadInput): Promise<ProviderReadPluginResult> {
    return readPluginQuery(this.discoveryQueryDeps, input);
  }

  async listModels(threadId?: string): Promise<ProviderListModelsResult> {
    return listModelsQuery(this.discoveryQueryDeps, threadId);
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

  private resolveContextForDiscovery(
    threadId?: string,
    cwd?: string,
  ): Promise<CodexSessionContext> {
    return resolveContextForDiscoveryFn(this.discoverySessionDeps, threadId, cwd);
  }

  private resolveVoiceTranscriptionAuth(input: {
    readonly cwd?: string;
    readonly threadId?: string;
    readonly refreshToken: boolean;
  }): Promise<CodexVoiceTranscriptionAuthContext> {
    return resolveVoiceTranscriptionAuthFn(this.discoverySessionDeps, input);
  }

  private getOrCreateDiscoverySession(cwd: string): Promise<CodexSessionContext> {
    return getOrCreateDiscoverySessionFn(this.discoverySessionDeps, cwd);
  }

  private scheduleDiscoverySessionIdleStop(discoveryKey: string): void {
    scheduleDiscoverySessionIdleStopFn(this.discoverySessionDeps, discoveryKey);
  }

  private stopDiscoverySession(discoveryKey: string): void {
    stopDiscoverySessionFn(this.discoverySessionDeps, discoveryKey);
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

  // Thin seams over the extracted inbound-dispatch handlers. Kept as instance
  // methods because the protocol tests drive them directly on a manager instance.
  private handleStdoutLine(context: CodexSessionContext, line: string): void {
    handleStdoutLine(this.handlerDeps, context, line);
  }

  private handleServerNotification(
    context: CodexSessionContext,
    notification: JsonRpcNotification,
  ): void {
    handleServerNotification(this.handlerDeps, context, notification);
  }

  private handleServerRequest(context: CodexSessionContext, request: JsonRpcRequest): void {
    handleServerRequest(this.handlerDeps, context, request);
  }

  private handleResponse(context: CodexSessionContext, response: JsonRpcResponse): void {
    handleResponse(context, response);
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
}
