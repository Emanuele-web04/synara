// Purpose: Lifecycle for the repo-scoped Codex discovery sessions — context
//   resolution (prefer a live thread/cwd session, else a dedicated discovery
//   session), idle-timer scheduling, teardown, and the voice-transcription auth
//   probe. Extracted from CodexAppServerManager so the class stays a shell over
//   the discovery-session maps it owns.
// Layer: Free functions over a CodexDiscoverySessionDeps surface holding the
//   session maps plus the transport/request collaborators. Depends on the pure
//   parsers/protocol/session modules and the config idle constant.
// Exports: CodexDiscoverySessionDeps, resolveContextForDiscovery,
//   resolveVoiceTranscriptionAuth, getOrCreateDiscoverySession,
//   scheduleDiscoverySessionIdleStop, stopDiscoverySession.
import { ThreadId, type ProviderSession } from "@t3tools/contracts";

import { CODEX_DEFAULT_MODEL, CODEX_DISCOVERY_SESSION_IDLE_MS } from "./codexAppServer.config.ts";
import { readString } from "./codexAppServer.parsers.ts";
import { readCodexAccountSnapshot } from "./codexAppServer.protocol.ts";
import { buildCodexInitializeParams } from "./codexAppServer.session.ts";
import type {
  CodexSessionContext,
  CodexTransportFactoryInput,
  CodexVoiceTranscriptionAuthContext,
} from "./codexAppServer.types.ts";
import type { JsonRpcLineTransport } from "./provider/process/JsonRpcLineTransport.ts";

export interface CodexDiscoverySessionDeps {
  readonly sessions: Map<ThreadId, CodexSessionContext>;
  readonly discoverySessions: Map<string, CodexSessionContext>;
  readonly discoverySessionIdleTimers: Map<string, ReturnType<typeof setTimeout>>;
  requireSession(threadId: ThreadId): CodexSessionContext;
  isContextAlive(context: CodexSessionContext): Promise<boolean>;
  assertSupportedCodexCliVersion(input: {
    readonly binaryPath: string;
    readonly cwd: string;
  }): void;
  createTransport(input: CodexTransportFactoryInput): Promise<JsonRpcLineTransport>;
  attachProcessListeners(context: CodexSessionContext): void;
  sendRequest<TResponse>(
    context: CodexSessionContext,
    method: string,
    params: unknown,
  ): Promise<TResponse>;
  writeMessage(context: CodexSessionContext, message: unknown): void;
  updateSession(context: CodexSessionContext, updates: Partial<ProviderSession>): void;
  registerSynaraSkillsRoot(context: CodexSessionContext): Promise<void>;
  closeTransport(context: CodexSessionContext): void;
  // Re-entrant collaborators routed through the manager's instance seams so the
  // protocol tests' instance-level spies stay in the call path.
  getOrCreateDiscoverySession(cwd: string): Promise<CodexSessionContext>;
  scheduleDiscoverySessionIdleStop(discoveryKey: string): void;
  stopDiscoverySession(discoveryKey: string): void;
}

export async function resolveContextForDiscovery(
  deps: CodexDiscoverySessionDeps,
  threadId?: string,
  cwd?: string,
): Promise<CodexSessionContext> {
  const normalizedThreadId = threadId?.trim();
  const normalizedCwd = cwd?.trim() || undefined;
  if (normalizedThreadId) {
    try {
      const session = deps.requireSession(ThreadId.makeUnsafe(normalizedThreadId));
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
    for (const activeSession of deps.sessions.values()) {
      if (
        !activeSession.stopping &&
        activeSession.session.cwd === normalizedCwd &&
        (await deps.isContextAlive(activeSession))
      ) {
        return activeSession;
      }
    }
    return deps.getOrCreateDiscoverySession(normalizedCwd);
  }
  const firstActive = deps.sessions.values().next().value;
  if (firstActive) {
    return firstActive;
  }
  return deps.getOrCreateDiscoverySession(process.cwd());
}

export async function resolveVoiceTranscriptionAuth(
  deps: CodexDiscoverySessionDeps,
  input: {
    readonly cwd?: string;
    readonly threadId?: string;
    readonly refreshToken: boolean;
  },
): Promise<CodexVoiceTranscriptionAuthContext> {
  // Voice transcription should always resolve auth from a fresh discovery context
  // instead of reusing a possibly stale thread-bound session token.
  const context = await deps.getOrCreateDiscoverySession(input.cwd?.trim() || process.cwd());
  const readAuthStatus = async (refreshToken: boolean) => {
    const response = await deps.sendRequest<Record<string, unknown>>(context, "getAuthStatus", {
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

export async function getOrCreateDiscoverySession(
  deps: CodexDiscoverySessionDeps,
  cwd: string,
): Promise<CodexSessionContext> {
  const normalizedCwd = cwd.trim() || process.cwd();
  const existing = deps.discoverySessions.get(normalizedCwd);
  if (existing && !existing.stopping && (await deps.isContextAlive(existing))) {
    deps.scheduleDiscoverySessionIdleStop(normalizedCwd);
    return existing;
  }

  const now = new Date().toISOString();
  deps.assertSupportedCodexCliVersion({
    binaryPath: "codex",
    cwd: normalizedCwd,
  });
  const transport = await deps.createTransport({
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
      sparkEnabled: false,
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

  deps.discoverySessions.set(normalizedCwd, context);
  deps.attachProcessListeners(context);
  try {
    await deps.sendRequest(context, "initialize", buildCodexInitializeParams());
    deps.writeMessage(context, { method: "initialized" });
    await deps.registerSynaraSkillsRoot(context);
    try {
      const accountReadResponse = await deps.sendRequest(context, "account/read", {});
      context.account = readCodexAccountSnapshot(accountReadResponse);
    } catch {
      // Discovery can still function without account metadata.
    }
    deps.updateSession(context, { status: "ready" });
    deps.scheduleDiscoverySessionIdleStop(normalizedCwd);
    return context;
  } catch (error) {
    deps.stopDiscoverySession(normalizedCwd);
    throw error;
  }
}

export function scheduleDiscoverySessionIdleStop(
  deps: CodexDiscoverySessionDeps,
  discoveryKey: string,
): void {
  const existingTimer = deps.discoverySessionIdleTimers.get(discoveryKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    const context = deps.discoverySessions.get(discoveryKey);
    if (!context || context.stopping) {
      deps.discoverySessionIdleTimers.delete(discoveryKey);
      return;
    }
    if (
      context.pending.size > 0 ||
      context.pendingApprovals.size > 0 ||
      context.pendingUserInputs.size > 0
    ) {
      deps.scheduleDiscoverySessionIdleStop(discoveryKey);
      return;
    }

    deps.stopDiscoverySession(discoveryKey);
  }, CODEX_DISCOVERY_SESSION_IDLE_MS);
  timer.unref();
  deps.discoverySessionIdleTimers.set(discoveryKey, timer);
}

export function stopDiscoverySession(deps: CodexDiscoverySessionDeps, discoveryKey: string): void {
  const idleTimer = deps.discoverySessionIdleTimers.get(discoveryKey);
  if (idleTimer) {
    clearTimeout(idleTimer);
    deps.discoverySessionIdleTimers.delete(discoveryKey);
  }

  const context = deps.discoverySessions.get(discoveryKey);
  if (!context) {
    return;
  }

  context.stopping = true;
  for (const pending of context.pending.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("Discovery session stopped before request completed."));
  }
  context.pending.clear();
  deps.closeTransport(context);

  deps.discoverySessions.delete(discoveryKey);
}
