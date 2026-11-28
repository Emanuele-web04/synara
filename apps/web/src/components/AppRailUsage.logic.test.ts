import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  ProviderInstanceId,
  type ServerUsageHub,
} from "@synara/contracts";
import { deriveProviderInstances } from "@synara/shared/providerInstances";
import { describe, expect, it } from "vitest";
import { resolveEnvironmentProviderUsageSummary } from "./chat/environment/EnvironmentUsageSection.logic";

import { deriveProviderUsageDisplayRows } from "~/lib/providerUsageDisplay";

import {
  MAX_RAIL_USAGE_ACCOUNTS,
  getRailUsageAccounts,
  getRailUsageHubAccounts,
  railUsageRingTone,
  selectRailUsageRows,
  resolveRailUsageAccounts,
  retainSavedRailUsageIds,
  toggleRailUsageAccount,
} from "./AppRailUsage.logic";

const id = (value: string) => ProviderInstanceId.makeUnsafe(value);
const hub = (accounts: ServerUsageHub["accounts"], error?: string): ServerUsageHub => ({
  id: "hub-1",
  label: "Home hub",
  url: "https://hub.example.ts.net:8318",
  checkedAt: "2026-11-26T12:00:00.000Z",
  accounts,
  ...(error ? { error } : {}),
});

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
    resolveRailUsageAccounts(selected, accounts).map((account) => account.id);

  it("filters globally disabled accounts before the cap while preserving saved choices", () => {
    const visible = getRailUsageAccounts(deriveProviderInstances(DEFAULT_SERVER_SETTINGS_VIEW), [
      "codex",
      "claudeAgent",
    ]);
    const saved = ["codex", "claudeAgent"];
    expect(
      resolveRailUsageAccounts([...saved, "opencode"], visible).map((account) => account.id),
    ).toEqual(["opencode"]);
    const added = toggleRailUsageAccount(saved, "opencode", true, visible);
    expect(added).toEqual(["codex", "claudeAgent", "opencode"]);
    expect(toggleRailUsageAccount(added, "opencode", false, visible)).toEqual(saved);
    expect(resolveRailUsageAccounts(added, accounts).map((account) => account.id)).toEqual(saved);
  });

  it("allows two accounts of the same provider and distinguishes their names", () => {
    const selected = resolveRailUsageAccounts(["claudeAgent", "claude_work"], accounts);
    expect(selected.map((account) => account.label)).toEqual([
      "Claude · Default account",
      "Claude · Work",
    ]);
    expect(selected.map((account) => account.id)).toEqual(["claudeAgent", "claude_work"]);
  });

  it("offers hub accounts beside local ones and shares the cap", () => {
    const usage = (provider: "codex" | "claudeAgent", key: string) => ({
      provider,
      instanceId: ProviderInstanceId.makeUnsafe(key),
      updatedAt: "2026-11-26T12:00:00.000Z",
      limits: [],
      usageLines: [],
      source: "usage-hub",
      status: "ok" as const,
    });
    const hubs: ServerUsageHub[] = [
      {
        id: "hub-1",
        label: "Home hub",
        url: "https://hub.example.ts.net:8318",
        checkedAt: "2026-11-26T12:00:00.000Z",
        accounts: [
          {
            id: "codex-a.json",
            key: ProviderInstanceId.makeUnsafe("hub_a"),
            email: "alpha@example.com",
            usage: usage("codex", "hub_a"),
          },
          {
            id: "claude-b.json",
            key: ProviderInstanceId.makeUnsafe("hub_b"),
            usage: usage("claudeAgent", "hub_b"),
          },
        ],
      },
    ];
    const hubAccounts = getRailUsageHubAccounts(hubs);
    // Hub rings carry no account dot; the hover card names the hub.
    expect(hubAccounts.every((account) => !account.dotted && !account.accentColor)).toBe(true);
    expect(hubAccounts.map((account) => [account.id, account.label])).toEqual([
      ["hub_a", "Codex · alpha@example.com (Home hub)"],
      ["hub_b", "Claude · claude-b.json (Home hub)"],
    ]);
    expect(getRailUsageHubAccounts(hubs, ["codex"]).map((account) => account.id)).toEqual([
      "hub_b",
    ]);
    const all = [...accounts, ...hubAccounts];
    expect(
      resolveRailUsageAccounts(["hub_b", "codex", "hub_a"], all).map((account) => account.id),
    ).toEqual(["hub_b", "codex"]);
    expect(toggleRailUsageAccount(["hub_b", "codex"], "hub_a", true, all)).toEqual([
      "hub_b",
      "codex",
    ]);
  });

  it("keeps saved hub rings through outages and disabled providers", () => {
    const codexHubAccount = {
      id: "codex-a.json",
      key: id("hub_a"),
      usage: {
        provider: "codex" as const,
        instanceId: id("hub_a"),
        updatedAt: "2026-11-26T12:00:00.000Z",
        limits: [],
        usageLines: [],
        source: "usage-hub",
      },
    };
    const saved = [id("codex"), id("hub_a"), id("hub_gone"), id("removed")];
    const local = new Set([id("codex")]);
    // Not loaded yet, or a hub is unreachable: no hub id can be judged deleted.
    expect(retainSavedRailUsageIds(saved, local, undefined)).toEqual([
      "codex",
      "hub_a",
      "hub_gone",
    ]);
    expect(retainSavedRailUsageIds(saved, local, [hub([], "Could not reach the hub.")])).toEqual([
      "codex",
      "hub_a",
      "hub_gone",
    ]);
    // Read cleanly: ids the hub still lists stay, even though the hub is a Codex account
    // and the selection is judged without the disabled-provider filter.
    expect(retainSavedRailUsageIds(saved, local, [hub([codexHubAccount])])).toEqual([
      "codex",
      "hub_a",
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

  it("describes quota rows while preserving canonical window selection", () => {
    const selected = selectRailUsageRows(rows, null, "both");
    expect(selected.map((row) => row.label)).toEqual(["Weekly", "5h"]);
    const summary = resolveEnvironmentProviderUsageSummary({
      providerName: "Codex",
      rows: selected,
      snapshot: undefined,
      hasUsageLines: true,
    });
    expect(summary.rows).toBe(selected);
    expect(rows.map((row) => row.label)).toEqual(["5h", "Weekly"]);
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
