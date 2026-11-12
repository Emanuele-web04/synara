// FILE: settingsSearchRows.ts
// Purpose: Read every searchable settings row straight from the settings source — each
//          `<SettingsRow id="setting-…">`, `<SettingsToggleItem>`, `<BooleanSettingRow>`,
//          and `<BooleanSettingToggle>` — with its title, description, and the page it
//          renders on. The search index is generated from this,
//          so a row that is added, renamed, or moved to another page is found there without
//          anyone editing the index by hand.
// Layer: Build tooling (node only; never imported by the app)
// Exports: SETTINGS_ROW_SOURCES, extractSettingsSearchRows, readSettingsSearchRows,
//          renderSettingsSearchRowsModule

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import type { SettingsSectionId } from "../src/settingsNavigation";

export interface SettingsSearchRow {
  /** DOM anchor the result scrolls to (`setting-…`). */
  readonly target: string;
  readonly section: SettingsSectionId;
  /** Catalog key (or literal) of the row title. */
  readonly title: string;
  /** Catalog key (or literal) of the row description; matched as keywords. */
  readonly description: string;
}

/**
 * Where settings rows live and which page each owner renders on. The owner is the nearest
 * enclosing function or `const` that appears in the map — a settings view or a panel
 * component. A row inside a listed file whose owner is not mapped fails generation,
 * so a new panel cannot quietly go unsearchable.
 */
export const SETTINGS_ROW_SOURCES: ReadonlyArray<{
  readonly file: string;
  readonly owners: Readonly<Record<string, SettingsSectionId>>;
  /** Anchored rows that are transient states (an error, a setup step), not settings. */
  readonly ignore?: ReadonlyArray<string>;
}> = [
  {
    file: "src/components/settings/views/GeneralSettingsView.tsx",
    owners: { GeneralSettingsView: "general" },
  },
  {
    file: "src/components/settings/views/LayoutSettingsView.tsx",
    owners: { LayoutSettingsView: "layout" },
  },
  {
    file: "src/components/settings/views/AppearanceSettingsView.tsx",
    owners: { AppearanceSettingsView: "appearance", MessageTrailMicrophoneRow: "appearance" },
  },
  {
    file: "src/components/settings/views/ChatsSettingsView.tsx",
    owners: { ChatsSettingsView: "behavior" },
  },
  {
    file: "src/components/settings/views/WorktreeDefaultsSection.tsx",
    owners: { WorktreeDefaultsSection: "worktrees" },
  },
  {
    file: "src/components/settings/views/UsageLimitSettingsSection.tsx",
    owners: { UsageLimitSettingsSection: "usage" },
  },
  {
    file: "src/components/settings/accounts/DefaultNewChatAccountRow.tsx",
    owners: { DefaultNewChatAccountRow: "general" },
  },
  {
    file: "src/components/KeepAwakeControls.tsx",
    owners: { KeepAwakeSettingsSection: "general", RemoteAccessKeepAwakeRow: "general" },
  },
  {
    file: "src/components/settings/DesktopSettingsPanels.tsx",
    owners: {
      NotificationsSettingsPanel: "notifications",
      LocalAppSnapSettingsPanel: "appsnap",
    },
  },
  {
    file: "src/components/settings/AdvancedSettingsPanel.tsx",
    owners: {
      KeybindingsFileSettingsSection: "shortcuts",
      AppTourSettingsRow: "general",
      AboutSettingsSection: "about",
      AdvancedSettingsPanel: "advanced",
    },
  },
  {
    file: "src/components/settings/providers/ProvidersSettingsPanel.tsx",
    owners: { ProvidersSettingsPanel: "providers" },
  },
  {
    file: "src/components/settings/UsageLimitRecoverySetting.tsx",
    owners: { UsageLimitRecoverySetting: "usage" },
  },
  {
    file: "src/components/settings/ModelsSettingsPanel.tsx",
    owners: { ModelsSettingsPanel: "models" },
  },
  {
    file: "src/components/settings/SkillsSettingsPanel.tsx",
    owners: { SkillsSettingsPanel: "skills" },
    ignore: ["setting-skill-discovery-failed", "setting-no-skills-found"],
  },
  {
    file: "src/components/settings/ComputerSettingsPanel.tsx",
    owners: { LocalComputerSettingsPanel: "computer" },
  },
  {
    file: "src/components/settings/ExternalMcpSettingsPanel.tsx",
    owners: { ExternalMcpSettingsPanel: "integrations" },
    ignore: [
      "setting-1-give-your-agent-this-prompt",
      "setting-set-up-by-hand-instead",
      "setting-2-try-it",
    ],
  },
];

const ROW_COMPONENTS = new Set([
  "SettingsRow",
  "SettingsToggleItem",
  "BooleanSettingRow",
  "BooleanSettingToggle",
]);

/**
 * The copy key behind an attribute or property value: a string literal, `t("key")`, or —
 * for a conditional — its resting (`whenFalse`) branch. Null when the copy is computed.
 */
function copyKey(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return copyKey(node.expression);
  if (ts.isConditionalExpression(node)) return copyKey(node.whenFalse);
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "t" &&
    node.arguments.length >= 1
  ) {
    return copyKey(node.arguments[0]);
  }
  return null;
}

function jsxAttribute(
  attributes: ts.JsxAttributes,
  name: string,
): ts.Expression | undefined | "missing" {
  for (const property of attributes.properties) {
    if (!ts.isJsxAttribute(property) || property.name.getText() !== name) continue;
    const initializer = property.initializer;
    if (!initializer) return undefined;
    if (ts.isStringLiteral(initializer)) return initializer;
    if (ts.isJsxExpression(initializer)) return initializer.expression;
    return undefined;
  }
  return "missing";
}

/** Name of the nearest enclosing function or `const` that the owners map knows. */
function ownerOf(node: ts.Node, owners: Readonly<Record<string, SettingsSectionId>>) {
  for (let current = node.parent; current; current = current.parent) {
    const name =
      ts.isFunctionDeclaration(current) && current.name
        ? current.name.text
        : ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)
          ? current.name.text
          : null;
    if (name !== null && name in owners) return name;
  }
  return null;
}

export function extractSettingsSearchRows(
  sourceText: string,
  source: (typeof SETTINGS_ROW_SOURCES)[number],
): SettingsSearchRow[] {
  const file = ts.createSourceFile(
    source.file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const rows: SettingsSearchRow[] = [];
  const problems: string[] = [];

  const add = (node: ts.Node, id: string, title: string | null, description: string | null) => {
    if (!id.startsWith("setting-") || source.ignore?.includes(id)) return;
    const owner = ownerOf(node, source.owners);
    const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    if (owner === null) {
      problems.push(`${source.file}:${line} row "${id}" is outside every mapped owner`);
      return;
    }
    if (title === null) {
      problems.push(`${source.file}:${line} row "${id}" has a computed title`);
      return;
    }
    // A description that changes with the value (writing style) is matched by title only.
    rows.push({
      target: id,
      section: source.owners[owner]!,
      title,
      description: description ?? "",
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText();
      if (ROW_COMPONENTS.has(tag)) {
        const id = jsxAttribute(node.attributes, "id");
        // A computed id (a variable) is data, not a fixed setting; only literal ids count.
        if (id !== "missing") {
          const idText = copyKey(id);
          if (idText) {
            const title = jsxAttribute(node.attributes, "title");
            const description = jsxAttribute(node.attributes, "description");
            add(
              node,
              idText,
              title === "missing" ? null : copyKey(title),
              description === "missing" ? null : copyKey(description),
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  if (problems.length > 0) {
    throw new Error(`Settings search rows could not be read:\n${problems.join("\n")}`);
  }
  return rows;
}

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every searchable row, in source order, one per page + anchor. */
export function readSettingsSearchRows(webRoot: string = WEB_ROOT): SettingsSearchRow[] {
  const seen = new Set<string>();
  const rows: SettingsSearchRow[] = [];
  for (const source of SETTINGS_ROW_SOURCES) {
    const text = readFileSync(path.join(webRoot, source.file), "utf8");
    for (const row of extractSettingsSearchRows(text, source)) {
      const key = `${row.section}:${row.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  return rows;
}

export const SETTINGS_SEARCH_ROWS_MODULE = "src/settingsSearchRows.generated.ts";

export function renderSettingsSearchRowsModule(rows: ReadonlyArray<SettingsSearchRow>): string {
  const body = rows
    .map(
      (row) =>
        `  {\n    target: ${JSON.stringify(row.target)},\n    section: ${JSON.stringify(row.section)},\n` +
        `    title: ${JSON.stringify(row.title)},\n    description: ${JSON.stringify(row.description)},\n  },`,
    )
    .join("\n");
  return `// FILE: settingsSearchRows.generated.ts
// GENERATED by apps/web/scripts/generate-settings-search-rows.ts from the settings rows
// themselves. Do not edit; run \`bun run --cwd apps/web settings-search:generate\`.

import type { SettingsSectionId } from "./settingsNavigation";

export interface GeneratedSettingsSearchRow {
  readonly target: string;
  readonly section: SettingsSectionId;
  readonly title: string;
  readonly description: string;
}

export const GENERATED_SETTINGS_SEARCH_ROWS: readonly GeneratedSettingsSearchRow[] = [
${body}
];
`;
}
