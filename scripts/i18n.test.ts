import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inspectUiSource, loadCatalogs, validateCatalogs, type Catalogs } from "./i18n";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function catalogFixture(): Catalogs {
  return {
    en: {
      common: {
        open: "Open {{name}} with Codex",
        files_one: "{{count}} file",
        files_other: "{{count}} files",
      },
    },
    "zh-CN": {
      common: {
        open: "使用 Codex 打开{{name}}",
        files_one: "{{count}} 个文件",
        files_other: "{{count}} 个文件",
      },
    },
    es: {
      common: {
        open: "Abrir {{name}} con Codex",
        files_one: "{{count}} archivo",
        files_other: "{{count}} archivos",
      },
    },
  };
}

describe("localization catalog validation", () => {
  it("allows only explicitly supplied, balanced React slots and rejects catalog attributes", () => {
    const catalogs: Catalogs = {
      en: { settings: { description: "Run <command>{{command}}</command>." } },
      "zh-CN": { settings: { description: "运行 <command>{{command}}</command>。" } },
    };
    const slots = { "settings:description": ["command"] };
    expect(validateCatalogs(catalogs, ["en", "zh-CN"], slots)).toEqual([]);
    catalogs["zh-CN"]!.settings!.description =
      '<command onclick="run()">{{command}}</command><strong>运行</strong>';
    expect(validateCatalogs(catalogs, ["en", "zh-CN"], slots).map(({ code }) => code)).toEqual([
      "rich-slot-attributes",
      "rich-slot-parity",
      "unknown-rich-slot",
      "unknown-rich-slot",
    ]);
    catalogs["zh-CN"]!.settings!.description = "<command>{{command}}";
    expect(validateCatalogs(catalogs, ["en", "zh-CN"], slots).map(({ code }) => code)).toEqual([
      "rich-slot-nesting",
      "rich-slot-parity",
    ]);
  });
  it("accepts matching namespaces and preserves repeated interpolation values", () => {
    const catalogs = catalogFixture();
    catalogs.en!.common!.repeated = "{{name}}: reopen {{name}}";
    catalogs["zh-CN"]!.common!.repeated = "{{name}}：重新打开{{name}}";
    catalogs.es!.common!.repeated = "{{name}}: volver a abrir {{name}}";
    expect(validateCatalogs(catalogs, ["en", "zh-CN", "es"])).toEqual([]);
    catalogs["zh-CN"]!.common!.repeated = "重新打开{{name}}";
    expect(validateCatalogs(catalogs, ["en", "zh-CN", "es"])).toEqual([
      expect.objectContaining({
        code: "interpolation",
        file: "zh-CN/common.json",
        key: "repeated",
      }),
    ]);
  });

  it("reports missing and extra keys/namespaces, empty values, and changed protected identifiers", () => {
    const catalogs = catalogFixture();
    delete catalogs.es!.common!.files_one;
    catalogs.es!.extra = { message: "Hola" };
    catalogs["zh-CN"]!.common!.extra = "多余";
    catalogs["zh-CN"]!.common!.files_one = " ";
    catalogs["zh-CN"]!.common!.open = "用其他工具打开{{name}}";
    catalogs.en!.settings = { title: "Settings" };
    const errors = validateCatalogs(catalogs, ["en", "zh-CN", "es"]);
    expect(errors.map(({ code, file, key }) => ({ code, file, key }))).toEqual([
      { code: "missing-key", file: "es/common.json", key: "files_one" },
      { code: "extra-namespace", file: "es/extra.json", key: undefined },
      { code: "missing-namespace", file: "es/settings.json", key: undefined },
      { code: "extra-key", file: "zh-CN/common.json", key: "extra" },
      { code: "empty-value", file: "zh-CN/common.json", key: "files_one" },
      { code: "interpolation", file: "zh-CN/common.json", key: "files_one" },
      { code: "protected-token", file: "zh-CN/common.json", key: "open" },
      { code: "missing-namespace", file: "zh-CN/settings.json", key: undefined },
    ]);
  });

  it("rejects malformed JSON, duplicate keys, nested objects, and non-string values without rewriting files", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "synara-i18n-"));
    temporaryDirectories.push(directory);
    mkdirSync(path.join(directory, "en"));
    const files = {
      "duplicate.json": '{"open":"Open","open":"Reopen"}',
      "invalid.json": '{"open":',
      "nested.json": '{"nested":{"message":"Open"},"count":3}',
      "array.json": '["Open"]',
    };
    for (const [file, contents] of Object.entries(files))
      writeFileSync(path.join(directory, "en", file), contents);
    const first = loadCatalogs(directory, ["en", "zh-CN"]);
    const second = loadCatalogs(directory, ["en", "zh-CN"]);
    expect(second).toEqual(first);
    expect(first.errors.map(({ code }) => code)).toEqual([
      "invalid-catalog",
      "duplicate-key",
      "invalid-json",
      "invalid-value",
      "invalid-value",
    ]);
    for (const [file, contents] of Object.entries(files))
      expect(readFileSync(path.join(directory, "en", file), "utf8")).toBe(contents);
  });

  it("protects executable examples and environment identifiers inside translated prose", () => {
    const en = { command: "Run `codex login` with SYNARA_HOME." };
    expect(
      validateCatalogs(
        {
          en: { common: en },
          "zh-CN": { common: { command: "在 SYNARA_HOME 中运行 `codex login`。" } },
        },
        ["en", "zh-CN"],
      ),
    ).toEqual([]);
    expect(
      validateCatalogs(
        { en: { common: en }, "zh-CN": { common: { command: "运行 `codex 登录`。" } } },
        ["en", "zh-CN"],
      ).map(({ code }) => code),
    ).toEqual(["protected-token", "protected-token"]);
  });
});

describe("localization source inspection", () => {
  it("requires explicit locales for web date and number formatting without flagging explicit technical locales or source examples", () => {
    const source = `
      count.toLocaleString();
      date.toLocaleDateString(undefined, { weekday: "long" });
      date.toLocaleTimeString();
      date["toLocaleString"](void 0);
      count.toLocaleString(formatLocale);
      date.toLocaleDateString("en-US");
      date.toLocaleTimeString(getFormatLocale());
      const sourceExample = "date.toLocaleString()";
      // date.toLocaleString();
    `;
    const inspection = inspectUiSource("apps/web/src/example.ts", source, catalogFixture().en!);
    expect(inspection.literals).toEqual([
      expect.objectContaining({ code: "implicit-format-locale", line: 2 }),
      expect.objectContaining({ code: "implicit-format-locale", line: 3 }),
      expect.objectContaining({ code: "implicit-format-locale", line: 4 }),
      expect.objectContaining({ code: "implicit-format-locale", line: 5 }),
    ]);
    expect(inspection.errors).toEqual([]);
    expect(
      inspectUiSource("apps/desktop/src/example.ts", source, catalogFixture().en!).literals,
    ).toEqual([]);
  });

  it.each([
    {
      file: "apps/web/src/components/Sidebar.tsx",
      source: `
        renderListSectionHeader("Projects", toolbar);
        renderListSectionHeader(userSectionName, toolbar);
        renderListSectionHeader(t("common:open"), toolbar);
      `,
      copy: ["Projects"],
    },
    {
      file: "apps/web/src/components/settings/ExternalMcpSettingsPanel.tsx",
      source: `
        function formatDate(value) {
          if (value === "missing") return "Never";
          console.log("diagnostic output");
          return t("common:open");
        }
        copyWithToast("raw clipboard content", "Configuration copied");
        function protocolValue() { return "Protocol response"; }
      `,
      copy: ["Never", "Configuration copied"],
    },
    {
      file: "apps/web/src/components/chat/ComposerSlashStatusDialog.tsx",
      source: `
        function formatRateLimitMessage(status) {
          const suffix = \` Resets at \${resetAt}.\`;
          if (status === "rejected") return \`Rate limit reached.\${suffix}\`;
          return translate("common:open");
        }
        function formatEnvironmentLabel(mode) { return mode === "local" ? "Local" : "Worktree"; }
      `,
      copy: ["Resets at .", "Rate limit reached.", "Local"],
    },
    {
      file: "apps/web/src/lib/composerPastedText.ts",
      source: `
        function formatPastedTextCountLabel(count) { return \`\${count} lines\`; }
        function pastedTextTitle(text, fallback = "Pasted text") { return text || fallback; }
        function buildPastedTextBlock(text) { return \`<pasted_text>\${text}</pasted_text>\`; }
      `,
      copy: ["lines"],
    },
    {
      file: "apps/web/src/lib/runningChatsQuitConfirmation.ts",
      source: `
        function runningChatsQuitCopy(chats, appName = "Synara") {
          return {
            title: chats.length ? "Chats are still running" : \`Quit \${appName}?\`,
            description: \`Work will stop when \${appName} closes.\`,
            resumeLabel: "Resume chats automatically",
            stayLabel: "Cancel",
            quitLabel: "Quit",
          };
        }
        function quitResumeContinuationPrompt(appName = "Synara") {
          return \`\${appName} was closed. Continue where you left off.\`;
        }
      `,
      copy: [
        "Chats are still running",
        "Quit ?",
        "Work will stop when closes.",
        "Resume chats automatically",
        "Cancel",
        "Quit",
      ],
    },
  ])(
    "finds display text from known presentation helpers in $file without scanning adjacent data",
    ({ file, source, copy }) => {
      const inspection = inspectUiSource(file, source, catalogFixture().en!);
      expect(inspection.literals.map(({ message }) => message)).toEqual(
        copy.map((value) => `Untranslated UI candidate: ${JSON.stringify(value)}`),
      );
      expect(inspection.errors).toEqual([]);
    },
  );

  it("derives permitted rich slots from explicit React components rather than accepting catalog HTML", () => {
    const source =
      '<Translation message="common:open" values={{ name }} components={{ command: <code />, link: <a href="/help" /> }} />';
    const inspection = inspectUiSource("example.tsx", source, catalogFixture().en!);
    expect(inspection.slots).toEqual({ "common:open": ["command", "link"] });
    expect(inspection.literals).toEqual([]);
  });

  it("finds copy passed to known settings helpers and UI metadata without scanning arbitrary log records", () => {
    const source = `
      renderBooleanSettingRow({ description: "Show actions in the chat", ariaLabel: "Show actions" });
      const RAIL_PANEL_ITEM_LABELS = { home: "Home", spaces: "Spaces" };
      const DEVICE_RAIL_GROUPS = [{ items: [{ id: "home", label: "Home" }] }];
      const SETTINGS_SEARCH_ENTRIES = [{ title: "Default provider", keywords: "agent provider" }];
      const chipProps = { label: fileName, closeLabel: \`Close \${fileName}\` } satisfies ComponentProps<typeof SurfaceTabChip>;
      logger.log({ description: "diagnostic output", label: "provider data" });
      const userContent = { title: "User title", description: "User content" };
    `;
    const inspection = inspectUiSource("example.tsx", source, catalogFixture().en!);
    expect(inspection.literals.map(({ message }) => message)).toEqual([
      'Untranslated UI candidate: "Show actions in the chat"',
      'Untranslated UI candidate: "Show actions"',
      'Untranslated UI candidate: "Home"',
      'Untranslated UI candidate: "Spaces"',
      'Untranslated UI candidate: "Home"',
      'Untranslated UI candidate: "Default provider"',
      'Untranslated UI candidate: "agent provider"',
      'Untranslated UI candidate: "Close"',
    ]);
  });
  it("accepts retained English aliases only when their paired catalog keys exist", () => {
    const source = `
      const PROJECT_ICON_OPTIONS = [
        { label: "Original alias", labelKey: "common:open", keywords: "English search", keywordsKey: "common:open" },
        { label: "Missing translation", labelKey: "common:missing" },
      ];
      const PROJECT_COLOR_LABELS = { red: "Red", blue: "Blue" };
      const PROJECT_COLOR_LABEL_KEYS = { red: "common:open" };
      const DEVICE_RAIL_GROUPS = [{ items: [{ id: "home", label: "Home" }] }];
      const DEVICE_RAIL_LABEL_KEYS = { home: "common:open" };
      t(DEVICE_RAIL_LABEL_KEYS[item.id]);
    `;
    const inspection = inspectUiSource("example.tsx", source, catalogFixture().en!);
    expect(inspection.literals.map(({ message }) => message)).toEqual([
      'Untranslated UI candidate: "Missing translation"',
      'Untranslated UI candidate: "Blue"',
    ]);
    expect(inspection.errors.map(({ key }) => key)).toEqual(["common:missing"]);
    const withoutConsumer = inspectUiSource(
      "example.tsx",
      source.replace("t(DEVICE_RAIL_LABEL_KEYS[item.id]);", ""),
      catalogFixture().en!,
    );
    expect(withoutConsumer.literals).toContainEqual(
      expect.objectContaining({ message: 'Untranslated UI candidate: "Home"' }),
    );
  });

  it("validates static translator calls and semantic keys passed through UI metadata", () => {
    const source = `
      t("common:open", { name: projectName });
      translate("common:files", { count: 2 });
      sourceTranslate("common:missing");
      const options = [{ title: "common:open" }];
      <Label title="common:missingTitle" />;
      t(selectedKey);
      t(enabled ? "Disable" : "common:open");
      translate(status === "pending" ? (ready ? "common:files" : "common:missingConditional") : rawProviderContent);
    `;
    const inspection = inspectUiSource("example.tsx", source, catalogFixture().en!);
    expect(inspection.references).toEqual([
      "common:files",
      "common:missing",
      "common:missingConditional",
      "common:missingTitle",
      "common:open",
    ]);
    expect(inspection.errors.map(({ key }) => key)).toEqual([
      "common:missing",
      "common:missingTitle",
      "common:missingConditional",
    ]);
    expect(inspection.dynamicCalls).toBe(2);
    expect(inspection.literals).toEqual([
      expect.objectContaining({
        code: "source-string-call",
        message: 'Untranslated UI candidate: "Disable"',
      }),
    ]);
  });

  it("finds untranslated text, UI props, conditional copy, and source-string calls without matching data or comments", () => {
    const source = `
      // <button>Comment example</button>
      const messageFromProvider = "Provider data";
      <section className="min-w-0"><h2>Open project</h2>
        <input placeholder="Choose a project" aria-label={"Project name"} />
        <WorkspaceFilePreviewHeader saveState={saving ? "Saving..." : "Saved"} />
        <OpenInPickerFrame groupLabel={groupLabel ?? "Open in editor"} menuLabel={menuLabel ?? "Editor options"} />
        <button aria-label={\`Close \${panelLabel}\`} />
        <span title={\`\${fileName}\`}>{providerContent}</span>
        <ProtocolState saveState="serialized" />
        <button onClick={() => console.log("diagnostic data")}>
          {busy ? "Loading projects" : "Continue"}
          {status === "pending" && <Spinner />}
          {status === "failed" ? <Error /> : null}
          {options["current"]}
        </button>
      </section>;
      t("Settings");
    `;
    const inspection = inspectUiSource("example.tsx", source, catalogFixture().en!);
    expect(inspection.literals.map(({ message }) => message)).toEqual([
      'Untranslated UI candidate: "Open project"',
      'Untranslated UI candidate: "Choose a project"',
      'Untranslated UI candidate: "Project name"',
      'Untranslated UI candidate: "Saving..."',
      'Untranslated UI candidate: "Saved"',
      'Untranslated UI candidate: "Open in editor"',
      'Untranslated UI candidate: "Editor options"',
      'Untranslated UI candidate: "Close"',
      'Untranslated UI candidate: "Loading projects"',
      'Untranslated UI candidate: "Continue"',
      'Untranslated UI candidate: "Settings"',
    ]);
    expect(inspection.errors).toEqual([]);
  });

  it("allows protected names, paths, flags, shortcuts, and punctuation but not prose containing them", () => {
    const source = `<><span>Codex</span><span>简体中文</span><code>/tmp/project</code>
      <code>--help</code><kbd>Ctrl+Enter</kbd><span>…</span><span>Open Codex settings</span><button>No</button></>`;
    const inspection = inspectUiSource("example.tsx", source, catalogFixture().en!);
    expect(inspection.literals).toEqual([
      expect.objectContaining({ message: 'Untranslated UI candidate: "Open Codex settings"' }),
      expect.objectContaining({ message: 'Untranslated UI candidate: "No"' }),
    ]);
  });
});
