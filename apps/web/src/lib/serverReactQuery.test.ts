// FILE: serverReactQuery.test.ts
// Purpose: Locks down server React Query polling profiles and cache options.
// Layer: Web data-fetching unit tests

import type {
  ServerConfig,
  ServerListProviderUsageInput,
  ServerProviderStatus,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  hasReconciledServerProviderStatuses,
  invalidateProviderUsageQueries,
  LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS,
  reconcileServerProviderStatuses,
  refreshServerConfigAfterTransportOpen,
  serverAllProviderUsageQueryOptions,
  serverConfigQueryOptions,
  serverProviderUsageSnapshotQueryOptions,
  serverQueryKeys,
  serverRecapQueryOptions,
  serverSettingsQueryOptions,
  sidebarLocalServersQueryOptions,
} from "./serverReactQuery";

const nativeApiMocks = vi.hoisted(() => ({
  getConfig: vi.fn<() => Promise<ServerConfig>>(),
  getSettings: vi.fn<() => Promise<unknown>>(),
  getRecap: vi.fn(),
  listProviderUsage: vi.fn(),
  ensureNativeApiCalls: { count: 0 },
}));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => {
    nativeApiMocks.ensureNativeApiCalls.count += 1;
    return {
      server: {
        getConfig: nativeApiMocks.getConfig,
        getSettings: nativeApiMocks.getSettings,
        listProviderUsage: nativeApiMocks.listProviderUsage,
      },
      stats: { getRecap: nativeApiMocks.getRecap },
    };
  },
}));
const streamSnapshotMocks = vi.hoisted(() => ({
  readLatestServerConfigSnapshot: vi.fn<() => ServerConfig | null>(),
  waitForInitialServerConfigSnapshot: vi.fn<() => Promise<ServerConfig | null> | null>(),
  readLatestServerSettingsSnapshot: vi.fn<() => unknown>(),
  waitForInitialServerSettingsSnapshot: vi.fn<() => Promise<unknown> | null>(),
}));
vi.mock("~/wsNativeApi", () => streamSnapshotMocks);

beforeEach(() => {
  nativeApiMocks.ensureNativeApiCalls.count = 0;
  // No transport by default, as in the suites below that never open one.
  streamSnapshotMocks.readLatestServerConfigSnapshot.mockReset().mockReturnValue(null);
  streamSnapshotMocks.waitForInitialServerConfigSnapshot.mockReset().mockReturnValue(null);
  streamSnapshotMocks.readLatestServerSettingsSnapshot.mockReset().mockReturnValue(null);
  streamSnapshotMocks.waitForInitialServerSettingsSnapshot.mockReset().mockReturnValue(null);
});

const READY_CODEX_STATUS = {
  provider: "codex",
  instanceId: "codex",
  driver: "codex",
  status: "ready",
  available: true,
  authStatus: "authenticated",
  checkedAt: "2026-07-26T16:41:38.945Z",
} satisfies ServerProviderStatus;

function makeServerConfig(providers: readonly ServerProviderStatus[]): ServerConfig {
  return {
    cwd: "G:\\synara",
    homeDir: "C:\\Users\\tester",
    chatWorkspaceRoot: "C:\\Users\\tester\\Documents\\Synara",
    studioWorkspaceRoot: "C:\\Users\\tester\\Documents\\Synara\\Studio",
    groupsWorkspaceRoot: "C:\\Users\\tester\\Documents\\Synara\\Groups",
    worktreesDir: "C:\\SynaraDev\\worktrees",
    keybindingsConfigPath: "C:\\SynaraDev\\keybindings.json",
    keybindings: [],
    issues: [],
    providers,
    availableEditors: [],
  };
}

describe("server provider status reconciliation", () => {
  it("keeps a newer config cache write during native initial hydration", async () => {
    const queryClient = new QueryClient();
    let resolveConfig!: (config: ServerConfig) => void;
    nativeApiMocks.getConfig.mockReset();
    nativeApiMocks.getConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConfig = resolve;
        }),
    );
    const warningStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      checkedAt: "2026-07-26T16:40:00.000Z",
    } satisfies ServerProviderStatus;
    const newestStatus = {
      ...READY_CODEX_STATUS,
      checkedAt: "2026-07-26T16:42:00.000Z",
    } satisfies ServerProviderStatus;
    const hydration = reconcileServerProviderStatuses(queryClient, [warningStatus]);
    queryClient.setQueryData(serverQueryKeys.config(), {
      ...makeServerConfig([newestStatus]),
      cwd: "new-workspace",
    });
    resolveConfig(makeServerConfig([READY_CODEX_STATUS]));
    await hydration;

    const config = queryClient.getQueryData<ServerConfig>(serverQueryKeys.config());
    expect(config?.providers).toEqual([newestStatus]);
    expect(config?.cwd).toBe("new-workspace");
  });

  it("shares native hydration while applying the latest stream membership", async () => {
    const queryClient = new QueryClient();
    let resolveConfig!: (config: ServerConfig) => void;
    nativeApiMocks.getConfig.mockReset();
    nativeApiMocks.getConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConfig = resolve;
        }),
    );
    const first = reconcileServerProviderStatuses(queryClient, [READY_CODEX_STATUS]);
    const second = reconcileServerProviderStatuses(queryClient, []);
    resolveConfig(makeServerConfig([READY_CODEX_STATUS]));
    await Promise.all([first, second]);

    expect(nativeApiMocks.getConfig).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([]);
  });

  it("does not restore a removed account when reconnects overlap an older config request", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(serverQueryKeys.config(), makeServerConfig([READY_CODEX_STATUS]));
    let resolveOlderConfig!: (config: ServerConfig) => void;
    nativeApiMocks.getConfig.mockReset();
    nativeApiMocks.getConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOlderConfig = resolve;
        }),
    );
    nativeApiMocks.getConfig.mockResolvedValueOnce({
      ...makeServerConfig([]),
      cwd: "new-workspace",
    });

    const olderRefresh = refreshServerConfigAfterTransportOpen(queryClient);
    await reconcileServerProviderStatuses(queryClient, []);
    const newerRefresh = refreshServerConfigAfterTransportOpen(queryClient);
    // Let a fresh request commit first, while releasing the older one even if
    // the cache coalesced it with the new reconnect.
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveOlderConfig(makeServerConfig([READY_CODEX_STATUS]));
    await Promise.all([olderRefresh, newerRefresh]);

    const config = queryClient.getQueryData<ServerConfig>(serverQueryKeys.config());
    expect(config?.providers).toEqual([]);
    expect(config?.cwd).toBe("new-workspace");
  });

  it("remembers a config-only recovery across repeated reconnects", async () => {
    const queryClient = new QueryClient();
    const warningStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      checkedAt: "2026-07-26T16:40:00.000Z",
    } satisfies ServerProviderStatus;
    queryClient.setQueryData(serverQueryKeys.config(), makeServerConfig([warningStatus]));
    await reconcileServerProviderStatuses(queryClient, [warningStatus]);

    await refreshServerConfigAfterTransportOpen(queryClient, {
      loadConfig: async () => makeServerConfig([READY_CODEX_STATUS]),
    });
    await refreshServerConfigAfterTransportOpen(queryClient, {
      loadConfig: async () => makeServerConfig([warningStatus]),
    });

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      READY_CODEX_STATUS,
    ]);
    expect(hasReconciledServerProviderStatuses(queryClient)).toBe(false);
  });

  it("compares a stream arriving during reconnect with the newer config probe", async () => {
    const queryClient = new QueryClient();
    const warningStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      checkedAt: "2026-07-26T16:40:00.000Z",
    } satisfies ServerProviderStatus;
    queryClient.setQueryData(serverQueryKeys.config(), makeServerConfig([]));

    await refreshServerConfigAfterTransportOpen(queryClient, {
      loadConfig: async () => {
        await reconcileServerProviderStatuses(queryClient, [warningStatus]);
        return makeServerConfig([READY_CODEX_STATUS]);
      },
    });

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      READY_CODEX_STATUS,
    ]);
    expect(hasReconciledServerProviderStatuses(queryClient)).toBe(true);
  });

  it("retains a newer failure written to the cache during reconnect", async () => {
    const queryClient = new QueryClient();
    const warningStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      checkedAt: "2026-07-26T16:42:00.000Z",
    } satisfies ServerProviderStatus;
    queryClient.setQueryData(serverQueryKeys.config(), makeServerConfig([]));

    await refreshServerConfigAfterTransportOpen(queryClient, {
      loadConfig: async () => {
        queryClient.setQueryData(serverQueryKeys.config(), makeServerConfig([warningStatus]));
        return makeServerConfig([READY_CODEX_STATUS]);
      },
    });

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      warningStatus,
    ]);
  });

  it("preserves newer statuses when reconnect requests finish in reverse order", async () => {
    const queryClient = new QueryClient();
    const warningStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      checkedAt: "2026-07-26T16:40:00.000Z",
    } satisfies ServerProviderStatus;
    queryClient.setQueryData(serverQueryKeys.config(), makeServerConfig([warningStatus]));
    await reconcileServerProviderStatuses(queryClient, [warningStatus]);
    let resolveConfig!: (config: ServerConfig) => void;
    const configProjection = new Promise<ServerConfig>((resolve) => {
      resolveConfig = resolve;
    });

    const firstRefresh = refreshServerConfigAfterTransportOpen(queryClient, {
      loadConfig: () => configProjection,
    });
    await refreshServerConfigAfterTransportOpen(queryClient, {
      loadConfig: async () => makeServerConfig([READY_CODEX_STATUS]),
    });
    resolveConfig(makeServerConfig([warningStatus]));
    await firstRefresh;

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      READY_CODEX_STATUS,
    ]);
  });

  it("preserves account removal in a reconnect config", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(serverQueryKeys.config(), makeServerConfig([READY_CODEX_STATUS]));
    await reconcileServerProviderStatuses(queryClient, [READY_CODEX_STATUS]);

    await refreshServerConfigAfterTransportOpen(queryClient, {
      loadConfig: async () => makeServerConfig([]),
    });

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([]);
  });

  it("preserves account removal from a newer stream during reconnect", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(serverQueryKeys.config(), makeServerConfig([READY_CODEX_STATUS]));

    await refreshServerConfigAfterTransportOpen(queryClient, {
      loadConfig: async () => {
        await reconcileServerProviderStatuses(queryClient, []);
        return makeServerConfig([READY_CODEX_STATUS]);
      },
    });

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([]);
    expect(hasReconciledServerProviderStatuses(queryClient)).toBe(true);
  });

  it("keeps a newer ready status returned by initial config hydration", async () => {
    const queryClient = new QueryClient();
    const warningStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      authStatus: "unknown",
      checkedAt: "2026-07-26T16:40:00.000Z",
    } satisfies ServerProviderStatus;

    await reconcileServerProviderStatuses(queryClient, [warningStatus], {
      loadConfig: async () => makeServerConfig([READY_CODEX_STATUS]),
    });

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      READY_CODEX_STATUS,
    ]);
  });

  it("keeps a genuinely newer failure returned by initial config hydration", async () => {
    const queryClient = new QueryClient();
    const warningStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      authStatus: "unknown",
      checkedAt: "2026-07-26T16:42:00.000Z",
    } satisfies ServerProviderStatus;

    await reconcileServerProviderStatuses(queryClient, [READY_CODEX_STATUS], {
      loadConfig: async () => makeServerConfig([warningStatus]),
    });

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      warningStatus,
    ]);
  });

  it("keeps a newer config written while initial hydration was in flight", async () => {
    const queryClient = new QueryClient();
    const warningStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      authStatus: "unknown",
      checkedAt: "2026-07-26T16:40:00.000Z",
    } satisfies ServerProviderStatus;
    const newerStatus = {
      ...READY_CODEX_STATUS,
      checkedAt: "2026-07-26T16:42:00.000Z",
    } satisfies ServerProviderStatus;

    await reconcileServerProviderStatuses(queryClient, [warningStatus], {
      loadConfig: async () => {
        queryClient.setQueryData(serverQueryKeys.config(), makeServerConfig([newerStatus]));
        return makeServerConfig([READY_CODEX_STATUS]);
      },
    });

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      newerStatus,
    ]);
  });

  it("remembers the hydrated status when the next reconnect returns stale config", async () => {
    const queryClient = new QueryClient();
    const warningStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      authStatus: "unknown",
      checkedAt: "2026-07-26T16:40:00.000Z",
    } satisfies ServerProviderStatus;

    await reconcileServerProviderStatuses(queryClient, [warningStatus], {
      loadConfig: async () => makeServerConfig([READY_CODEX_STATUS]),
    });
    await refreshServerConfigAfterTransportOpen(queryClient, {
      loadConfig: async () => makeServerConfig([warningStatus]),
    });

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      READY_CODEX_STATUS,
    ]);
  });

  it("keeps the newest provider snapshot when hydration overlaps multiple events", async () => {
    const queryClient = new QueryClient();
    let resolveConfig!: (config: ServerConfig) => void;
    const configProjection = new Promise<ServerConfig>((resolve) => {
      resolveConfig = resolve;
    });
    const unavailableStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      available: false,
      authStatus: "unknown",
      checkedAt: "2026-07-26T16:40:00.000Z",
    } satisfies ServerProviderStatus;

    const first = reconcileServerProviderStatuses(queryClient, [unavailableStatus], {
      loadConfig: () => configProjection,
    });
    const second = reconcileServerProviderStatuses(queryClient, [READY_CODEX_STATUS], {
      loadConfig: () => configProjection,
    });

    resolveConfig(makeServerConfig([]));
    await Promise.all([first, second]);

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      READY_CODEX_STATUS,
    ]);
  });

  it("does not resurrect an older warning after a provider has recovered", async () => {
    const queryClient = new QueryClient();
    const warningStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      available: true,
      authStatus: "unknown",
      checkedAt: "2026-07-26T16:40:00.000Z",
      message: "Pi health check timed out.",
    } satisfies ServerProviderStatus;
    const recoveredStatus = {
      ...READY_CODEX_STATUS,
      checkedAt: "2026-07-26T16:40:10.000Z",
    } satisfies ServerProviderStatus;

    queryClient.setQueryData(serverQueryKeys.config(), makeServerConfig([]));
    await reconcileServerProviderStatuses(queryClient, [recoveredStatus]);
    await reconcileServerProviderStatuses(queryClient, [warningStatus]);

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      recoveredStatus,
    ]);
  });

  it("does not regress a newer config status when a stale stream event arrives", async () => {
    const queryClient = new QueryClient();
    const warningStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      available: true,
      authStatus: "unknown",
      checkedAt: "2026-07-26T16:40:00.000Z",
      message: "Pi health check timed out.",
    } satisfies ServerProviderStatus;
    const recoveredStatus = {
      ...READY_CODEX_STATUS,
      checkedAt: "2026-07-26T16:40:10.000Z",
    } satisfies ServerProviderStatus;

    queryClient.setQueryData(serverQueryKeys.config(), makeServerConfig([recoveredStatus]));
    await reconcileServerProviderStatuses(queryClient, [warningStatus]);

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      recoveredStatus,
    ]);
  });

  it("accepts a newer failure after recovery", async () => {
    const queryClient = new QueryClient();
    const recoveredStatus = {
      ...READY_CODEX_STATUS,
      checkedAt: "2026-07-26T16:40:00.000Z",
    } satisfies ServerProviderStatus;
    const warningStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      available: true,
      authStatus: "unknown",
      checkedAt: "2026-07-26T16:40:10.000Z",
      message: "Pi health check timed out.",
    } satisfies ServerProviderStatus;

    queryClient.setQueryData(serverQueryKeys.config(), makeServerConfig([]));
    await reconcileServerProviderStatuses(queryClient, [recoveredStatus]);
    await reconcileServerProviderStatuses(queryClient, [warningStatus]);

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      warningStatus,
    ]);
  });

  it("keeps a provider snapshot that arrives during reconnect config refresh", async () => {
    const queryClient = new QueryClient();
    const unavailableStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      available: false,
      authStatus: "unknown",
      checkedAt: "2026-07-26T16:40:00.000Z",
    } satisfies ServerProviderStatus;
    queryClient.setQueryData(serverQueryKeys.config(), makeServerConfig([unavailableStatus]));
    let resolveConfig!: (config: ServerConfig) => void;
    const configProjection = new Promise<ServerConfig>((resolve) => {
      resolveConfig = resolve;
    });

    const refresh = refreshServerConfigAfterTransportOpen(queryClient, {
      loadConfig: () => configProjection,
    });
    expect(hasReconciledServerProviderStatuses(queryClient)).toBe(false);

    await reconcileServerProviderStatuses(queryClient, [READY_CODEX_STATUS]);
    expect(hasReconciledServerProviderStatuses(queryClient)).toBe(true);

    resolveConfig(makeServerConfig([unavailableStatus]));
    await refresh;

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      READY_CODEX_STATUS,
    ]);
  });

  it("keeps a newer provider snapshot when reconnect config is stale", async () => {
    const queryClient = new QueryClient();
    const warningStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      available: true,
      authStatus: "unknown",
      checkedAt: "2026-07-26T16:40:00.000Z",
      message: "Pi health check timed out.",
    } satisfies ServerProviderStatus;
    const recoveredStatus = {
      ...READY_CODEX_STATUS,
      checkedAt: "2026-07-26T16:40:10.000Z",
    } satisfies ServerProviderStatus;
    queryClient.setQueryData(serverQueryKeys.config(), makeServerConfig([warningStatus]));
    await reconcileServerProviderStatuses(queryClient, [recoveredStatus]);

    await refreshServerConfigAfterTransportOpen(queryClient, {
      loadConfig: async () => makeServerConfig([warningStatus]),
    });

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      recoveredStatus,
    ]);
  });

  it("accepts reconnect config when no newer provider snapshot arrives", async () => {
    const queryClient = new QueryClient();
    const unavailableStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      available: false,
      authStatus: "unknown",
      checkedAt: "2026-07-26T16:40:00.000Z",
    } satisfies ServerProviderStatus;
    queryClient.setQueryData(serverQueryKeys.config(), makeServerConfig([unavailableStatus]));
    await reconcileServerProviderStatuses(queryClient, [unavailableStatus]);

    await refreshServerConfigAfterTransportOpen(queryClient, {
      loadConfig: async () => makeServerConfig([READY_CODEX_STATUS]),
    });

    expect(hasReconciledServerProviderStatuses(queryClient)).toBe(false);
    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      READY_CODEX_STATUS,
    ]);
  });
});

describe("server config and settings boot snapshots", () => {
  it("seeds an empty config cache from the boot snapshot without a server read", async () => {
    nativeApiMocks.getConfig.mockReset();
    const snapshot = makeServerConfig([READY_CODEX_STATUS]);
    streamSnapshotMocks.readLatestServerConfigSnapshot.mockReturnValue(snapshot);
    const queryClient = new QueryClient();

    const config = await queryClient.fetchQuery(serverConfigQueryOptions());

    expect(config.providers).toEqual([READY_CODEX_STATUS]);
    expect(nativeApiMocks.getConfig).not.toHaveBeenCalled();
  });

  it("reads the config from the server when a hydrated cache is invalidated", async () => {
    const snapshot = makeServerConfig([{ ...READY_CODEX_STATUS, status: "warning" }]);
    streamSnapshotMocks.readLatestServerConfigSnapshot.mockReturnValue(snapshot);
    nativeApiMocks.getConfig.mockReset().mockResolvedValue(makeServerConfig([READY_CODEX_STATUS]));
    const queryClient = new QueryClient();
    await queryClient.fetchQuery(serverConfigQueryOptions());

    // The snapshot is the server's state at subscribe time; the refetch must
    // not write it back over whatever changed since.
    await queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
    const refreshed = await queryClient.fetchQuery(serverConfigQueryOptions());

    expect(nativeApiMocks.getConfig).toHaveBeenCalledTimes(1);
    expect(refreshed.providers).toEqual([READY_CODEX_STATUS]);
  });

  it("keeps a provider update that arrives while the first config query is waiting", async () => {
    nativeApiMocks.getConfig.mockReset();
    let resolveSnapshot!: (config: ServerConfig) => void;
    streamSnapshotMocks.waitForInitialServerConfigSnapshot.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const queryClient = new QueryClient();
    const config = queryClient.fetchQuery(serverConfigQueryOptions());
    const reconciled = reconcileServerProviderStatuses(queryClient, [READY_CODEX_STATUS]);

    resolveSnapshot(
      makeServerConfig([
        {
          ...READY_CODEX_STATUS,
          status: "warning",
          checkedAt: "2026-07-26T16:41:37.000Z",
        },
      ]),
    );

    expect((await config).providers).toEqual([READY_CODEX_STATUS]);
    await reconciled;
    expect(queryClient.getQueryData(serverQueryKeys.config())).toMatchObject({
      providers: [READY_CODEX_STATUS],
    });
    expect(nativeApiMocks.getConfig).not.toHaveBeenCalled();
  });

  it("does not resolve the native API again after waiting for the boot snapshot", async () => {
    // Resolving it again would open a new connection for a query whose
    // transport was disposed while it waited.
    let releaseWait: (config: ServerConfig | null) => void = () => undefined;
    streamSnapshotMocks.waitForInitialServerConfigSnapshot.mockReturnValue(
      new Promise<ServerConfig | null>((resolve) => {
        releaseWait = resolve;
      }),
    );
    nativeApiMocks.getConfig.mockReset().mockResolvedValue(makeServerConfig([READY_CODEX_STATUS]));
    const queryClient = new QueryClient();

    const pending = queryClient.fetchQuery(serverConfigQueryOptions());
    await Promise.resolve();
    const callsBeforeWaitEnded = nativeApiMocks.ensureNativeApiCalls.count;
    releaseWait(null);
    await pending;

    expect(callsBeforeWaitEnded).toBe(1);
    expect(nativeApiMocks.ensureNativeApiCalls.count).toBe(1);
    expect(nativeApiMocks.getConfig).toHaveBeenCalledTimes(1);
  });

  it("reads settings from the server when a hydrated cache is invalidated", async () => {
    streamSnapshotMocks.readLatestServerSettingsSnapshot.mockReturnValue({ source: "stream" });
    nativeApiMocks.getSettings.mockReset().mockResolvedValue({ source: "server" });
    const queryClient = new QueryClient();

    expect(await queryClient.fetchQuery(serverSettingsQueryOptions())).toEqual({
      source: "stream",
    });
    expect(nativeApiMocks.getSettings).not.toHaveBeenCalled();

    await queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() });
    expect(await queryClient.fetchQuery(serverSettingsQueryOptions())).toEqual({
      source: "server",
    });
    expect(nativeApiMocks.getSettings).toHaveBeenCalledTimes(1);
  });
});

describe("sidebarLocalServersQueryOptions", () => {
  it("keeps sidebar attribution enabled without idle polling", () => {
    const options = sidebarLocalServersQueryOptions({
      hasActiveProjectRun: false,
      hasProjects: true,
    });

    expect(options.enabled).toBe(true);
    expect(options.refetchInterval).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(true);
  });

  it("uses visible polling while a Synara-owned project run is active", () => {
    const options = sidebarLocalServersQueryOptions({
      hasActiveProjectRun: true,
      hasProjects: true,
    });

    expect(options.enabled).toBe(true);
    expect(options.refetchInterval).toBe(LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS);
  });

  it("disables sidebar attribution when no projects or project runs exist", () => {
    const options = sidebarLocalServersQueryOptions({
      hasActiveProjectRun: false,
      hasProjects: false,
    });

    expect(options.enabled).toBe(false);
    expect(options.refetchInterval).toBe(false);
  });
});

describe("scoped provider usage", () => {
  it("keeps other quota independent when selected Antigravity has not replied", async () => {
    const queryClient = new QueryClient();
    const codex: ServerProviderUsageSnapshot = {
      provider: "codex",
      updatedAt: "2026-11-23T12:00:00Z",
      limits: [],
      usageLines: [],
      source: "test",
    };
    const antigravity: ServerProviderUsageSnapshot = { ...codex, provider: "antigravity" };
    let replyToAntigravity!: (snapshots: ServerProviderUsageSnapshot[]) => void;
    const waiting = new Promise<ServerProviderUsageSnapshot[]>((resolve) => {
      replyToAntigravity = resolve;
    });
    // Simulate an older host ignoring the exclusion and returning its full batch.
    nativeApiMocks.listProviderUsage
      .mockReset()
      .mockImplementation((input: ServerListProviderUsageInput) =>
        input.provider === "antigravity" ? waiting : Promise.resolve([codex, antigravity]),
      );

    const selectedAntigravity = queryClient.fetchQuery(
      serverAllProviderUsageQueryOptions({ scope: "antigravity" }),
    );
    const other = queryClient.fetchQuery(serverAllProviderUsageQueryOptions({ scope: "other" }));

    try {
      await expect(other).resolves.toEqual([codex]);
      expect(nativeApiMocks.listProviderUsage.mock.calls).toEqual([
        [{ provider: "antigravity" }],
        [{ excludeProvider: "antigravity" }],
      ]);
    } finally {
      replyToAntigravity([antigravity]);
      await selectedAntigravity;
    }
  });
});

describe("invalidateProviderUsageQueries", () => {
  it("invalidates batch and provider-scoped caches after enablement changes", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), []);
    queryClient.setQueryData(serverQueryKeys.scopedProviderUsage("other"), []);
    queryClient.setQueryData(serverQueryKeys.providerUsage("codex", null), null);

    await invalidateProviderUsageQueries(queryClient);

    expect(queryClient.getQueryState(serverQueryKeys.allProviderUsage())?.isInvalidated).toBe(true);
    expect(
      queryClient.getQueryState(serverQueryKeys.scopedProviderUsage("other"))?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(serverQueryKeys.providerUsage("codex", null))?.isInvalidated,
    ).toBe(true);
  });
});

describe("serverProviderUsageSnapshotQueryOptions", () => {
  it("can be disabled by privacy-safe active surfaces", () => {
    const options = serverProviderUsageSnapshotQueryOptions({
      provider: "cursor",
      enabled: false,
    });

    expect(options.enabled).toBe(false);
  });
});

describe("serverRecapQueryOptions", () => {
  it.each([
    ["unsupported host", { code: "FEATURE_UNAVAILABLE" }],
    ["permanent host verdict", { code: "INVALID_INPUT", retryable: false }],
    [
      "exhausted transport capacity",
      { code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED", retryable: true },
    ],
  ])("does not repeat a recap read after %s", async (_label, failure) => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    nativeApiMocks.getRecap.mockReset();
    nativeApiMocks.getRecap.mockRejectedValue(failure);
    const observer = new QueryObserver(
      queryClient,
      serverRecapQueryOptions({
        from: "2026-10-18T02:00:00.000Z",
        to: "2026-10-19T02:00:00.000Z",
        slotBoundaries: [],
      }),
    );
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(8_000);
      expect(nativeApiMocks.getRecap).toHaveBeenCalledTimes(1);
      expect(observer.getCurrentResult().error).toBe(failure);
    } finally {
      unsubscribe();
      observer.destroy();
      queryClient.clear();
      vi.useRealTimers();
    }
  });

  it("recovers an observed recap after one temporary read failure without a manual retry", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const input = {
      from: "2026-10-18T02:00:00.000Z",
      to: "2026-10-19T02:00:00.000Z",
      slotBoundaries: [],
    };
    const totals = {
      from: input.from,
      to: input.to,
      prompts: 6,
      chats: 4,
      turns: 6,
      failedTurns: 0,
      agentWorkMs: 1_365_000,
      tokens: { user: 0, automation: 0, agent: 0 },
    };
    const recap = {
      generatedAt: "2026-10-18T08:39:00.000Z",
      totals,
      slots: [totals],
      projects: [],
      models: [],
      unavailableProviders: [],
    };
    nativeApiMocks.getRecap.mockReset();
    nativeApiMocks.getRecap.mockRejectedValueOnce(new Error("Temporary read failure"));
    nativeApiMocks.getRecap.mockResolvedValue(recap);
    const observer = new QueryObserver(queryClient, serverRecapQueryOptions(input));
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(8_000);
      expect(nativeApiMocks.getRecap).toHaveBeenCalledTimes(2);
      expect(observer.getCurrentResult().data).toEqual(recap);
      expect(observer.getCurrentResult().isSuccess).toBe(true);
    } finally {
      unsubscribe();
      observer.destroy();
      queryClient.clear();
      vi.useRealTimers();
    }
  });
});
