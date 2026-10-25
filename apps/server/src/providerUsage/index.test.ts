// FILE: providerUsage/index.test.ts
// Purpose: Covers the orchestration layer's snapshot cache — TTL reuse, single-flight coalescing
// of concurrent requests, forceRefresh bypass, and the shorter expiry for degraded snapshots —
// so UI surfaces polling in parallel can't stampede the provider fetchers.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerProviderUsageSnapshot } from "@synara/contracts";

import { ServerConfig } from "../config";
import { ServerSettingsService } from "../serverSettings";
import {
  __resetProviderUsageCacheForTests,
  collectProviderUsageSnapshots,
  listProviderUsage,
} from "./index";
import type { ProviderUsageContext, ProviderUsageFetcher } from "./types";

const fetchMock = vi.fn<(ctx: ProviderUsageContext) => Promise<ServerProviderUsageSnapshot>>();
const cacheKeyMock = vi.fn<(ctx: ProviderUsageContext) => Promise<string>>();
const localUsageLinesMock = vi.fn();

vi.mock("../providerUsageSnapshot", () => ({
  loadLocalProviderUsageLines: (input: unknown) => localUsageLinesMock(input),
}));

vi.mock("./registry", () => ({
  PROVIDER_USAGE_FETCHERS: {
    codex: {
      provider: "codex",
      cacheKey: (ctx: ProviderUsageContext) => cacheKeyMock(ctx),
      fetch: (ctx: ProviderUsageContext) => fetchMock(ctx),
    } satisfies ProviderUsageFetcher,
  },
}));

const NOW_MS = 1_780_000_000_000;

function makeCtx(nowMs: number, account = "account-a"): ProviderUsageContext {
  return {
    homeDir: "/nonexistent-home",
    env: { TEST_USAGE_ACCOUNT: account },
    platform: "linux",
    nowMs,
  };
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
  cacheKeyMock.mockReset();
  cacheKeyMock.mockImplementation(async (ctx) => ctx.env.TEST_USAGE_ACCOUNT ?? "account-a");
  localUsageLinesMock.mockReset();
  localUsageLinesMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release(okSnapshot(NOW_MS));
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("joins an in-flight refresh instead of serving the previous cached snapshot", async () => {
    fetchMock.mockResolvedValueOnce(okSnapshot(NOW_MS, "cached"));
    await collectProviderUsageSnapshots(makeCtx(NOW_MS));

    let release: (snapshot: ServerProviderUsageSnapshot) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise<ServerProviderUsageSnapshot>((resolve) => (release = resolve)),
    );
    const refreshPromise = collectProviderUsageSnapshots(makeCtx(NOW_MS + 1_000), {
      forceRefresh: true,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const pollPromise = collectProviderUsageSnapshots(makeCtx(NOW_MS + 2_000));
    release(okSnapshot(NOW_MS + 1_000, "refreshed"));
    const [refreshed, polled] = await Promise.all([refreshPromise, pollPromise]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed[0]?.source).toBe("refreshed");
    expect(polled).toEqual(refreshed);
  });

  it("invalidates a fresh snapshot when the selected credentials change", async () => {
    fetchMock.mockImplementation(async (ctx) => okSnapshot(ctx.nowMs, ctx.env.TEST_USAGE_ACCOUNT));

    await collectProviderUsageSnapshots(makeCtx(NOW_MS, "account-a"));
    const switched = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 1_000, "account-b"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(switched[0]?.source).toBe("account-b");
  });

  it("does not cache a snapshot when credentials change during the fetch", async () => {
    let account = "account-a";
    let release: (snapshot: ServerProviderUsageSnapshot) => void = () => {};
    cacheKeyMock.mockImplementation(async () => account);
    fetchMock.mockImplementationOnce(
      () => new Promise<ServerProviderUsageSnapshot>((resolve) => (release = resolve)),
    );

    const firstPromise = collectProviderUsageSnapshots(makeCtx(NOW_MS));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    account = "account-b";
    release(okSnapshot(NOW_MS, "account-a"));
    await firstPromise;

    fetchMock.mockImplementation(async (ctx) => okSnapshot(ctx.nowMs, account));
    const second = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 1_000));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second[0]?.source).toBe("account-b");
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

  it("returns a fresh healthy cache entry when a refresh fails", async () => {
    fetchMock.mockResolvedValueOnce(okSnapshot(NOW_MS, "healthy")).mockResolvedValueOnce({
      ...okSnapshot(NOW_MS + 1_000, "failed-refresh"),
      status: "error",
      detail: "Usage fetch failed unexpectedly.",
    });

    await collectProviderUsageSnapshots(makeCtx(NOW_MS));
    const failedRefresh = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 1_000), {
      forceRefresh: true,
    });
    const polled = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 2_000));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(failedRefresh[0]?.source).toBe("healthy");
    expect(polled[0]?.source).toBe("healthy");
  });

  it("replaces a healthy cache entry when refresh discovers authentication is required", async () => {
    fetchMock.mockResolvedValueOnce(okSnapshot(NOW_MS, "healthy")).mockResolvedValueOnce({
      ...okSnapshot(NOW_MS + 1_000, "auth-required"),
      status: "needs-auth",
    });

    await collectProviderUsageSnapshots(makeCtx(NOW_MS));
    await collectProviderUsageSnapshots(makeCtx(NOW_MS + 1_000), { forceRefresh: true });
    const polled = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 2_000));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(polled[0]?.source).toBe("auth-required");
  });

  it("expires a stale refresh instead of restoring the previous healthy cache entry", async () => {
    fetchMock
      .mockResolvedValueOnce(okSnapshot(NOW_MS, "healthy"))
      .mockResolvedValueOnce({ ...okSnapshot(NOW_MS + 1_000, "throttled"), stale: true })
      .mockResolvedValueOnce(okSnapshot(NOW_MS + 2_000, "recovered"));

    await collectProviderUsageSnapshots(makeCtx(NOW_MS));
    await collectProviderUsageSnapshots(makeCtx(NOW_MS + 1_000), { forceRefresh: true });
    const polled = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 2_000));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(polled[0]?.source).toBe("recovered");
  });

  it("omits disabled providers and invalidates their cached snapshots", async () => {
    fetchMock.mockImplementation(async (ctx) => okSnapshot(ctx.nowMs));
    const configLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
      Layer.provide(NodeServices.layer),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      configLayer,
      ServerSettingsService.layerTest(),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsService;
        const first = yield* listProviderUsage({});

        yield* serverSettings.updateSettings({ providers: { codex: { enabled: false } } });
        const disabled = yield* listProviderUsage({ forceRefresh: true });

        yield* serverSettings.updateSettings({ providers: { codex: { enabled: true } } });
        const reenabled = yield* listProviderUsage({});
        return { first, disabled, reenabled };
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(result.first).toHaveLength(1);
    expect(result.disabled).toEqual([]);
    expect(result.reenabled).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function usageTestLayer() {
  const configLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
    Layer.provide(NodeServices.layer),
  );
  return Layer.mergeAll(NodeServices.layer, configLayer, ServerSettingsService.layerTest());
}

describe("listProviderUsage account routing", () => {
  it.each(["same-source", "environment-only"] as const)(
    "reads the private Codex account overlay for a %s account",
    async (kind) => {
      vi.stubEnv("CODEX_HOME", "/accounts/personal");
      fetchMock.mockImplementation(async (ctx) => okSnapshot(ctx.nowMs, ctx.env.CODEX_HOME));
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const settings = yield* ServerSettingsService;
          yield* settings.updateSettings({
            providerInstances: {
              codex_work: {
                driver: "codex",
                ...(kind === "same-source"
                  ? { config: { homePath: "/accounts/personal" } }
                  : { environment: [{ name: "CODEX_HOME", value: "/accounts/personal" }] }),
              },
            },
          });
          return yield* listProviderUsage({});
        }).pipe(Effect.provide(usageTestLayer()), Effect.scoped),
      );
      const work = result.find((snapshot) => snapshot.instanceId === "codex_work");
      expect(work?.source).toMatch(/\/codex-home-overlay\/accounts\/codex_work-[a-f0-9]{12}$/u);
      expect(work?.source).not.toBe("/accounts/personal");
    },
  );

  it("refreshes the same account when its launch context changes without a credential change", async () => {
    fetchMock.mockImplementation(async (ctx) => okSnapshot(ctx.nowMs, ctx.env.TEST_USAGE_CONTEXT));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({
          providerInstances: {
            codex_work: {
              driver: "codex",
              environment: [{ name: "TEST_USAGE_CONTEXT", value: "before" }],
              config: { homePath: "/accounts/work" },
            },
          },
        });
        yield* listProviderUsage({});
        yield* settings.updateSettings({
          providerInstances: {
            codex_work: {
              driver: "codex",
              environment: [{ name: "TEST_USAGE_CONTEXT", value: "after" }],
              config: { homePath: "/accounts/work" },
            },
          },
        });
        return yield* listProviderUsage({});
      }).pipe(Effect.provide(usageTestLayer()), Effect.scoped),
    );
    expect(result.find((snapshot) => snapshot.instanceId === "codex_work")?.source).toBe("after");
  });

  it("returns both configured accounts with their own homes and cached quotas", async () => {
    fetchMock.mockImplementation(async (ctx) => ({
      ...okSnapshot(ctx.nowMs, ctx.env.CODEX_HOME),
      limits: [{ window: "5h", usedPercent: ctx.env.CODEX_HOME === "/accounts/work" ? 72 : 21 }],
      resetCredits: { availableCount: 1, canUse: true },
    }));
    localUsageLinesMock.mockResolvedValue([{ label: "Tokens", value: "default total" }]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({
          providerInstances: {
            codex: { driver: "codex", config: { homePath: "/accounts/personal" } },
            codex_work: { driver: "codex", config: { homePath: "/accounts/work" } },
          },
        });
        const first = yield* listProviderUsage({});
        const cached = yield* listProviderUsage({});
        return { first, cached };
      }).pipe(Effect.provide(usageTestLayer()), Effect.scoped),
    );

    expect(result.first).toMatchObject([
      { instanceId: "codex", source: "/accounts/personal", limits: [{ usedPercent: 21 }] },
      {
        instanceId: "codex_work",
        source: "/accounts/work",
        limits: [{ usedPercent: 72 }],
        resetCredits: { canUse: false },
        usageLines: [],
      },
    ]);
    expect(result.cached).toEqual(result.first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(localUsageLinesMock).toHaveBeenCalledWith({
      provider: "codex",
      homeDir: expect.any(String),
      homePath: "/accounts/personal",
    });
  });

  it("retains enabled siblings when the default account is disabled", async () => {
    fetchMock.mockImplementation(async (ctx) => okSnapshot(ctx.nowMs, ctx.env.CODEX_HOME));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({
          providers: { codex: { enabled: false } },
          providerInstances: {
            codex_work: { driver: "codex", config: { homePath: "/accounts/work" } },
          },
        });
        return yield* listProviderUsage({ provider: "codex" });
      }).pipe(Effect.provide(usageTestLayer()), Effect.scoped),
    );
    expect(result).toMatchObject([{ instanceId: "codex_work", source: "/accounts/work" }]);
    expect(result).toHaveLength(1);
  });

  it.each(["disabled", "removed"] as const)(
    "drops the cached quota for a %s account before it is enabled again",
    async (action) => {
      let workUsedPercent = 72;
      fetchMock.mockImplementation(async (ctx) => ({
        ...okSnapshot(ctx.nowMs),
        limits: [{ window: "5h", usedPercent: workUsedPercent }],
      }));
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const settings = yield* ServerSettingsService;
          const account = { driver: "codex", config: { homePath: "/accounts/work" } };
          yield* settings.updateSettings({ providerInstances: { codex_work: account } });
          yield* listProviderUsage({});
          yield* settings.updateSettings({
            providerInstances:
              action === "removed" ? {} : { codex_work: { ...account, enabled: false } },
          });
          const absent = yield* listProviderUsage({});
          workUsedPercent = 18;
          yield* settings.updateSettings({ providerInstances: { codex_work: account } });
          const restored = yield* listProviderUsage({});
          return { absent, restored };
        }).pipe(Effect.provide(usageTestLayer()), Effect.scoped),
      );
      expect(result.absent.map((snapshot) => snapshot.instanceId)).toEqual(["codex"]);
      expect(
        result.restored.find((snapshot) => snapshot.instanceId === "codex_work")?.limits,
      ).toEqual([{ window: "5h", usedPercent: 18 }]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  it("uses the selected shadow home and expands account environment paths", async () => {
    fetchMock.mockImplementation(async (ctx) => ({
      ...okSnapshot(ctx.nowMs, ctx.env.CODEX_HOME),
      usageLines: [{ label: "Marker", value: ctx.env.TEST_USAGE_ACCOUNT ?? "missing" }],
    }));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const config = yield* ServerConfig;
        yield* settings.updateSettings({
          providerInstances: {
            codex_shadow: {
              driver: "codex",
              environment: [{ name: "TEST_USAGE_ACCOUNT", value: "shadow" }],
              config: { homePath: "/shared/config", shadowHomePath: "~/accounts/shadow" },
            },
          },
        });
        const snapshots = yield* listProviderUsage({});
        return { snapshots, homeDir: config.homeDir };
      }).pipe(Effect.provide(usageTestLayer()), Effect.scoped),
    );
    expect(
      result.snapshots.find((snapshot) => snapshot.instanceId === "codex_shadow"),
    ).toMatchObject({
      source: `${result.homeDir}/accounts/shadow`,
      usageLines: [{ label: "Marker", value: "shadow" }],
    });
  });
});
