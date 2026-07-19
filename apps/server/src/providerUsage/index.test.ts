import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderKind, ServerProviderUsageSnapshot } from "@synara/contracts";
import { PROVIDER_USAGE_PROVIDERS } from "@synara/shared/providerUsage";

import { collectProviderUsageSnapshots } from "./index";
import { PROVIDER_USAGE_FETCHERS } from "./registry";
import type { ProviderUsageContext } from "./types";

const { loadLocalProviderUsageLinesMock } = vi.hoisted(() => ({
  loadLocalProviderUsageLinesMock: vi.fn(),
}));

vi.mock("../providerUsageSnapshot", () => ({
  loadLocalProviderUsageLines: loadLocalProviderUsageLinesMock,
}));

const context: ProviderUsageContext = {
  homeDir: "",
  env: {},
  platform: "linux",
  nowMs: Date.parse("2026-07-18T12:00:00.000Z"),
};

// Codex is a required entry in the live provider-usage registry.
const originalCodexFetcher = PROVIDER_USAGE_FETCHERS.codex!;

afterEach(() => {
  PROVIDER_USAGE_FETCHERS.codex = originalCodexFetcher;
  loadLocalProviderUsageLinesMock.mockReset();
});

describe("collectProviderUsageSnapshots", () => {
  it("keeps the shared supported-provider list aligned with live fetchers", () => {
    expect([...PROVIDER_USAGE_PROVIDERS].sort()).toEqual(
      Object.keys(PROVIDER_USAGE_FETCHERS).sort(),
    );
  });

  it.each(["antigravity", "grok", "droid", "kilo", "opencode", "pi"] as const)(
    "does not add out-of-scope provider %s",
    async (provider) => {
      const snapshots = await collectProviderUsageSnapshots(context, {
        provider: provider as ProviderKind,
      });

      expect(snapshots).toEqual([]);
    },
  );

  it("skips local archive enrichment when local usage is disabled", async () => {
    const providerUsageLines = [{ label: "Credits", value: "$42.00 remaining" }];
    const providerSnapshot: ServerProviderUsageSnapshot = {
      provider: "codex",
      updatedAt: "2026-07-18T12:00:00.000Z",
      limits: [{ window: "5h", usedPercent: 25 }],
      usageLines: providerUsageLines,
      source: "codex-app-server",
      status: "ok",
    };
    const fetch = vi.fn(async () => providerSnapshot);
    PROVIDER_USAGE_FETCHERS.codex = { provider: "codex", fetch };
    loadLocalProviderUsageLinesMock.mockResolvedValue([{ label: "24h tokens", value: "12,345" }]);

    const snapshots = await collectProviderUsageSnapshots(context, {
      provider: "codex",
      includeLocalUsage: false,
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(loadLocalProviderUsageLinesMock).not.toHaveBeenCalled();
    expect(snapshots).toEqual([providerSnapshot]);
    expect(snapshots[0]?.usageLines).toEqual(providerUsageLines);
  });
});
