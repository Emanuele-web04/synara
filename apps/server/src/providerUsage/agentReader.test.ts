import {
  ServerSettings,
  type ProviderKind,
  type ServerProviderUsageSnapshot,
} from "@synara/contracts";
import { deriveProviderInstances } from "@synara/shared/providerInstances";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeProviderAccountUsageReader, readProviderUsageForAgents } from "./agentReader";
import { getCachedProviderInstanceUsageSnapshot } from "./index";

vi.mock("./index.ts", () => ({ getCachedProviderInstanceUsageSnapshot: vi.fn(async () => null) }));

beforeEach(() => {
  vi.mocked(getCachedProviderInstanceUsageSnapshot).mockReset();
});

const NOW_MS = Date.parse("2026-09-08T18:00:00.000Z");
const snapshot: ServerProviderUsageSnapshot = {
  provider: "codex",
  updatedAt: new Date(NOW_MS).toISOString(),
  limits: [{ window: "5h", usedPercent: 40, resetsAt: new Date(NOW_MS + 1_000).toISOString() }],
  usageLines: [],
  source: "codex-usage-api",
  status: "ok",
};

describe("readProviderUsageForAgents", () => {
  it("rechecks early results after another provider crosses their reset", async () => {
    let nowMs = NOW_MS;
    const results = await Effect.runPromise(
      readProviderUsageForAgents({
        providers: ["codex", "cursor"],
        enabledProviders: new Set(["codex", "cursor"]),
        loadSnapshot: (provider) =>
          provider === "codex"
            ? Effect.succeed(snapshot)
            : Effect.sync(() => {
                nowMs += 1_001;
                return null;
              }).pipe(Effect.delay("10 millis")),
        now: () => nowMs,
      }),
    );

    expect(results[0]).toMatchObject({
      checkedAt: new Date(NOW_MS + 1_001).toISOString(),
      availability: "unavailable",
      unavailableReason: "expired-window",
    });
    expect(results[0]?.quotaWindows[0]).not.toHaveProperty("remainingPercent");
  });

  it("preserves order and isolates missing, failed, and disabled providers", async () => {
    const loadSnapshot = vi.fn((provider: ProviderKind) =>
      provider === "cursor" ? Effect.fail(new Error("offline")) : Effect.succeed(null),
    );
    const results = await Effect.runPromise(
      readProviderUsageForAgents({
        providers: ["codex", "cursor", "grok"],
        enabledProviders: new Set(["codex", "cursor"]),
        loadSnapshot,
        now: () => NOW_MS,
      }),
    );

    expect(results.map((result) => [result.provider, result.unavailableReason])).toEqual([
      ["codex", "missing-snapshot"],
      ["cursor", "provider-error"],
      ["grok", "disabled"],
    ]);
    expect(loadSnapshot.mock.calls.map(([provider]) => provider)).toEqual(["codex", "cursor"]);
  });

  it("lets a shared fetch finish after an agent waiter times out", async () => {
    const { promise, resolve } = Promise.withResolvers<ServerProviderUsageSnapshot>();
    const input = {
      providers: ["codex"] as const,
      enabledProviders: new Set<ProviderKind>(["codex"]),
      loadSnapshot: () => Effect.promise(() => promise),
      timeout: "10 millis" as const,
      now: () => NOW_MS,
    };
    const timedOut = await Effect.runPromise(readProviderUsageForAgents(input));
    expect(timedOut[0]?.unavailableReason).toBe("timed-out");

    resolve(snapshot);
    const retry = await Effect.runPromise(readProviderUsageForAgents(input));
    expect(retry[0]?.quotaWindows[0]?.remainingPercent).toBe(60);
  });
});

describe("makeProviderAccountUsageReader", () => {
  const settings = Schema.decodeUnknownSync(ServerSettings)({
    providerInstances: {
      codex_work: {
        driver: "codex",
        displayName: "Work álïçé@exämple.com",
        config: { secret: "credential-marker" },
        environment: [{ name: "ACCOUNT_KEY", value: "environment-marker" }],
      },
      codex_disabled: { driver: "codex", enabled: false, displayName: "Disabled bob@example.com" },
      omp_extra: { driver: "omp", enabled: true },
    },
  });
  const read = makeProviderAccountUsageReader({
    getSettings: Effect.succeed(settings),
    context: { homeDir: "/test-home", env: {}, platform: "linux" },
    stateDir: "/test-state",
    baseDir: "/test-base",
    now: () => NOW_MS,
    timeout: "10 millis",
  });

  it("returns every configured account with safe identity and unavailable states", async () => {
    vi.mocked(getCachedProviderInstanceUsageSnapshot).mockImplementation(async (instance) =>
      instance.instanceId === "codex_work" ? snapshot : null,
    );
    const results = await Effect.runPromise(read());

    expect(results.map((result) => result.instanceId)).toEqual(
      deriveProviderInstances(settings).map((instance) => instance.instanceId),
    );
    expect(results.find((result) => result.instanceId === "codex_work")).toMatchObject({
      provider: "codex",
      displayName: "Work [account]",
      isDefault: false,
      enabled: true,
      availability: "available",
      quotaWindows: [{ remainingPercent: 60 }],
    });
    expect(results.find((result) => result.instanceId === "codex")).toMatchObject({
      isDefault: true,
      unavailableReason: "missing-snapshot",
      snapshot: null,
    });
    expect(results.find((result) => result.instanceId === "codex_disabled")).toMatchObject({
      displayName: "Disabled [account]",
      enabled: false,
      unavailableReason: "disabled",
      snapshot: null,
    });
    expect(results.find((result) => result.instanceId === "omp_extra")).toMatchObject({
      unavailableReason: "unsupported",
      snapshot: null,
    });
    const reads = vi
      .mocked(getCachedProviderInstanceUsageSnapshot)
      .mock.calls.map(([instance]) => instance.instanceId);
    expect(reads).not.toContain("codex_disabled");
    expect(reads).not.toContain("omp_extra");
    expect(JSON.stringify(results)).not.toMatch(
      /example\.com|exämple\.com|credential-marker|environment-marker/,
    );
  });

  it("filters all accounts of a provider and pins an instance without ambient fallback", async () => {
    const provider = await Effect.runPromise(read({ provider: "codex" }));
    expect(provider.map((result) => result.instanceId)).toEqual([
      "codex",
      "codex_work",
      "codex_disabled",
    ]);
    vi.mocked(getCachedProviderInstanceUsageSnapshot).mockClear();
    const account = await Effect.runPromise(read({ instanceId: "codex_work" }));
    expect(account.map((result) => result.instanceId)).toEqual(["codex_work"]);
    expect(
      vi
        .mocked(getCachedProviderInstanceUsageSnapshot)
        .mock.calls.map(([instance]) => instance.instanceId),
    ).toEqual(["codex_work"]);
  });

  it.each([
    { provider: "codex", instanceId: "droid" },
    { instanceId: "codex_removed" },
    { provider: "unknown" },
    { instanceId: "alice@example.com" },
    { provider: "codex", refresh: true },
  ])("rejects an invalid or mismatched query without reading credentials: %j", async (query) => {
    await expect(Effect.runPromise(read(query))).rejects.toThrow();
    expect(getCachedProviderInstanceUsageSnapshot).not.toHaveBeenCalled();
  });

  it("keeps account identity when a cached read stalls", async () => {
    vi.mocked(getCachedProviderInstanceUsageSnapshot).mockImplementation(
      () => new Promise(() => {}),
    );
    const results = await Effect.runPromise(read({ instanceId: "codex_work" }));
    expect(results).toMatchObject([
      {
        provider: "codex",
        instanceId: "codex_work",
        displayName: "Work [account]",
        unavailableReason: "timed-out",
        snapshot: null,
        quotaWindows: [],
      },
    ]);
  });

  it("isolates a rejected account read from a healthy sibling", async () => {
    vi.mocked(getCachedProviderInstanceUsageSnapshot).mockImplementation(async (instance) => {
      if (instance.instanceId === "codex") throw new Error("local credential context unavailable");
      return snapshot;
    });
    const results = await Effect.runPromise(read({ provider: "codex" }));
    expect(results.find((result) => result.instanceId === "codex")).toMatchObject({
      unavailableReason: "provider-error",
      snapshot: null,
    });
    expect(results.find((result) => result.instanceId === "codex_work")).toMatchObject({
      availability: "available",
      quotaWindows: [{ remainingPercent: 60 }],
    });
  });
});
