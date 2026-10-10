// FILE: SettingsSidebarNav.test.tsx
// Purpose: Guards the settings sidebar search surface and its ranking index.
// Layer: Component rendering tests
// Depends on: SettingsSidebarNav, the settings search index, and React server rendering.

import { describe, expect, it } from "vitest";

import { settingRowAnchorId } from "../settingsNavigation";
import {
  SETTINGS_SEARCH_ENTRIES,
  rankSettingsSearchEntries,
  settingsSearchEntryTarget,
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

  it("respects the result limit", () => {
    expect(rankSettingsSearchEntries("e", 3)).toHaveLength(3);
  });

  it("derives a deep-link anchor target from each entry's title", () => {
    const themeEntry = SETTINGS_SEARCH_ENTRIES.find((entry) => entry.id === "appearance:theme")!;
    expect(settingsSearchEntryTarget(themeEntry)).toBe("setting-theme");
    for (const entry of SETTINGS_SEARCH_ENTRIES) {
      if (entry.target === null) {
        expect(settingsSearchEntryTarget(entry)).toBeNull();
      } else {
        expect(settingsSearchEntryTarget(entry)).toBe(settingRowAnchorId(entry.title));
        expect(settingsSearchEntryTarget(entry)?.startsWith("setting-")).toBe(true);
      }
    }
  });

  it("finds the Behavior and Providers rows by their titles", () => {
    const titles = (query: string) =>
      rankSettingsSearchEntries(query, 12).map((entry) => entry.title);
    expect(titles("dictating")).toContain("Enter while dictating");
    expect(titles("diff colors")).toContain("Pull request diff colors");
    expect(titles("enabled providers")).toContain("Enabled providers");
  });

  it("finds the Fold finished turns and Wait for subagents rows", () => {
    const sections = (query: string) =>
      rankSettingsSearchEntries(query, 12).map((entry) => `${entry.section}:${entry.title}`);
    expect(sections("fold")).toContain("behavior:Fold finished turns");
    expect(sections("worked for")).toContain("behavior:Fold finished turns");
    expect(sections("subagents")).toContain("notifications:Wait for subagents");
    const targets = (query: string) =>
      rankSettingsSearchEntries(query, 12).map((entry) => settingsSearchEntryTarget(entry));
    expect(targets("fold")).toContain("setting-fold-finished-turns");
    expect(targets("subagents")).toContain("setting-wait-for-subagents");
  });

  it("deep-links the provider picker result to the Available CLIs row", () => {
    const [top] = rankSettingsSearchEntries("picker order", 12);
    expect(top?.title).toBe("Available CLIs");
    expect(settingsSearchEntryTarget(top!)).toBe("setting-available-clis");
  });
});
