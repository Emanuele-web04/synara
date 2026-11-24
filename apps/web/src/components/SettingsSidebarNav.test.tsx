// FILE: SettingsSidebarNav.test.tsx
// Purpose: Guards the settings sidebar search surface and its ranking index.
// Layer: Component rendering tests
// Depends on: SettingsSidebarNav, the settings search index, and React server rendering.

import { describe, expect, it } from "vitest";

import {
  SETTINGS_SEARCH_ENTRIES,
  rankSettingsSearchEntries,
  settingsSearchEntryTarget,
  settingsSearchEntryTitle,
} from "../settingsSearchIndex";

describe("rankSettingsSearchEntries", () => {
  it("returns nothing for an empty query", () => {
    expect(rankSettingsSearchEntries("", 12)).toHaveLength(0);
    expect(rankSettingsSearchEntries("   ", 12)).toHaveLength(0);
  });

  it("ranks an exact title match first", () => {
    const [top] = rankSettingsSearchEntries("theme", 12);
    expect(top?.id).toBe("appearance:theme");
  });

  it("matches on description keywords, not just titles", () => {
    const results = rankSettingsSearchEntries("wrap", 12);
    expect(results.some((entry) => entry.id === "behavior:diff-line-wrapping")).toBe(true);
  });

  it("surfaces every row in a section when searching the section label", () => {
    const results = rankSettingsSearchEntries("appearance", SETTINGS_SEARCH_ENTRIES.length);
    expect(results.some((entry) => entry.section === "appearance")).toBe(true);
  });

  it("omits desktop-only Appearance controls in a browser", () => {
    const results = rankSettingsSearchEntries("appearance", SETTINGS_SEARCH_ENTRIES.length);
    const targets = results.map(settingsSearchEntryTarget);
    expect(targets).toContain("setting-base-font-size");
    expect(targets).not.toContain("setting-app-icon");
    expect(targets).not.toContain("setting-use-custom-title-bar");
  });

  it("finds the agent keep-awake row only when the server supports it", () => {
    const targets = (keepAwakeAvailable: boolean) =>
      rankSettingsSearchEntries("keep computer awake", SETTINGS_SEARCH_ENTRIES.length, {
        keepAwakeAvailable,
      }).map(settingsSearchEntryTarget);
    expect(targets(false)).not.toContain("setting-keep-computer-awake");
    expect(targets(true)).toContain("setting-keep-computer-awake");
  });

  it("respects the result limit", () => {
    expect(rankSettingsSearchEntries("e", 3)).toHaveLength(3);
  });

  it("uses explicit stable targets independently of translated titles", () => {
    const themeEntry = SETTINGS_SEARCH_ENTRIES.find((entry) => entry.id === "appearance:theme")!;
    expect(settingsSearchEntryTarget(themeEntry)).toBe("setting-theme");
    for (const entry of SETTINGS_SEARCH_ENTRIES) {
      if (entry.target == null) {
        expect(settingsSearchEntryTarget(entry)).toBeNull();
      } else {
        expect(settingsSearchEntryTarget({ ...entry, title: "重命名的设置" })).toBe(
          settingsSearchEntryTarget(entry),
        );
        expect(settingsSearchEntryTarget(entry)?.startsWith("setting-")).toBe(true);
      }
    }
  });
});

describe("account search", () => {
  const context = {
    accounts: [
      {
        instanceId: "codex_work",
        label: "Work",
        providerLabel: "Codex",
        identity: "alex@acme.dev · Acme Labs",
      },
      { instanceId: "claudeAgent", label: "Personal", providerLabel: "Claude", identity: null },
    ],
  };

  it("leads with the Accounts page for account, sign-in, and login queries", () => {
    for (const query of ["account", "sign in", "login", "second account"]) {
      const results = rankSettingsSearchEntries(query, 12, context);
      expect(results.some((entry) => entry.id === "accounts:accounts")).toBe(true);
    }
  });

  it("finds each account by name, email, or agent and opens its row", () => {
    const [byEmail] = rankSettingsSearchEntries("acme.dev", 12, context);
    expect(byEmail?.id).toBe("accounts:account:codex_work");
    expect(settingsSearchEntryTitle(byEmail!)).toBe("Codex · Work");
    expect(settingsSearchEntryTarget(byEmail!)).toBe("setting-account-codex-work");
    const byAgent = rankSettingsSearchEntries("claude personal", 12, context);
    expect(byAgent.some((entry) => entry.id === "accounts:account:claudeAgent")).toBe(true);
  });
});
