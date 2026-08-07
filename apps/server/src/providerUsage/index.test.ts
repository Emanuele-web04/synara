// FILE: providerUsage/index.test.ts
// Purpose: Covers the orchestration layer's snapshot cache — TTL reuse, single-flight coalescing
// of concurrent requests, forceRefresh bypass, and the shorter expiry for degraded snapshots —
// so UI surfaces polling in parallel can't stampede the provider fetchers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerProviderUsageSnapshot } from "@synara/contracts";

import { __resetProviderUsageCacheForTests, collectProviderUsageSnapshots } from "./index";
import type { ProviderUsageContext, ProviderUsageFetcher } from "./types";

const fetchMock = vi.fn<(ctx: ProviderUsageContext) => Promise<ServerProviderUsageSnapshot>>();

vi.mock("./registry", () => ({
  PROVIDER_USAGE_FETCHERS: {
    codex: {
      provider: "codex",
      fetch: (ctx: ProviderUsageContext) => fetchMock(ctx),
    } satisfies ProviderUsageFetcher,
  },
}));

const NOW_MS = 1_780_000_000_000;

function makeCtx(nowMs: number): ProviderUsageContext {
  return { homeDir: "/nonexistent-home", env: {}, platform: "linux", nowMs };
}

function okSnapshot(nowMs: number, source = "live"): ServerProviderUsageSnapshot {
  return {
    provider: "codex",
    updatedAt: new Date(nowMs).toISOString(),
    limits: [],
    usageLines: [],
    source,
    status: "ok",
  };
}

beforeEach(() => {
  __resetProviderUsageCacheForTests();
  fetchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collectProviderUsageSnapshots caching", () => {
  it("serves a fresh snapshot from cache without re-fetching", async () => {
    fetchMock.mockResolvedValue(okSnapshot(NOW_MS));

    const first = await collectProviderUsageSnapshots(makeCtx(NOW_MS));
    const second = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 60_000));

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the cache TTL expires", async () => {
    fetchMock.mockImplementation(async (ctx) => okSnapshot(ctx.nowMs));

    await collectProviderUsageSnapshots(makeCtx(NOW_MS));
    const later = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 6 * 60_000));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(later[0]?.updatedAt).toBe(new Date(NOW_MS + 6 * 60_000).toISOString());
  });

  it("coalesces concurrent requests into a single fetch", async () => {
    let release: (snapshot: ServerProviderUsageSnapshot) => void = () => {};
    fetchMock.mockImplementation(
      () => new Promise<ServerProviderUsageSnapshot>((resolve) => (release = resolve)),
    );

    const firstPromise = collectProviderUsageSnapshots(makeCtx(NOW_MS));
    const secondPromise = collectProviderUsageSnapshots(makeCtx(NOW_MS));
    release(okSnapshot(NOW_MS));
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("bypasses the TTL on forceRefresh", async () => {
    fetchMock.mockImplementation(async (ctx) => okSnapshot(ctx.nowMs));

    await collectProviderUsageSnapshots(makeCtx(NOW_MS));
    const refreshed = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 1_000), {
      forceRefresh: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed[0]?.updatedAt).toBe(new Date(NOW_MS + 1_000).toISOString());
  });

  it("expires degraded snapshots faster than healthy ones", async () => {
    fetchMock.mockImplementation(async (ctx) => ({
      ...okSnapshot(ctx.nowMs),
      status: "error",
      detail: "Usage fetch failed unexpectedly.",
    }));

    await collectProviderUsageSnapshots(makeCtx(NOW_MS));
    // Within the degraded TTL: still served from cache.
    await collectProviderUsageSnapshots(makeCtx(NOW_MS + 30_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Past the degraded TTL (but well within the healthy one): re-fetched.
    await collectProviderUsageSnapshots(makeCtx(NOW_MS + 90_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats re-served last-good (stale) snapshots as degraded for expiry", async () => {
    fetchMock.mockImplementation(async (ctx) => ({ ...okSnapshot(ctx.nowMs), stale: true }));

    await collectProviderUsageSnapshots(makeCtx(NOW_MS));
    await collectProviderUsageSnapshots(makeCtx(NOW_MS + 90_000));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
