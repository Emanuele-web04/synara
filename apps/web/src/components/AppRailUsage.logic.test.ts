import { DEFAULT_SERVER_SETTINGS_VIEW } from "@synara/contracts";
import { deriveProviderInstances } from "@synara/shared/providerInstances";
import { describe, expect, it } from "vitest";

import { deriveProviderUsageDisplayRows } from "~/lib/providerUsageDisplay";

import {
  MAX_RAIL_USAGE_ACCOUNTS,
  getRailUsageAccounts,
  railUsageRingTone,
  selectRailUsageRows,
  resolveRailUsageAccounts,
  toggleRailUsageAccount,
} from "./AppRailUsage.logic";

describe("rail usage accounts", () => {
  const accounts = getRailUsageAccounts(
    deriveProviderInstances({
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      providerInstances: {
        claude_work: { driver: "claudeAgent", displayName: "Work" },
        claude_disabled: { driver: "claudeAgent", enabled: false },
      },
    }),
  );
  const selectedIds = (selected: readonly string[]) =>
    resolveRailUsageAccounts(selected, accounts).map((account) => account.instance.instanceId);

  it("filters globally disabled accounts before the cap while preserving saved choices", () => {
    const visible = getRailUsageAccounts(deriveProviderInstances(DEFAULT_SERVER_SETTINGS_VIEW), [
      "codex",
      "claudeAgent",
    ]);
    const saved = ["codex", "claudeAgent"];
    expect(
      resolveRailUsageAccounts([...saved, "opencode"], visible).map(
        (account) => account.instance.instanceId,
      ),
    ).toEqual(["opencode"]);
    const added = toggleRailUsageAccount(saved, "opencode", true, visible);
    expect(added).toEqual(["codex", "claudeAgent", "opencode"]);
    expect(toggleRailUsageAccount(added, "opencode", false, visible)).toEqual(saved);
    expect(
      resolveRailUsageAccounts(added, accounts).map((account) => account.instance.instanceId),
    ).toEqual(saved);
  });

  it("allows two accounts of the same provider and distinguishes their names", () => {
    const selected = resolveRailUsageAccounts(["claudeAgent", "claude_work"], accounts);
    expect(selected.map((account) => account.label)).toEqual([
      "Claude · Default account",
      "Claude · Work",
    ]);
    expect(selected.map((account) => account.instance.instanceId)).toEqual([
      "claudeAgent",
      "claude_work",
    ]);
  });

  it("drops duplicate, removed, and disabled accounts before applying the cap", () => {
    expect(
      selectedIds(["removed", "claude_disabled", "codex", "codex", "claude_work", "cursor"]),
    ).toEqual(["codex", "claude_work"]);
    expect(selectedIds(["codex", "claudeAgent", "claude_work"]).length).toBe(
      MAX_RAIL_USAGE_ACCOUNTS,
    );
    expect(selectedIds([])).toEqual([]);
  });

  it("keeps single-account provider labels and default account routing", () => {
    expect(resolveRailUsageAccounts(["codex"], accounts)[0]?.label).toBe("Codex");
    expect(selectedIds(["codex", "claudeAgent"])).toEqual(["codex", "claudeAgent"]);
  });
});

describe("toggleRailUsageAccount", () => {
  const available = getRailUsageAccounts(
    deriveProviderInstances({
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      providerInstances: { claude_work: { driver: "claudeAgent" } },
    }),
  );
  it("adds a second Claude account while there is room and removes it again", () => {
    expect(toggleRailUsageAccount(["claudeAgent"], "claude_work", true, available)).toEqual([
      "claudeAgent",
      "claude_work",
    ]);
    expect(
      toggleRailUsageAccount(["claudeAgent", "claude_work"], "claudeAgent", false, available),
    ).toEqual(["claude_work"]);
  });

  it("ignores another account past the cap", () => {
    expect(
      toggleRailUsageAccount(["claudeAgent", "claude_work"], "codex", true, available),
    ).toEqual(["claudeAgent", "claude_work"]);
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
