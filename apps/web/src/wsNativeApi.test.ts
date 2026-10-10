// FILE: wsNativeApi.test.ts
// Purpose: Verifies the WebSocket-backed NativeApi adapter and push listener fanout.
// Layer: Web transport tests
// Depends on: wsTransport mock plus contracts channel constants.

import {
  ApprovalRequestId,
  CommandId,
  type ContextMenuItem,
  EventId,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationEvent,
  ProjectId,
  ThreadId,
  type WsPushChannel,
  type WsPushData,
  type WsPushMessage,
  WS_CHANNELS,
  WS_METHODS,
  type WsPush,
  type ServerProviderStatus,
} from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let reportShellFailure: ((failure: { code: string | null; error: Error }) => void) | undefined;
const requestMock = vi.fn<(...args: Array<unknown>) => Promise<unknown>>();
const disposeMock = vi.fn();
const unsubscribeProjectAgentEventsMock = vi.fn(async (_projectId: string) => undefined);
const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();
const channelListeners = new Map<string, Set<(message: WsPush) => void>>();
const latestPushByChannel = new Map<string, WsPush>();
const subscribeMock = vi.fn<
  (
    channel: string,
    listener: (message: WsPush) => void,
    options?: { replayLatest?: boolean },
  ) => () => void
>((channel, listener, options) => {
  const listeners = channelListeners.get(channel) ?? new Set<(message: WsPush) => void>();
  listeners.add(listener);
  channelListeners.set(channel, listeners);
  const latest = latestPushByChannel.get(channel);
  if (latest && options?.replayLatest) {
    listener(latest);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      channelListeners.delete(channel);
    }
  };
});

vi.mock("./wsTransport", () => {
  return {
    WsTransport: class MockWsTransport {
      request = requestMock;
      subscribe = subscribeMock;
      unsubscribeProjectAgentEvents = unsubscribeProjectAgentEventsMock;
      onStateChange() {
        return () => undefined;
      }
      onCompatibilityIssue() {
        return () => undefined;
      }
      onShellStreamFailure(listener: (failure: { code: string | null; error: Error }) => void) {
        reportShellFailure = listener;
        return () => {
          reportShellFailure = undefined;
        };
      }
      onThreadStreamFailure() {
        return () => undefined;
      }
      getLatestPush(channel: string) {
        return latestPushByChannel.get(channel) ?? null;
      }
      getState() {
        return "open" as const;
      }
      dispose = disposeMock;
    },
  };
});

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

const withNativeMenuIconsMock = vi.fn(
  async <T extends string>(items: readonly ContextMenuItem<T>[]) =>
    items.map((item) =>
      item.icon ? { ...item, iconDataUrl: `data:image/png;base64,${item.icon}` } : item,
    ),
);

vi.mock("./lib/nativeMenuIcons", () => ({
  withNativeMenuIcons: withNativeMenuIconsMock,
}));

let nextPushSequence = 1;

function emitPush<C extends WsPushChannel>(channel: C, data: WsPushData<C>): void {
  const listeners = channelListeners.get(channel);
  const message = {
    type: "push" as const,
    sequence: nextPushSequence++,
    channel,
    data,
  } as WsPushMessage<C>;
  latestPushByChannel.set(channel, message);
  if (!listeners) return;
  for (const listener of listeners) {
    listener(message);
  }
}

function getWindowForTest(): Window & typeof globalThis & { desktopBridge?: unknown } {
  const testGlobal = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis & { desktopBridge?: unknown };
  };
  if (!testGlobal.window) {
    testGlobal.window = {} as Window & typeof globalThis & { desktopBridge?: unknown };
  }
  return testGlobal.window;
}

const defaultProviders: ReadonlyArray<ServerProviderStatus> = [
  {
    provider: "codex",
    instanceId: "codex",
    driver: "codex",
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-01-01T00:00:00.000Z",
  },
];

beforeEach(() => {
  vi.resetModules();
  requestMock.mockReset();
  disposeMock.mockReset();
  unsubscribeProjectAgentEventsMock.mockClear();
  showContextMenuFallbackMock.mockReset();
  withNativeMenuIconsMock.mockClear();
  subscribeMock.mockClear();
  channelListeners.clear();
  latestPushByChannel.clear();
  nextPushSequence = 1;
  Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("wsNativeApi", () => {
  it("forwards exhausted shell failures and removes unsubscribed listeners", async () => {
    const { createWsNativeApi, onShellStreamFailure } = await import("./wsNativeApi");
    createWsNativeApi();
    const listener = vi.fn();
    const unsubscribe = onShellStreamFailure(listener);
    const failure = {
      code: "ORCHESTRATION_STREAM_OVERFLOW",
      error: new Error("overflow exhausted"),
    };
    expect(reportShellFailure).toBeDefined();
    reportShellFailure!(failure);
    expect(listener).toHaveBeenCalledWith(failure);
    unsubscribe();
    reportShellFailure!(failure);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("gives a slow provider refresh a bounded deadline beyond the generic RPC timeout", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    requestMock.mockResolvedValue({ providers: defaultProviders });

    await expect(api.server.refreshProviders()).resolves.toEqual({
      providers: defaultProviders,
    });
    expect(requestMock).toHaveBeenCalledExactlyOnceWith(
      WS_METHODS.serverRefreshProviders,
      undefined,
      { timeoutMs: 180_000 },
    );
  });

  it("delivers and caches valid server.welcome payloads", async () => {
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    const payload = { cwd: "/tmp/workspace", homeDir: "/Users/tester", projectName: "synara-code" };
    emitPush(WS_CHANNELS.serverWelcome, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining(payload));

    const lateListener = vi.fn();
    onServerWelcome(lateListener);

    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(expect.objectContaining(payload));
  });

  it("delivers successive server.welcome payloads to active listeners", async () => {
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    emitPush(WS_CHANNELS.serverWelcome, {
      cwd: "/tmp/one",
      homeDir: "/Users/tester",
      projectName: "one",
    });
    emitPush(WS_CHANNELS.serverWelcome, {
      cwd: "/tmp/workspace",
      homeDir: "/Users/tester",
      projectName: "synara-code",
    });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cwd: "/tmp/workspace",
        homeDir: "/Users/tester",
        projectName: "synara-code",
      }),
    );
  });

  it("delivers and caches valid server.configUpdated payloads", async () => {
    const { createWsNativeApi, onServerConfigUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerConfigUpdated(listener);

    const payload = {
      issues: [
        {
          kind: "keybindings.invalid-entry",
          index: 1,
          message: "Entry at index 1 is invalid.",
        },
      ],
      providers: defaultProviders,
    } as const;
    emitPush(WS_CHANNELS.serverConfigUpdated, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(payload);

    const lateListener = vi.fn();
    onServerConfigUpdated(lateListener);
    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(payload);
  });

  it("delivers and caches provider-only status updates", async () => {
    const { createWsNativeApi, onServerProviderStatusesUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerProviderStatusesUpdated(listener);

    const payload = {
      providers: defaultProviders,
    } as const;
    emitPush(WS_CHANNELS.serverProviderStatusesUpdated, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(payload);

    const lateListener = vi.fn();
    onServerProviderStatusesUpdated(lateListener);
    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(payload);
  });

  it("delivers and caches server settings updates", async () => {
    const { createWsNativeApi, onServerSettingsUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerSettingsUpdated(listener);

    const payload = {
      settings: {
        enableAssistantStreaming: true,
        enableProviderUpdateChecks: true,
        keepAwakeMode: "off",
        lowerProviderProcessPriority: true,
        defaultThreadEnvMode: "local",
        addProjectBaseDirectory: "",
        githubInboxIncludeUpstreams: false,
        sidechatExpiry: "1h",
        threadAutoArchive: "7d",
        confirmClaudeCacheResume: true,
        sourceControlWritingStyle: "repository",
        sourceControlCustomInstructions: "",
        textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
        providers: {
          codex: {
            enabled: true,
            binaryPath: "codex",
            homePath: "",
            selectedAccountId: "default",
            accounts: [],
            customModels: [],
          },
          claudeAgent: {
            enabled: true,
            binaryPath: "claude",
            homePath: "",
            launchArgs: "",
            enableArtifacts: false,
            customModels: [],
          },
          cursor: { enabled: false, binaryPath: "agent", apiEndpoint: "", customModels: [] },
          devin: { enabled: true, binaryPath: "devin", customModels: [] },
          antigravity: { enabled: true, binaryPath: "agy", customModels: [] },
          grok: { enabled: true, binaryPath: "grok", customModels: [] },
          droid: { enabled: true, binaryPath: "droid", customModels: [] },
          opencode: {
            enabled: true,
            binaryPath: "opencode",
            serverUrl: "",
            serverPasswordConfigured: false,
            experimentalWebSockets: false,
            customModels: [],
          },
          pi: { enabled: true, binaryPath: "pi", agentDir: "", customModels: [] },
          omp: { enabled: true, binaryPath: "omp", agentDir: "", customModels: [] },
        },
        providerInstances: {},
        skills: { disabled: [] },
      },
    } as const;
    emitPush(WS_CHANNELS.serverSettingsUpdated, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(payload);

    const lateListener = vi.fn();
    onServerSettingsUpdated(lateListener);
    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(payload);
  });

  it("delivers and caches keep-awake updates", async () => {
    const { createWsNativeApi, onServerKeepAwakeUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerKeepAwakeUpdated(listener);

    const payload = {
      keepAwake: { available: true, mode: "agent", active: true, error: null },
    } as const;
    emitPush(WS_CHANNELS.serverKeepAwakeUpdated, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(payload);

    const lateListener = vi.fn();
    onServerKeepAwakeUpdated(lateListener);
    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(payload);
  });

  it("forwards valid terminal and orchestration events", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const onTerminalEvent = vi.fn();
    const onDomainEvent = vi.fn();
    const onActionProgress = vi.fn();
    const onWorktreeSetupProgress = vi.fn();

    api.terminal.onEvent(onTerminalEvent);
    expect(channelListeners.has(ORCHESTRATION_WS_CHANNELS.domainEvent)).toBe(false);
    const unsubscribeDomainEvent = api.orchestration.onDomainEvent(onDomainEvent);
    expect(channelListeners.get(ORCHESTRATION_WS_CHANNELS.domainEvent)?.size).toBe(1);
    api.git.onActionProgress(onActionProgress);
    api.git.onWorktreeSetupProgress(onWorktreeSetupProgress);

    const terminalEvent = {
      threadId: "thread-1",
      terminalId: "terminal-1",
      createdAt: "2026-02-24T00:00:00.000Z",
      type: "output",
      data: "hello",
    } as const;
    emitPush(WS_CHANNELS.terminalEvent, terminalEvent);

    const orchestrationEvent = {
      sequence: 1,
      eventId: EventId.makeUnsafe("event-1"),
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-1"),
      occurredAt: "2026-02-24T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: ProjectId.makeUnsafe("project-1"),
        kind: "project",
        title: "Project",
        workspaceRoot: "/tmp/workspace",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-02-24T00:00:00.000Z",
        updatedAt: "2026-02-24T00:00:00.000Z",
      },
    } satisfies Extract<OrchestrationEvent, { type: "project.created" }>;
    emitPush(ORCHESTRATION_WS_CHANNELS.domainEvent, orchestrationEvent);
    emitPush(WS_CHANNELS.gitActionProgress, {
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      kind: "phase_started",
      phase: "commit",
      label: "Committing...",
    });
    emitPush(WS_CHANNELS.gitWorktreeSetupProgress, {
      progressId: "progress-1",
      kind: "phase_started",
      phase: "worktree",
    });

    expect(onTerminalEvent).toHaveBeenCalledTimes(1);
    expect(onTerminalEvent).toHaveBeenCalledWith(terminalEvent);
    expect(onDomainEvent).toHaveBeenCalledTimes(1);
    expect(onDomainEvent).toHaveBeenCalledWith(orchestrationEvent);
    unsubscribeDomainEvent();
    expect(channelListeners.has(ORCHESTRATION_WS_CHANNELS.domainEvent)).toBe(false);
    expect(onActionProgress).toHaveBeenCalledTimes(1);
    expect(onActionProgress).toHaveBeenCalledWith({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      kind: "phase_started",
      phase: "commit",
      label: "Committing...",
    });
    expect(onWorktreeSetupProgress).toHaveBeenCalledTimes(1);
    expect(onWorktreeSetupProgress).toHaveBeenCalledWith({
      progressId: "progress-1",
      kind: "phase_started",
      phase: "worktree",
    });
  });

  it("ref-counts project-agent subscriptions so an earlier unmount keeps the stream", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    requestMock.mockResolvedValue(undefined);
    const projectId = ProjectId.makeUnsafe("project-1");

    await api.projectAgent.subscribe({ projectId });
    await api.projectAgent.subscribe({ projectId });
    expect(requestMock).toHaveBeenCalledExactlyOnceWith(WS_METHODS.subscribeProjectAgentEvents, {
      projectId,
    });

    // The dialog's cleanup fires while the panel still holds a subscription —
    // the transport stream must stay up.
    await api.projectAgent.unsubscribe({ projectId });
    expect(unsubscribeProjectAgentEventsMock).not.toHaveBeenCalled();

    await api.projectAgent.unsubscribe({ projectId });
    expect(unsubscribeProjectAgentEventsMock).toHaveBeenCalledExactlyOnceWith(projectId);
  });

  it("re-subscribes the project-agent stream after the last unsubscribe", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    requestMock.mockResolvedValue(undefined);
    const projectId = ProjectId.makeUnsafe("project-1");

    await api.projectAgent.subscribe({ projectId });
    await api.projectAgent.unsubscribe({ projectId });
    await api.projectAgent.subscribe({ projectId });

    expect(
      requestMock.mock.calls.filter(
        ([method]) => method === WS_METHODS.subscribeProjectAgentEvents,
      ),
    ).toHaveLength(2);
    expect(unsubscribeProjectAgentEventsMock).toHaveBeenCalledExactlyOnceWith(projectId);
  });

  it("wraps orchestration dispatch commands in the command envelope", async () => {
    requestMock.mockResolvedValue(undefined);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const command = {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      kind: "project",
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      createdAt: "2026-02-24T00:00:00.000Z",
    } as const;
    await api.orchestration.dispatchCommand(command);

    expect(requestMock).toHaveBeenCalledWith(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      command,
    });
  });

  it("runs thread-title regeneration without a client timeout", async () => {
    requestMock.mockResolvedValue({ status: "renamed", title: "Backend auth" });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.orchestration.regenerateThreadTitle({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });

    expect(requestMock).toHaveBeenCalledWith(
      ORCHESTRATION_WS_METHODS.regenerateThreadTitle,
      { threadId: "thread-1" },
      { timeoutMs: null },
    );
  });

  it("omits null user-input answers before dispatching to orchestration", async () => {
    requestMock.mockResolvedValue(undefined);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    const command = {
      type: "thread.user-input.respond",
      commandId: CommandId.makeUnsafe("cmd-user-input-null"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      requestId: ApprovalRequestId.makeUnsafe("request-1"),
      answers: {
        Language: null,
        Runtime: "Bun",
      },
      createdAt: "2026-02-24T00:00:00.000Z",
    } as const;
    await api.orchestration.dispatchCommand(command);

    expect(requestMock).toHaveBeenCalledWith(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      command: {
        ...command,
        answers: {
          Runtime: "Bun",
        },
      },
    });
  });

  it("forwards an abort signal on projects.readFile to the transport", async () => {
    requestMock.mockResolvedValue({
      relativePath: "src/app.ts",
      contents: "export {};\n",
      truncated: false,
      version: `sha256:${"1".repeat(64)}`,
      encoding: "utf8",
      lineEnding: "lf",
    });
    const { createWsNativeApi } = await import("./wsNativeApi");
    const controller = new AbortController();
    const api = createWsNativeApi();

    await api.projects.readFile(
      {
        cwd: "/tmp/project",
        relativePath: "src/app.ts",
      },
      { signal: controller.signal },
    );

    expect(requestMock).toHaveBeenCalledWith(
      WS_METHODS.projectsReadFile,
      {
        cwd: "/tmp/project",
        relativePath: "src/app.ts",
      },
      { signal: controller.signal },
    );
  });

  it("uses websocket RPC for external MCP management in packaged and browser builds", async () => {
    requestMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ integration: { integrationId: "integration-1" } })
      .mockResolvedValueOnce({ revoked: true })
      .mockResolvedValueOnce({ integration: { integrationId: "integration-1" } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const createInput = {
      name: "Desktop MCP",
      capabilities: ["projects:read", "tasks:create", "tasks:read"] as const,
      projectIds: [ProjectId.makeUnsafe("project-1")],
    };

    await api.server.listExternalMcpIntegrations();
    await api.server.createExternalMcpIntegration(createInput);
    await api.server.revokeExternalMcpIntegration({ integrationId: "integration-1" });
    await api.server.refreshExternalMcpPairing({ integrationId: "integration-1" });

    expect(requestMock).toHaveBeenNthCalledWith(1, WS_METHODS.serverListExternalMcpIntegrations);
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      WS_METHODS.serverCreateExternalMcpIntegration,
      createInput,
    );
    expect(requestMock).toHaveBeenNthCalledWith(3, WS_METHODS.serverRevokeExternalMcpIntegration, {
      integrationId: "integration-1",
    });
    expect(requestMock).toHaveBeenNthCalledWith(4, WS_METHODS.serverRefreshExternalMcpPairing, {
      integrationId: "integration-1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches auth session state over HTTP", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticated: false,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie", "bearer-session-token"],
            sessionCookieName: "synara_session",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const result = await api.server.getAuthSession();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );
    expect(result).toMatchObject({ authenticated: false });
  });

  it("posts auth bootstrap payloads over HTTP", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticated: true,
          role: "client",
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-01-01T00:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const result = await api.server.bootstrapAuth({ credential: "PAIRINGTOKEN" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/bootstrap",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ credential: "PAIRINGTOKEN" }),
      }),
    );
    expect(result).toMatchObject({ authenticated: true, sessionMethod: "browser-session-cookie" });
  });

  it("logs out over HTTP and disposes the authenticated websocket transport", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ revoked: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await expect(api.server.logoutAuthSession()).resolves.toEqual({ revoked: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
      }),
    );
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("uses no client timeout for git.runStackedAction", async () => {
    requestMock.mockResolvedValue({
      action: "commit",
      branch: { status: "skipped_not_requested" },
      commit: { status: "created", commitSha: "abc1234", subject: "Test" },
      push: { status: "skipped_not_requested" },
      pr: { status: "skipped_not_requested" },
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.git.runStackedAction({ actionId: "action-1", cwd: "/repo", action: "commit" });

    expect(requestMock).toHaveBeenCalledWith(
      WS_METHODS.gitRunStackedAction,
      { actionId: "action-1", cwd: "/repo", action: "commit" },
      { timeoutMs: null },
    );
  });

  it("forwards cancellable GitHub project provisioning and its progress events", async () => {
    const input = {
      operationId: "operation-1",
      repository: "openai/codex",
      destinationParent: "/projects",
      directoryName: "codex",
      commandId: CommandId.makeUnsafe("command-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      newProjectSpaceId: null,
      defaultModelSelection: { provider: "codex" as const, model: "gpt-5" },
      createdAt: "2026-08-04T00:00:00.000Z",
    };
    const result = {
      operationId: input.operationId,
      repository: input.repository,
      workspaceRoot: "/projects/codex",
      projectId: input.projectId,
      checkout: "created" as const,
    };
    requestMock.mockResolvedValue(result);
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const progressListener = vi.fn();
    api.projects.onProvisionProgress(progressListener);
    const controller = new AbortController();

    await expect(
      api.projects.provisionFromGitHub(input, { signal: controller.signal }),
    ).resolves.toEqual(result);
    emitPush(WS_CHANNELS.projectProvisionProgress, {
      operationId: input.operationId,
      kind: "phase",
      phase: "cloning",
      message: "Cloning openai/codex",
    });

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.projectsProvisionFromGitHub, input, {
      timeoutMs: null,
      signal: controller.signal,
    });
    expect(progressListener).toHaveBeenCalledWith({
      operationId: input.operationId,
      kind: "phase",
      phase: "cloning",
      message: "Cloning openai/codex",
    });
  });

  it("scopes orchestration replay requests to the visible thread when provided", async () => {
    requestMock.mockResolvedValue([]);
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    await api.orchestration.replayEvents(41, ThreadId.makeUnsafe("thread-1"));

    expect(requestMock).toHaveBeenCalledWith(ORCHESTRATION_WS_METHODS.replayEvents, {
      fromSequenceExclusive: 41,
      threadId: "thread-1",
    });
  });

  it("keeps a blank fallback browser tab after closing the last tab", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const opened = await api.browser.open({ threadId });
    const tabId = opened.activeTabId;

    expect(tabId).toBeTruthy();
    const nextState = await api.browser.closeTab({ threadId, tabId: tabId ?? "" });

    expect(nextState.open).toBe(true);
    expect(nextState.tabs).toHaveLength(1);
    expect(nextState.activeTabId).toBe(nextState.tabs[0]?.id);
    expect(nextState.tabs[0]?.url).toBe("about:blank");
  });

  it("forwards context menu metadata to desktop bridge", async () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: {
        showContextMenu,
      },
    });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    await api.contextMenu.show(
      [
        { id: "rename", label: "Rename thread" },
        { id: "delete", label: "Delete", separatorBefore: true, destructive: true },
      ],
      { x: 200, y: 300 },
    );

    expect(api.browser.vault).toBeUndefined();

    expect(showContextMenu).toHaveBeenCalledWith(
      [
        { id: "rename", label: "Rename thread" },
        { id: "delete", label: "Delete", separatorBefore: true, destructive: true },
      ],
      { x: 200, y: 300 },
    );
    expect(withNativeMenuIconsMock).not.toHaveBeenCalled();
  });

  it("rasterizes context menu icons for the macOS desktop bridge", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const showContextMenu = vi.fn().mockResolvedValue("rename");
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: {
        showContextMenu,
      },
    });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    await api.contextMenu.show(
      [
        { id: "rename", label: "Rename thread", icon: "pencil" },
        { id: "copy-thread-id", label: "Copy Thread ID" },
      ],
      { x: 200, y: 300 },
    );

    expect(showContextMenu).toHaveBeenCalledWith(
      [
        {
          id: "rename",
          label: "Rename thread",
          icon: "pencil",
          iconDataUrl: "data:image/png;base64,pencil",
        },
        { id: "copy-thread-id", label: "Copy Thread ID" },
      ],
      { x: 200, y: 300 },
    );
  });

  it("uses fallback context menu when desktop bridge is unavailable", async () => {
    showContextMenuFallbackMock.mockResolvedValue("delete");
    Reflect.deleteProperty(getWindowForTest(), "desktopBridge");

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    await api.contextMenu.show([{ id: "delete", label: "Delete", destructive: true }], {
      x: 20,
      y: 30,
    });

    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(
      [{ id: "delete", label: "Delete", destructive: true }],
      { x: 20, y: 30 },
    );
  });

  it("uses the bounded server upload even when the desktop bridge is available", async () => {
    const transcribeVoice = vi.fn().mockResolvedValue({ text: "hello" });
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: {
        getWsUrl: () => "ws://127.0.0.1:3773/ws?token=desktop-secret",
        server: {
          transcribeVoice,
        },
      },
    });

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ text: "hello" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    await api.server.transcribeVoice({
      provider: "codex",
      cwd: "/repo",
      audioBase64: "UklGRgAAAAAAAAAAAAAAAAAAAAA=",
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1000,
    });

    expect(transcribeVoice).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/voice/transcribe?"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(requestMock).not.toHaveBeenCalledWith(
      WS_METHODS.serverTranscribeVoice,
      expect.anything(),
    );
  });

  it("uses the bounded HTTP upload instead of WebSocket RPC for browser voice", async () => {
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: { getWsUrl: () => "ws://127.0.0.1:3773/ws?token=desktop-secret" },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ text: "hello" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const result = await api.server.transcribeVoice({
      provider: "codex",
      providerInstanceId: "codex_work",
      cwd: "/repo",
      audioBase64: "AQID",
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1000,
    });

    expect(result).toEqual({ text: "hello" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/voice/transcribe?"),
      expect.objectContaining({ method: "POST", body: Uint8Array.from([1, 2, 3]) }),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("providerInstanceId=codex_work");
    expect(requestMock).not.toHaveBeenCalledWith(
      WS_METHODS.serverTranscribeVoice,
      expect.anything(),
    );
  });

  it.each([
    { body: '"unexpected response"', status: 200 },
    { body: "true", status: 200 },
    { body: "null", status: 200 },
    { body: "[]", status: 200 },
    { body: '{"text":null}', status: 200 },
    { body: '{"text":42}', status: 200 },
    { body: '{"text":""}', status: 200 },
    { body: '{"text":"   "}', status: 200 },
    { body: "<html>Service unavailable</html>", status: 200 },
    { body: '"unexpected response"', status: 502 },
    { body: '{"error":"Upload rejected"}', status: 403 },
  ])("rejects invalid voice responses: $status $body", async ({ body, status }) => {
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: { getWsUrl: () => "ws://127.0.0.1:3773/ws?token=desktop-secret" },
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status })));
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    await expect(
      api.server.transcribeVoice({
        provider: "codex",
        cwd: "/repo",
        audioBase64: "AQID",
        mimeType: "audio/wav",
        sampleRateHz: 24_000,
        durationMs: 1000,
      }),
    ).rejects.toThrow(
      status === 403
        ? "Upload rejected"
        : status >= 400
          ? `Voice transcription failed with status ${status}.`
          : "The voice transcription service returned an invalid response. Please try again.",
    );
    expect(requestMock).not.toHaveBeenCalledWith(
      WS_METHODS.serverTranscribeVoice,
      expect.anything(),
      expect.anything(),
    );
  });

  it.each([
    { status: 404, stalledBody: false },
    { status: 404, stalledBody: true },
    { status: 405, stalledBody: true },
  ])(
    "falls back to WebSocket voice RPC for $status with stalled body: $stalledBody",
    async ({ status, stalledBody }) => {
      Object.defineProperty(getWindowForTest(), "desktopBridge", {
        configurable: true,
        writable: true,
        value: { getWsUrl: () => "ws://127.0.0.1:3773/ws?token=desktop-secret" },
      });
      let finishBody: (() => void) | undefined;
      const body = stalledBody
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              finishBody = () => controller.close();
            },
            cancel() {
              finishBody = undefined;
            },
          })
        : "Not Found";
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
      vi.stubGlobal("fetch", fetchMock);
      requestMock.mockResolvedValueOnce({ text: "legacy transport" });

      const { createWsNativeApi } = await import("./wsNativeApi");
      const api = createWsNativeApi();
      const input = {
        provider: "codex" as const,
        cwd: "/repo",
        audioBase64: "AQID",
        mimeType: "audio/wav",
        sampleRateHz: 24_000,
        durationMs: 1000,
      };

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          api.server.transcribeVoice(input),
          new Promise<string>((resolve) => {
            timeout = setTimeout(() => resolve("still waiting for an irrelevant error body"), 100);
          }),
        ]);
        expect(result).toEqual({ text: "legacy transport" });
        expect(requestMock).toHaveBeenCalledWith(WS_METHODS.serverTranscribeVoice, input, {
          timeoutMs: null,
        });
      } finally {
        clearTimeout(timeout);
        finishBody?.();
      }
    },
  );
});
