import { DEFAULT_SERVER_SETTINGS_VIEW } from "@synara/contracts";
import { deriveProviderInstances } from "@synara/shared/providerInstances";
import { describe, expect, it } from "vitest";
import {
  MAX_RAIL_USAGE_ACCOUNTS,
  RAIL_USAGE_LOW_THRESHOLD,
  getRailUsageAccounts,
  railUsageState,
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
    ).toEqual(added);
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
    ).toEqual(["codex", "claude_work", "cursor"]);
    expect(selectedIds(["codex", "claudeAgent", "cursor", "antigravity", "grok"])).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "antigravity",
    ]);
    expect(MAX_RAIL_USAGE_ACCOUNTS).toBe(4);
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
    const full = ["codex", "claudeAgent", "cursor", "claude_work"];
    expect(toggleRailUsageAccount(full, "grok", true, available)).toEqual(full);
    expect(toggleRailUsageAccount(full.slice(0, 3), "grok", true, available)).toEqual([
      ...full.slice(0, 3),
      "grok",
    ]);
  });
});

describe("railUsageState", () => {
  it.each([
    ["no reading", undefined, "empty"],
    ["0%", 0, "exhausted"],
    ["1%", 1, "low"],
    [`${RAIL_USAGE_LOW_THRESHOLD}%`, RAIL_USAGE_LOW_THRESHOLD, "low"],
    [`${RAIL_USAGE_LOW_THRESHOLD + 1}%`, RAIL_USAGE_LOW_THRESHOLD + 1, "normal"],
    ["100%", 100, "normal"],
  ] as const)("%s remaining reads as %s", (_label, remaining, state) => {
    expect(railUsageState(remaining)).toBe(state);
  });

  it("treats a missing reading as empty rather than nothing left", () => {
    expect(railUsageState(undefined)).toBe("empty");
    expect(railUsageState(0)).toBe("exhausted");
  });
});
