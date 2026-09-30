// FILE: providerDiscoveryReactQuery.test.ts
// Purpose: Locks provider model discovery query semantics — admission, retry policy,
//          stale-catalog preservation, and initial-vs-background pending (#103).
// Layer: Web data fetching tests

import type {
  NativeApi,
  ProviderListAgentsResult,
  ProviderListModelsResult,
} from "@synara/contracts";
import { hashKey, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isInitialModelDiscoveryPending,
  prioritizeProviderModelDiscovery,
  providerAgentsQueryOptions,
  providerCommandsQueryOptions,
  providerDiscoveryQueryKeys,
  providerModelsQueryOptions,
} from "./providerDiscoveryReactQuery";
import * as nativeApi from "../nativeApi";

function mockListModels(listModels: ReturnType<typeof vi.fn>) {
  vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
    provider: { listModels },
  } as unknown as NativeApi);
  return listModels;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isInitialModelDiscoveryPending", () => {
  it("is pending only for the first fetch (loading or placeholder fetch)", () => {
    expect(
      isInitialModelDiscoveryPending({
        isLoading: true,
        isFetching: true,
        isPlaceholderData: true,
      }),
    ).toBe(true);
    expect(
      isInitialModelDiscoveryPending({
        isLoading: false,
        isFetching: true,
        isPlaceholderData: true,
      }),
    ).toBe(true);
    // Settled catalog + background refetch must not blank the picker (#103).
    expect(
      isInitialModelDiscoveryPending({
        isLoading: false,
        isFetching: true,
        isPlaceholderData: false,
      }),
    ).toBe(false);
    expect(
      isInitialModelDiscoveryPending({
        isLoading: false,
        isFetching: false,
        isPlaceholderData: false,
      }),
    ).toBe(false);
  });
});

describe("providerModelsQueryOptions", () => {
  it("fails fast for Cursor so a missing CLI settles instead of spinning (#103)", async () => {
    const listModels = mockListModels(
      vi.fn().mockRejectedValue(new Error("Cursor CLI is not installed or not on PATH")),
    );
    const options = providerModelsQueryOptions({ provider: "cursor", enabled: true });
    expect(options.retry).toBe(0);

    const queryClient = new QueryClient();
    await expect(queryClient.fetchQuery(options)).rejects.toThrow(
      "Cursor CLI is not installed or not on PATH",
    );
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(options.queryKey)?.status).toBe("error");
  });

  it("serializes different provider catalogs before they reach native admission", async () => {
    let activeDiscoveries = 0;
    let maxActiveDiscoveries = 0;
    const releases: Array<() => void> = [];
    const listModels = mockListModels(
      vi.fn().mockImplementation(async ({ provider }: { provider: string }) => {
        activeDiscoveries += 1;
        maxActiveDiscoveries = Math.max(maxActiveDiscoveries, activeDiscoveries);
        await new Promise<void>((resolve) => releases.push(resolve));
        activeDiscoveries -= 1;
        return {
          models: [{ slug: `${provider}-dynamic`, name: `${provider} dynamic` }],
          source: `${provider}.dynamic`,
          cached: false,
        };
      }),
    );
    const queryClient = new QueryClient();
    const requests = (["opencode", "pi", "devin"] as const).map((provider) =>
      queryClient.fetchQuery(providerModelsQueryOptions({ provider })),
    );

    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(3));
    releases.shift()?.();
    await Promise.all(requests);

    expect(maxActiveDiscoveries).toBe(1);
  });

  it("keeps every active pane selection ahead of speculative prefetch", async () => {
    let releaseCurrent: (() => void) | undefined;
    const listModels = mockListModels(
      vi.fn().mockImplementation(
        ({ provider }: { provider: string }) =>
          new Promise((resolve) => {
            releaseCurrent = () =>
              resolve({
                models: [{ slug: `${provider}-dynamic`, name: `${provider} dynamic` }],
                source: `${provider}.dynamic`,
                cached: false,
              });
          }),
      ),
    );
    const queryClient = new QueryClient();
    const activeOptions = providerModelsQueryOptions({ provider: "opencode" });
    const firstPaneOptions = providerModelsQueryOptions({ provider: "cursor" });
    const secondPaneOptions = providerModelsQueryOptions({ provider: "pi" });
    const hoverOptions = providerModelsQueryOptions({ provider: "devin" });
    const requests = [
      queryClient.fetchQuery(activeOptions),
      queryClient.fetchQuery(firstPaneOptions),
      queryClient.fetchQuery(secondPaneOptions),
      queryClient.fetchQuery(hoverOptions),
    ];

    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    const releaseFirstPane = prioritizeProviderModelDiscovery(firstPaneOptions.queryKey);
    const releaseSecondPane = prioritizeProviderModelDiscovery(secondPaneOptions.queryKey);
    prioritizeProviderModelDiscovery(hoverOptions.queryKey, "prefetch");
    releaseCurrent?.();
    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(2));
    expect(listModels.mock.calls[1]?.[0]).toMatchObject({ provider: "pi" });
    releaseCurrent?.();
    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(3));
    expect(listModels.mock.calls[2]?.[0]).toMatchObject({ provider: "cursor" });
    releaseCurrent?.();
    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(4));
    expect(listModels.mock.calls[3]?.[0]).toMatchObject({ provider: "devin" });
    releaseCurrent?.();
    await Promise.all(requests);
    releaseFirstPane?.();
    releaseSecondPane?.();
  });

  it.each([false, true])(
    "releases obsolete selections (all shared owners released: %s)",
    async (releaseAll) => {
      let releaseActive: (() => void) | undefined;
      const catalog = {
        models: [{ slug: "auto", name: "Auto" }],
        source: "runtime",
        cached: false,
      };
      const listModels = mockListModels(
        vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                releaseActive = () => resolve(catalog);
              }),
          )
          .mockResolvedValue(catalog),
      );
      const client = new QueryClient();
      const active = client.fetchQuery(providerModelsQueryOptions({ provider: "codex" }));
      await vi.waitFor(() => expect(releaseActive).toBeDefined());
      const abandoned = providerModelsQueryOptions({ provider: "cursor" });
      const shared = providerModelsQueryOptions({ provider: "pi" });
      const hover = providerModelsQueryOptions({ provider: "devin", priority: "prefetch" });
      const releaseAbandoned = prioritizeProviderModelDiscovery(abandoned.queryKey);
      const releaseSharedA = prioritizeProviderModelDiscovery(shared.queryKey);
      const releaseSharedB = prioritizeProviderModelDiscovery(shared.queryKey);
      // Ownership predates enqueue: a prefetch for the shared key still belongs
      // to the active pane even if its fetch options say background.
      const requests = [
        active,
        client.fetchQuery(abandoned),
        client.fetchQuery(shared),
        client.fetchQuery(hover),
      ];
      releaseAbandoned?.();
      releaseSharedA?.();
      if (releaseAll) releaseSharedB?.();
      releaseActive?.();
      await Promise.all(requests);
      expect(listModels.mock.calls.map(([input]) => input.provider)).toEqual(
        releaseAll ? ["codex", "devin", "cursor", "pi"] : ["codex", "pi", "devin", "cursor"],
      );
      releaseSharedB?.();
      client.clear();
    },
  );

  it("skips a queued catalog when its inactive prefetch is cancelled", async () => {
    let releaseFirst: (() => void) | undefined;
    const listModels = mockListModels(
      vi.fn().mockImplementation(
        ({ provider }: { provider: string }) =>
          new Promise((resolve) => {
            if (provider !== "opencode") {
              throw new Error(`Unexpected stale discovery for ${provider}`);
            }
            releaseFirst = () =>
              resolve({
                models: [{ slug: "opencode-dynamic", name: "OpenCode Dynamic" }],
                source: "opencode",
                cached: false,
              });
          }),
      ),
    );
    const queryClient = new QueryClient();
    const firstOptions = providerModelsQueryOptions({ provider: "opencode", cwd: "/first" });
    const staleOptions = providerModelsQueryOptions({ provider: "pi", cwd: "/stale" });
    const firstRequest = queryClient.fetchQuery(firstOptions);

    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    const staleRequest = queryClient.fetchQuery(staleOptions).then(
      () => "resolved",
      () => "cancelled",
    );
    await vi.waitFor(() =>
      expect(queryClient.getQueryState(staleOptions.queryKey)?.fetchStatus).toBe("fetching"),
    );
    await queryClient.cancelQueries({ queryKey: staleOptions.queryKey, exact: true });
    releaseFirst?.();

    await expect(firstRequest).resolves.toMatchObject({ source: "opencode" });
    await expect(staleRequest).resolves.toBe("cancelled");
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("keeps an initial Devin fallback usable but immediately stale for recovery", async () => {
    const degraded = {
      models: [{ slug: "sonnet", name: "Sonnet" }],
      source: "devin.static",
      cached: false,
      error: "Devin CLI temporarily failed",
    };
    const listModels = mockListModels(vi.fn().mockResolvedValue(degraded));
    const options = providerModelsQueryOptions({ provider: "devin" });
    const queryClient = new QueryClient();

    await expect(queryClient.fetchQuery(options)).resolves.toEqual(degraded);
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(options.queryKey)).toEqual(degraded);

    const staleTime = options.staleTime as (query: {
      state: { data: ProviderListModelsResult };
    }) => number;
    const refetchInterval = options.refetchInterval as (query: {
      state: { data: ProviderListModelsResult };
    }) => number | false;
    expect(staleTime({ state: { data: degraded } })).toBe(0);
    expect(refetchInterval({ state: { data: degraded } })).toBe(30_000);
    const healthy = {
      models: [{ slug: "custom-devin-model", name: "Custom Devin Model" }],
      source: "devin-cli",
      cached: false,
    };
    expect(staleTime({ state: { data: healthy } })).toBe(15 * 60_000);
    expect(refetchInterval({ state: { data: healthy } })).toBe(false);
  });

  it.each([
    ["opencode", "opencode"],
    ["pi", "pi.sdk+extensions"],
  ] as const)("accepts an authoritative empty %s catalog from %s", async (provider, source) => {
    const listModels = mockListModels(
      vi.fn().mockResolvedValue({ models: [], source, cached: false }),
    );
    const options = { ...providerModelsQueryOptions({ provider }), retry: 0 };
    const queryClient = new QueryClient();

    await expect(queryClient.fetchQuery(options)).resolves.toEqual({
      models: [],
      source,
      cached: false,
    });
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("rejects an unexplained empty runtime catalog instead of caching it", async () => {
    const listModels = mockListModels(
      vi.fn().mockResolvedValue({ models: [], source: "antigravity.cli", cached: false }),
    );
    const options = { ...providerModelsQueryOptions({ provider: "antigravity" }), retry: 0 };
    const queryClient = new QueryClient();

    await expect(queryClient.fetchQuery(options)).rejects.toThrow(
      "antigravity model discovery returned no models",
    );
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(options.queryKey)).toBeUndefined();
  });

  it("caches runtime catalogs long enough to skip respawning provider CLIs", () => {
    // Server-side catalogs persist across restarts (30min fresh / 24h SWR), so
    // the client keeps a matching window; OMP stays short at 30s because its
    // catalog is refetched on focus/interval while observed.
    expect(providerModelsQueryOptions({ provider: "cursor" }).staleTime).toBe(15 * 60_000);
    expect(providerModelsQueryOptions({ provider: "codex" }).staleTime).toBe(15 * 60_000);
    expect(providerModelsQueryOptions({ provider: "droid" }).staleTime).toBe(30 * 60_000);
    expect(providerModelsQueryOptions({ provider: "droid" }).refetchOnWindowFocus).toBe(false);
    expect(providerModelsQueryOptions({ provider: "omp" }).staleTime).toBe(30_000);
    expect(providerModelsQueryOptions({ provider: "omp" }).refetchOnWindowFocus).toBe(true);
    expect(providerModelsQueryOptions({ provider: "cursor" }).gcTime).toBe(24 * 60 * 60_000);
  });

  it("does not mask OMP's initial fetch with a placeholder", () => {
    // OMP has no static model fallback, so an empty placeholder would surface a
    // false "No matches" during its ~3s `omp models` discovery. OMP opts out of
    // placeholderData to report a genuine `isLoading` pending state; other
    // providers keep the placeholder to suppress refetch flicker.
    expect(providerModelsQueryOptions({ provider: "omp" }).placeholderData).toBeUndefined();
    expect(providerModelsQueryOptions({ provider: "cursor" }).placeholderData).toBeDefined();
    expect(providerModelsQueryOptions({ provider: "pi" }).placeholderData).toBeDefined();
  });

  it("preserves the cached catalog when a background refetch fails", async () => {
    const catalog = {
      models: [{ slug: "auto", name: "Auto" }],
      source: "cursor.cli",
      cached: false,
    };
    const listModels = mockListModels(
      vi.fn().mockResolvedValueOnce(catalog).mockRejectedValue(new Error("cursor went away")),
    );
    const options = providerModelsQueryOptions({ provider: "cursor", enabled: true });

    const queryClient = new QueryClient();
    await expect(queryClient.fetchQuery(options)).resolves.toEqual(catalog);
    await queryClient.refetchQueries({ queryKey: options.queryKey });

    expect(listModels).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(options.queryKey)).toEqual(catalog);
  });

  it("preserves a cached dynamic catalog when refresh returns a degraded fallback", async () => {
    const catalog = {
      models: [{ slug: "custom-devin-model", name: "Custom Devin Model" }],
      source: "devin-cli",
      cached: false,
    };
    const degraded = {
      models: [{ slug: "sonnet", name: "Sonnet" }],
      source: "devin.static",
      cached: false,
      error: "Devin CLI temporarily failed",
    };
    const listModels = mockListModels(
      vi.fn().mockResolvedValueOnce(catalog).mockResolvedValueOnce(degraded),
    );
    const options = { ...providerModelsQueryOptions({ provider: "devin" }), retry: 0 };
    const queryClient = new QueryClient();

    await expect(queryClient.fetchQuery(options)).resolves.toEqual(catalog);
    await queryClient.refetchQueries({ queryKey: options.queryKey });

    expect(listModels).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(options.queryKey)).toEqual(catalog);
    expect(queryClient.getQueryState(options.queryKey)?.error).toEqual(
      new Error("Devin CLI temporarily failed"),
    );
    const interval = options.refetchInterval;
    if (typeof interval !== "function") throw new Error("Expected recovery polling");
    const query = queryClient
      .getQueryCache()
      .get<
        ProviderListModelsResult,
        Error,
        ProviderListModelsResult,
        Parameters<typeof interval>[0]["queryKey"]
      >(hashKey(options.queryKey));
    if (!query) throw new Error("Missing Devin query");
    expect(interval(query)).toBe(30_000);
    listModels.mockResolvedValue(catalog);
    await queryClient.refetchQueries({ queryKey: options.queryKey });
    expect(queryClient.getQueryData(options.queryKey)).toEqual(catalog);
    expect(query.state.error).toBeNull();
    expect(interval(query)).toBe(false);
    queryClient.clear();
  });

  it("keeps OMP's model query cwd-agnostic because the catalog is global", () => {
    const options = providerModelsQueryOptions({
      provider: "omp",
      binaryPath: "/bin/omp",
      agentDir: "/agent",
      cwd: "/some/project",
    });
    // `omp models --json` reads no project layer, so cwd is forced to null and
    // every caller shares the same binary+agent-dir key.
    expect(options.queryKey).toEqual(
      providerDiscoveryQueryKeys.models("omp", "/bin/omp", null, "/agent", null),
    );
  });

  it("scopes non-OMP providers by cwd in their query key", () => {
    const options = providerModelsQueryOptions({
      provider: "opencode",
      binaryPath: "/bin/opencode",
      cwd: "/some/project",
    });
    expect(options.queryKey).toEqual(
      providerDiscoveryQueryKeys.models("opencode", "/bin/opencode", null, null, "/some/project"),
    );
  });
});

describe("providerCommandsQueryOptions", () => {
  const keyFor = (provider: "claudeAgent" | "codex", threadId: string) =>
    hashKey(providerCommandsQueryOptions({ provider, cwd: "/repo", threadId }).queryKey);

  it("keys Claude commands per thread because a session fixes its Artifact opt-in", () => {
    expect(keyFor("claudeAgent", "thread-a")).not.toBe(keyFor("claudeAgent", "thread-b"));
  });

  it("shares other providers' commands across threads of a workspace", () => {
    expect(keyFor("codex", "thread-a")).toBe(keyFor("codex", "thread-b"));
  });
});

describe("providerAgentsQueryOptions", () => {
  it("recovers from pending discovery while retaining completed catalogs", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    const pending = { agents: [], source: "pending", cached: false };
    const ready = {
      agents: [{ name: "code-reviewer", displayName: "Code Reviewer" }],
      source: "sdk",
      cached: true,
    };
    const listAgents = vi.fn().mockResolvedValueOnce(pending).mockResolvedValue(ready);
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      provider: { listAgents },
    } as unknown as NativeApi);
    const client = new QueryClient();
    const options = providerAgentsQueryOptions({ provider: "claudeAgent" });
    const refetchInterval = options.refetchInterval as (query: {
      state: { data: ProviderListAgentsResult };
    }) => number | false;
    expect(refetchInterval({ state: { data: pending } })).toBe(30_000);
    expect(refetchInterval({ state: { data: ready } })).toBe(false);
    expect(refetchInterval({ state: { data: { ...ready, agents: [] } } })).toBe(false);
    try {
      expect(await client.fetchQuery(options)).toEqual(pending);
      // The adapter completes supportedAgents() asynchronously. Reopening the
      // picker must be able to read that result instead of caching "pending".
      now.mockReturnValue(baseTime + 61_000);
      expect(await client.fetchQuery(options)).toEqual(ready);
      now.mockReturnValue(baseTime + 120_000);
      expect(await client.fetchQuery(options)).toEqual(ready);
      expect(listAgents).toHaveBeenCalledTimes(2);
    } finally {
      client.clear();
    }
  });
});
