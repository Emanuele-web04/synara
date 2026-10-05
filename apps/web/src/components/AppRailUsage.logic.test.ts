import { describe, expect, it } from "vitest";

import { deriveProviderUsageDisplayRows } from "~/lib/providerUsageDisplay";

import {
  MAX_RAIL_USAGE_PROVIDERS,
  railUsageRingTone,
  selectRailUsageRows,
  resolveRailUsageProviders,
  toggleRailUsageProvider,
} from "./AppRailUsage.logic";

describe("resolveRailUsageProviders", () => {
  it("ignores disabled selections before applying the visible provider cap", () => {
    expect(
      resolveRailUsageProviders(["codex", "claudeAgent", "opencode"], ["codex", "claudeAgent"]),
    ).toEqual(["opencode"]);
  });
  it("drops duplicates and caps the selection", () => {
    const resolved = resolveRailUsageProviders(["codex", "codex", "claudeAgent", "cursor"]);
    expect(resolved).toEqual(["codex", "claudeAgent"]);
    expect(resolved.length).toBeLessThanOrEqual(MAX_RAIL_USAGE_PROVIDERS);
  });
});

describe("toggleRailUsageProvider", () => {
  it("preserves disabled selections while adding and removing visible providers", () => {
    const saved = ["codex", "claudeAgent"] as const;
    const added = toggleRailUsageProvider(saved, "opencode", true, saved);
    expect(added).toEqual(["codex", "claudeAgent", "opencode"]);
    expect(toggleRailUsageProvider(added, "opencode", false, saved)).toEqual(saved);
    expect(resolveRailUsageProviders(added)).toEqual(saved);
  });
  it("adds a provider while there is room and removes it again", () => {
    expect(toggleRailUsageProvider(["codex"], "claudeAgent", true)).toEqual([
      "codex",
      "claudeAgent",
    ]);
    expect(toggleRailUsageProvider(["codex", "claudeAgent"], "codex", false)).toEqual([
      "claudeAgent",
    ]);
  });

  it("ignores a provider past the cap", () => {
    expect(toggleRailUsageProvider(["codex", "claudeAgent"], "cursor", true)).toEqual([
      "codex",
      "claudeAgent",
    ]);
  });
});

describe("selectRailUsageRows", () => {
  const rowsFor = (...windows: ReadonlyArray<string>) =>
    deriveProviderUsageDisplayRows([
      {
        provider: "codex",
        updatedAt: "2026-10-02T12:00:00.000Z",
        limits: windows.map((window) => ({ window, usedPercent: 60 })),
      },
    ]);
  const rows = rowsFor("5h", "Weekly");
  const labels = (...args: Parameters<typeof selectRailUsageRows>) =>
    selectRailUsageRows(...args).map((row) => row.label);

  it("draws weekly outside five-hour, or only the chosen window", () => {
    expect(labels(rows, null, "both")).toEqual(["Weekly", "5h"]);
    expect(labels(rows, null, "fiveHour")).toEqual(["5h"]);
    expect(labels(rows, null, "weekly")).toEqual(["Weekly"]);
  });

  it("falls back to the other account window, then to the primary row", () => {
    const weeklyOnly = rows.filter((row) => row.label === "Weekly");
    expect(labels(weeklyOnly, null, "fiveHour")).toEqual(["Weekly"]);
    const monthly = rowsFor("Monthly");
    expect(labels(monthly, monthly[0] ?? null, "weekly")).toEqual(["Monthly"]);
    expect(labels([], null, "both")).toEqual([]);
  });
});

describe("railUsageRingTone", () => {
  it.each([
    [100, "healthy"],
    [51, "healthy"],
    [50, "fair"],
    [26, "fair"],
    [25, "low"],
    [11, "low"],
    [10, "critical"],
    [0, "critical"],
  ] as const)("%i%% left is %s", (remaining, tone) => {
    expect(railUsageRingTone(remaining)).toBe(tone);
  });
});
