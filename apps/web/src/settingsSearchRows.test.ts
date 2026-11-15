// FILE: settingsSearchRows.test.ts
// Purpose: The settings search index is generated from the settings rows themselves, so
//          it cannot drift: this fails when a row is added, renamed, or moved to another
//          page and the generated module was not refreshed.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  extractSettingsSearchRows,
  readSettingsSearchRows,
  SETTINGS_ROW_SOURCES,
} from "../scripts/settingsSearchRows";
import { isSettingsSectionAvailable, SETTINGS_SECTION_IDS } from "./settingsNavigation";
import { ROW_APPLIES, ROW_EXTRA_KEYWORDS, SETTINGS_SEARCH_ENTRIES } from "./settingsSearchIndex";
import { GENERATED_SETTINGS_SEARCH_ROWS } from "./settingsSearchRows.generated";

describe("generated settings search rows", () => {
  it("match the settings rows in the source (run `bun run --cwd apps/web settings-search:generate`)", () => {
    expect(GENERATED_SETTINGS_SEARCH_ROWS).toEqual(readSettingsSearchRows());
  });

  it("are all searchable, each on a real page", () => {
    const targets = new Set(SETTINGS_SEARCH_ENTRIES.map((entry) => entry.target));
    for (const row of GENERATED_SETTINGS_SEARCH_ROWS) {
      expect(SETTINGS_SECTION_IDS).toContain(row.section);
      expect(isSettingsSectionAvailable(row.section, () => true)).toBe(true);
      expect(targets.has(row.target)).toBe(true);
    }
  });

  it("only add synonyms and availability to rows that still exist", () => {
    const rowTargets = new Set(GENERATED_SETTINGS_SEARCH_ROWS.map((row) => row.target));
    for (const target of [...Object.keys(ROW_EXTRA_KEYWORDS), ...Object.keys(ROW_APPLIES)]) {
      expect(rowTargets, target).toContain(target);
    }
  });

  it("give every result a unique id", () => {
    const ids = SETTINGS_SEARCH_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Files with `id="setting-…"` rows that are deliberately not read row by row. */
const NOT_SEARCHED_ROW_FILES: Readonly<Record<string, string>> = {
  "src/components/chat/group/GroupEnvironmentSection.tsx": "a hub's settings, not Settings",
  "src/components/chat/group/GroupGeneralSection.tsx": "a hub's settings, not Settings",
  "src/components/chat/group/GroupMemorySection.tsx": "a hub's settings, not Settings",
  "src/components/settings/AppSnapPermissionSection.tsx": "macOS-only; a page-level result",
  "src/components/settings/ComputerGettingStarted.tsx": "setup steps, not settings",
};

function filesWithSettingAnchors(): string[] {
  const files = readdirSync(path.join(WEB_ROOT, "src"), { recursive: true, encoding: "utf8" });
  return files
    .filter((file) => file.endsWith(".tsx") && !/\.(test|browser)\.tsx$/u.test(file))
    .map((file) => path.join("src", file).split(path.sep).join("/"))
    .filter((file) => readFileSync(path.join(WEB_ROOT, file), "utf8").includes('id="setting-'))
    .toSorted();
}

describe("settings row sources", () => {
  it("list every file that renders an anchored settings row, so none goes unsearchable", () => {
    const listed = new Set(SETTINGS_ROW_SOURCES.map((source) => source.file));
    const unlisted = filesWithSettingAnchors().filter(
      (file) => !listed.has(file) && !(file in NOT_SEARCHED_ROW_FILES),
    );
    expect(unlisted).toEqual([]);
  });
});

describe("extractSettingsSearchRows", () => {
  const source = {
    file: "Fixture.tsx",
    owners: { renderGeneralPanel: "general", LayoutPanel: "layout" },
    ignore: ["setting-transient"],
  } as const;

  it("reads rows, toggles, and boolean setting rows with their page", () => {
    const rows = extractSettingsSearchRows(
      `
      const renderGeneralPanel = () => (
        <>
          <SettingsRow id="setting-a" title="settings:a" description="settings:aDescription" />
          <BooleanSettingRow {...binding} id="setting-b" settingKey="b" title="settings:b" description={t("settings:bDescription")} />
          <SettingsRow id="setting-transient" title="settings:x" description="settings:y" />
        </>
      );
      function LayoutPanel() {
        return <SettingsToggleItem id="setting-c" title="settings:c" description={busy ? "settings:busy" : "settings:idle"} control={null} />;
      }
      `,
      source,
    );
    expect(rows).toEqual([
      {
        target: "setting-a",
        section: "general",
        title: "settings:a",
        description: "settings:aDescription",
      },
      {
        target: "setting-b",
        section: "general",
        title: "settings:b",
        description: "settings:bDescription",
      },
      { target: "setting-c", section: "layout", title: "settings:c", description: "settings:idle" },
    ]);
  });

  it("refuses a row on a page nobody mapped, so it cannot go unsearchable", () => {
    expect(() =>
      extractSettingsSearchRows(
        `function NewPanel() { return <SettingsRow id="setting-new" title="settings:n" description="settings:d" />; }`,
        source,
      ),
    ).toThrow(/setting-new.*outside every mapped owner/u);
  });
});
