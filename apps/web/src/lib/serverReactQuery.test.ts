// FILE: serverReactQuery.test.ts
// Purpose: Locks down server React Query polling profiles and cache options.
// Layer: Web data-fetching unit tests

import { type ServerConfig, type ServerProviderStatus } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  hasReconciledServerProviderStatuses,
  invalidateProviderUsageQueries,
  LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS,
  reconcileServerProviderStatuses,
  refreshServerConfigAfterTransportOpen,
  serverProviderUsageSnapshotQueryOptions,
  serverQueryKeys,
  sidebarLocalServersQueryOptions,
} from "./serverReactQuery";

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

describe("invalidateProviderUsageQueries", () => {
  it("invalidates batch and provider-scoped caches after enablement changes", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), []);
    queryClient.setQueryData(serverQueryKeys.providerUsage("codex", null), null);

    await invalidateProviderUsageQueries(queryClient);

    expect(queryClient.getQueryState(serverQueryKeys.allProviderUsage())?.isInvalidated).toBe(true);
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
