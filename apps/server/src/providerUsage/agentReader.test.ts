import type { ProviderKind, ServerProviderUsageSnapshot } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { readProviderUsageForAgents } from "./agentReader";

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
