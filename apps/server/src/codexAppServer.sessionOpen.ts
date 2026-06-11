// Purpose: Session-open operations for a Codex thread — startSession (spawn/
//   resume a thread with startup discovery and resume fallback) and forkThread
//   (open a forked thread off a source resume cursor). Extracted from
//   CodexAppServerManager so the class stays a shell over these multi-step flows.
// Layer: Free functions over a CodexSessionOpenDeps surface holding the session
//   map, the discovery cache, and the transport/request/emit collaborators plus
//   the Effect run-promise for structured logging. Depends on the pure
//   session/parsers/protocol modules and contracts brands.
// Exports: CodexSessionOpenDeps, startSession, forkThread.
import { randomUUID } from "node:crypto";

import {
  EventId,
  type ProviderForkThreadInput,
  type ProviderForkThreadResult,
  type ProviderEvent,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import { getModelSelectionBooleanOptionValue } from "@t3tools/shared/model";
import { Effect } from "effect";

import { readObject, readString, readThreadIdFromResponse } from "./codexAppServer.parsers.ts";
import {
  isRecoverableThreadResumeError,
  readCodexAccountSnapshot,
  readResumeCursorThreadId,
} from "./codexAppServer.protocol.ts";
import {
  buildCodexInitializeParams,
  ensureIsolatedScratchWorkspace,
  mapCodexRuntimeMode,
  normalizeCodexModelSlug,
  readCodexProviderOptions,
  readResumeThreadId,
  resolveCodexModelForAccount,
} from "./codexAppServer.session.ts";
import type {
  CodexAppServerStartSessionInput,
  CodexSessionContext,
  CodexStartupDiscovery,
  CodexTransportFactory,
  CodexTransportFactoryInput,
} from "./codexAppServer.types.ts";
import type { JsonRpcLineTransport } from "./provider/process/JsonRpcLineTransport.ts";

export interface CodexSessionOpenDeps {
  readonly sessions: Map<ThreadId, CodexSessionContext>;
  readonly discoverySessions: Map<string, CodexSessionContext>;
  readonly discoverySessionIdleTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly localStartupDiscoveryCache: Map<string, CodexStartupDiscovery>;
  runPromise(effect: Effect.Effect<unknown, never>): Promise<unknown>;
  stopSession(threadId: ThreadId): void;
  isContextAlive(context: CodexSessionContext): Promise<boolean>;
  assertSupportedCodexCliVersion(input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly homePath?: string;
    readonly hasSuppliedTransport?: boolean;
  }): void;
  createTransport(
    input: CodexTransportFactoryInput,
    perSessionFactory?: CodexTransportFactory,
  ): Promise<JsonRpcLineTransport>;
  attachProcessListeners(context: CodexSessionContext): void;
  emitLifecycleEvent(context: CodexSessionContext, method: string, message: string): void;
  emitErrorEvent(context: CodexSessionContext, method: string, message: string): void;
  emitEvent(event: ProviderEvent): void;
  sendRequest<TResponse>(
    context: CodexSessionContext,
    method: string,
    params: unknown,
  ): Promise<TResponse>;
  writeMessage(context: CodexSessionContext, message: unknown): void;
  updateSession(context: CodexSessionContext, updates: Partial<ProviderSession>): void;
  resolveStartupDiscovery(
    context: CodexSessionContext,
    cacheKey: string | undefined,
  ): Promise<CodexStartupDiscovery>;
  selectSandboxCodexModel(
    requested: string | undefined,
    available: ReadonlyArray<string>,
    context: { readonly threadId: string },
  ): string | null;
}

function freshSessionContext(
  session: ProviderSession,
  transport: JsonRpcLineTransport,
): CodexSessionContext {
  return {
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
}

export async function startSession(
  deps: CodexSessionOpenDeps,
  input: CodexAppServerStartSessionInput,
): Promise<ProviderSession> {
  const threadId = input.threadId;
  const now = new Date().toISOString();
  let context: CodexSessionContext | undefined;

  try {
    const existing = deps.sessions.get(threadId);
    if (existing) {
      deps.stopSession(threadId);
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
    deps.assertSupportedCodexCliVersion({
      binaryPath: codexBinaryPath,
      cwd: resolvedCwd,
      ...(codexHomePath ? { homePath: codexHomePath } : {}),
      hasSuppliedTransport: input.createTransport !== undefined,
    });
    let reusedPooledAppServer = false;
    let appServerProcessAgeMs = 0;
    const pooledContext =
      input.createTransport === undefined &&
      codexHomePath === undefined &&
      codexBinaryPath === "codex"
        ? deps.discoverySessions.get(resolvedCwd)
        : undefined;
    if (
      pooledContext &&
      !pooledContext.stopping &&
      pooledContext.pending.size === 0 &&
      pooledContext.pendingApprovals.size === 0 &&
      pooledContext.pendingUserInputs.size === 0 &&
      (await deps.isContextAlive(pooledContext))
    ) {
      const pooledStartedAtMs = Date.parse(pooledContext.session.createdAt);
      appServerProcessAgeMs = Number.isNaN(pooledStartedAtMs) ? 0 : Date.now() - pooledStartedAtMs;
      const idleTimer = deps.discoverySessionIdleTimers.get(resolvedCwd);
      if (idleTimer) {
        clearTimeout(idleTimer);
        deps.discoverySessionIdleTimers.delete(resolvedCwd);
      }
      deps.discoverySessions.delete(resolvedCwd);
      pooledContext.session = session;
      pooledContext.discovery = false;
      context = pooledContext;
      deps.sessions.set(threadId, context);
      reusedPooledAppServer = true;
    } else {
      const transport = await deps.createTransport(
        {
          binaryPath: codexBinaryPath,
          cwd: resolvedCwd,
          ...(codexHomePath ? { homePath: codexHomePath } : {}),
        },
        input.createTransport,
      );

      context = freshSessionContext(session, transport);

      deps.sessions.set(threadId, context);
      deps.attachProcessListeners(context);
    }

    deps.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

    const startupStartedAt = Date.now();
    if (!reusedPooledAppServer) {
      await deps.sendRequest(context, "initialize", buildCodexInitializeParams());
    }
    const initializeResolvedAt = Date.now();

    if (!reusedPooledAppServer) {
      deps.writeMessage(context, { method: "initialized" });
    }
    const discoveryCacheKey =
      input.createTransport === undefined ? `${codexBinaryPath}${codexHomePath ?? ""}` : undefined;
    const usedDiscoveryCache =
      discoveryCacheKey !== undefined && deps.localStartupDiscoveryCache.has(discoveryCacheKey);
    const discoveryStartedAt = Date.now();
    const discovery = await deps.resolveStartupDiscovery(context, discoveryCacheKey);
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
        ? deps.selectSandboxCodexModel(normalizedModel, advertisedModelSlugs, {
            threadId,
          })
        : (normalizedModel ?? null);
    const runtimeSessionOverrides = mapCodexRuntimeMode(input.runtimeMode ?? "full-access");
    const usesReviewProfile = input.reviewProfile === "review-chat";
    const effectiveApprovalPolicy =
      input.approvalPolicy ??
      (usesReviewProfile ? "never" : runtimeSessionOverrides.approvalPolicy);
    const effectiveSandboxMode =
      input.sandboxMode ?? (usesReviewProfile ? "read-only" : runtimeSessionOverrides.sandbox);
    const reviewSessionOptions = usesReviewProfile
      ? {
          ephemeral: true,
          serviceName: "synara_review_chat",
        }
      : {};
    const sessionOverrides = {
      model: effectiveModel,
      ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
      cwd: resolvedCwd,
      approvalPolicy: effectiveApprovalPolicy,
      sandbox: effectiveSandboxMode,
      ...reviewSessionOptions,
    };

    const threadStartParams = {
      ...sessionOverrides,
      experimentalRawEvents: false,
    };
    const resumeThreadId = readResumeThreadId(input);
    deps.emitLifecycleEvent(
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
      reviewProfile: input.reviewProfile ?? null,
      approvalPolicy: effectiveApprovalPolicy,
      sandboxMode: effectiveSandboxMode,
      ephemeral: usesReviewProfile,
    }).pipe(deps.runPromise);

    let threadOpenMethod: "thread/start" | "thread/resume" = "thread/start";
    let threadOpenResponse: unknown;
    if (resumeThreadId) {
      try {
        threadOpenMethod = "thread/resume";
        threadOpenResponse = await deps.sendRequest(context, "thread/resume", {
          ...sessionOverrides,
          threadId: resumeThreadId,
        });
      } catch (error) {
        if (!isRecoverableThreadResumeError(error)) {
          deps.emitErrorEvent(
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
          }).pipe(deps.runPromise);
          throw error;
        }

        threadOpenMethod = "thread/start";
        deps.emitLifecycleEvent(
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
        }).pipe(deps.runPromise);
        threadOpenResponse = await deps.sendRequest(context, "thread/start", threadStartParams);
      }
    } else {
      threadOpenMethod = "thread/start";
      threadOpenResponse = await deps.sendRequest(context, "thread/start", threadStartParams);
    }

    const threadOpenRecord = readObject(threadOpenResponse);
    const threadIdRaw =
      readString(readObject(threadOpenRecord, "thread"), "id") ??
      readString(threadOpenRecord, "threadId");
    if (!threadIdRaw) {
      throw new Error(`${threadOpenMethod} response did not include a thread id.`);
    }
    const providerThreadId = threadIdRaw;

    deps.updateSession(context, {
      status: "ready",
      resumeCursor: { threadId: providerThreadId },
    });
    deps.emitLifecycleEvent(
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
    }).pipe(deps.runPromise);
    deps.emitLifecycleEvent(context, "session/ready", `Connected to thread ${providerThreadId}`);
    await Effect.logInfo("codex app-server startup timings", {
      threadId,
      appServerProcessAgeMs,
      initializeMs: initializeResolvedAt - startupStartedAt,
      discoveryMs: discoveryResolvedAt - discoveryStartedAt,
      threadStartMs: threadOpenMethod === "thread/start" ? Date.now() - discoveryResolvedAt : null,
      threadResumeMs:
        threadOpenMethod === "thread/resume" ? Date.now() - discoveryResolvedAt : null,
      threadOpenMs: Date.now() - discoveryResolvedAt,
      totalMs: Date.now() - startupStartedAt,
      usedDiscoveryCache,
      reusedPooledAppServer,
      usedThreadStart: threadOpenMethod === "thread/start",
      usedThreadResume: threadOpenMethod === "thread/resume",
      threadWasAlreadyLoaded: null,
      ephemeral: usesReviewProfile,
      sandboxMode: effectiveSandboxMode,
      approvalPolicy: effectiveApprovalPolicy,
      model: effectiveModel ?? null,
      effort: input.effort ?? null,
      mcpServerCount: null,
      requiredMcpServerCount: null,
      pluginCount: null,
      skillCount: null,
    }).pipe(deps.runPromise);
    return { ...context.session };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start Codex session.";
    if (context) {
      deps.updateSession(context, {
        status: "error",
        lastError: message,
      });
      deps.emitErrorEvent(context, "session/startFailed", message);
      deps.stopSession(threadId);
    } else {
      deps.emitEvent({
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

export async function forkThread(
  deps: CodexSessionOpenDeps,
  input: ProviderForkThreadInput,
): Promise<ProviderForkThreadResult> {
  const threadId = input.threadId;
  const now = new Date().toISOString();
  let context: CodexSessionContext | undefined;

  try {
    const existing = deps.sessions.get(threadId);
    if (existing) {
      deps.stopSession(threadId);
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
    deps.assertSupportedCodexCliVersion({
      binaryPath: codexBinaryPath,
      cwd: resolvedCwd,
      ...(codexHomePath ? { homePath: codexHomePath } : {}),
    });
    const transport = await deps.createTransport({
      binaryPath: codexBinaryPath,
      cwd: resolvedCwd,
      ...(codexHomePath ? { homePath: codexHomePath } : {}),
    });

    context = freshSessionContext(session, transport);

    deps.sessions.set(threadId, context);
    deps.attachProcessListeners(context);
    deps.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

    await deps.sendRequest(context, "initialize", buildCodexInitializeParams());
    deps.writeMessage(context, { method: "initialized" });
    try {
      const accountReadResponse = await deps.sendRequest(context, "account/read", {});
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

    deps.emitLifecycleEvent(
      context,
      "session/threadOpenRequested",
      `Forking Codex thread ${sourceProviderThreadId}.`,
    );
    const response = await deps.sendRequest(context, "thread/fork", forkParams);
    const forkedProviderThreadId = readThreadIdFromResponse("thread/fork", response);

    deps.updateSession(context, {
      status: "ready",
      resumeCursor: { threadId: forkedProviderThreadId },
    });
    deps.emitLifecycleEvent(context, "session/threadOpenResolved", "Codex thread/fork resolved.");
    deps.emitLifecycleEvent(
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
      deps.updateSession(context, {
        status: "error",
        lastError: message,
      });
      deps.emitErrorEvent(context, "session/threadForkFailed", message);
      deps.stopSession(threadId);
    }
    throw new Error(message, { cause: error });
  }
}
