// FILE: SettingsSidebarNav.test.tsx
// Purpose: Guards the settings sidebar search surface and its ranking index.
// Layer: Component rendering tests
// Depends on: SettingsSidebarNav, the settings search index, and React server rendering.

import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach } from "vitest";
import { setLanguagePreference, t } from "../i18n";
import { SettingsRow } from "./settings/SettingsPanelPrimitives";

import {
  SETTINGS_SEARCH_ENTRIES,
  rankSettingsSearchEntries,
  settingsSearchEntryTarget,
} from "../settingsSearchIndex";

afterEach(() => setLanguagePreference("system"));

describe("localized settings", () => {
  it("renders Chinese labels while retaining explicit navigation targets", () => {
    setLanguagePreference("zh-CN");
    const html = renderToStaticMarkup(
      <SettingsRow
        id="setting-default-provider"
        title="settings:changed_defaultProvider"
        description="settings:chooseTheProviderUsedForNewChatsAgentCodex"
      />,
    );
    expect(html).toContain('id="setting-default-provider"');
    expect(html).toContain("默认提供商");
    expect(html).toContain("选择新聊天使用的提供商");
  });

  it("finds English settings in every interface locale and Chinese settings in Chinese with stable links", () => {
    for (const language of ["en", "zh-CN", "es"] as const) {
      setLanguagePreference(language);
      const queries =
        language === "zh-CN" ? ["default provider", "默认提供商"] : ["default provider"];
      for (const query of queries) {
        const [result] = rankSettingsSearchEntries(query, 12);
        expect(result?.id).toBe("general:default-provider");
        expect(settingsSearchEntryTarget(result!)).toBe("setting-default-provider");
      }
      const languageQueries = language === "zh-CN" ? ["language", "语言"] : ["language"];
      for (const query of languageQueries) {
        const [result] = rankSettingsSearchEntries(query, 12);
        expect(result?.id).toBe("general:language");
        expect(settingsSearchEntryTarget(result!)).toBe("setting-language");
      }
    }
  });
});

describe("rankSettingsSearchEntries", () => {
  beforeEach(() => setLanguagePreference("en"));
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

  it("indexes the stacked and split diff layout preference", () => {
    const results = rankSettingsSearchEntries("stacked", 12);
    expect(results.some((entry) => entry.id === "behavior:diff-layout")).toBe(true);
  });

  it("surfaces every row in a section when searching the section label", () => {
    const results = rankSettingsSearchEntries("appearance", SETTINGS_SEARCH_ENTRIES.length);
    expect(results.some((entry) => entry.section === "appearance")).toBe(true);
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

  it("finds the Behavior and Providers rows by their titles", () => {
    const titles = (query: string) =>
      rankSettingsSearchEntries(query, 12).map((entry) => t(entry.title));
    expect(titles("dictating")).toContain("Enter while dictating");
    expect(titles("diff colors")).toContain("Pull request diff colors");
    expect(titles("enabled providers")).toContain("Enabled providers");
  });

  it("finds the Fold finished turns and Wait for subagents rows", () => {
    const sections = (query: string) =>
      rankSettingsSearchEntries(query, 12).map((entry) => `${entry.section}:${t(entry.title)}`);
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
    expect(top && t(top.title)).toBe("Available CLIs");
    expect(settingsSearchEntryTarget(top!)).toBe("setting-available-clis");
  });
});
