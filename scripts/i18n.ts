import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UI_LOCALES } from "@synara/contracts";
import ts from "typescript";

export type Catalogs = Record<string, Record<string, Record<string, string>>>;

export interface LocalizationDiagnostic {
  code: string;
  file: string;
  line?: number;
  key?: string;
  message: string;
}

export interface SourceInspection {
  references: string[];
  slots: Record<string, string[]>;
  dynamicCalls: number;
  errors: LocalizationDiagnostic[];
  literals: LocalizationDiagnostic[];
}

// These are product/protocol identifiers, not untranslated application copy.
export const PROTECTED_TOKENS = [
  "Synara",
  "Codex",
  "Claude",
  "Cursor",
  "Devin",
  "OpenCode",
  "AppSnap",
  "MCP",
  "CLI",
  "Git",
  "GitHub",
  "worktree",
] as const;

export const UI_LITERAL_ALLOWLIST: Readonly<Record<string, string>> = {
  ...Object.fromEntries(PROTECTED_TOKENS.map((value) => [value, "Product or protocol identifier"])),
  "Synara Beta": "Product name",
  "Synara Canary": "Product name",
  OpenAI: "Provider name",
  Anthropic: "Provider name",
  Gemini: "Provider name",
  Google: "Provider name",
  Ollama: "Provider name",
  English: "Native language name",
  Español: "Native language name",
  简体中文: "Native language name",
  TypeScript: "Programming language name",
  JavaScript: "Programming language name",
  JSON: "Data format",
  HTML: "Data format",
  CSS: "Programming language name",
  "UTF-8": "Encoding name",
  HTTP: "Protocol name",
  HTTPS: "Protocol name",
  SSH: "Protocol name",
  OAuth: "Protocol name",
  API: "Protocol term",
  URL: "Protocol term",
  Worktree: "Git worktree term",
  codex: "CLI executable",
  claude: "CLI executable",
  "cursor-agent": "CLI executable",
  agy: "CLI executable",
  grok: "CLI executable",
  droid: "CLI executable",
  devin: "CLI executable",
  opencode: "CLI executable",
  pi: "CLI executable",
  omp: "CLI executable",
  "gh auth login": "Executable authentication command example",
  "devin auth login": "Executable authentication command example",
  "owner/repository": "GitHub repository identifier example",
  "codex-theme-v1:": "Theme share serialization prefix",
  'codex-theme-v1:{"codeThemeId":"linear",...}': "Serialized theme example",
  Cron: "Scheduler format name",
  "Europe/Rome": "IANA time-zone identifier example",
  PDF: "Data format",
  PR: "GitHub abbreviation",
  PID: "Process identifier abbreviation",
  Esc: "Keyboard token",
  Enter: "Keyboard token",
  "Alt+Left": "Keyboard shortcut",
  "Alt+Right": "Keyboard shortcut",
  "feature/my-change": "Git branch example",
  "synara/feature-name": "Git branch example",
  ".git/index.lock": "Git metadata path",
  '"JetBrains Mono"': "Font-family example",
  LinkedIn: "Service name",
  Reddit: "Service name",
  "localhost:": "Local host name",
  "{{value0}}/code/my-repo": "Repository path example",
  "Claude HOME": "Provider environment setting",
  "#rrggbb": "Hex color notation",
  Aa: "Typography preview sample",
  Beta: "Release channel name",
  "bun test": "Executable command example",
  "{{value0}} (Enter)": "Data value followed by keyboard token",
  "MEMORY.md": "Automation memory file name",
  Backspace: "Keyboard token",
  IMG: "Image format abbreviation",
  Stderr: "Process stream identifier",
  px: "CSS unit",
  "Conventional Commits": "Specification name",
  token: "Model token unit",
  Diff: "Technical diff term",
  Lint: "Technical lint term",
  Kanban: "Board methodology name",
};

// These complete Spanish messages are valid cognates/established technical terms.
// They are intentionally NOT permitted as raw JSX: other languages still need a key.
const SPANISH_INVARIANT_MESSAGES = new Set([
  "No",
  "Editor",
  "Error",
  "error",
  "terminal",
  "Terminal",
  "tokens",
  "tokens.",
  "{{count}} tokens",
  "{{amount}} min",
  "{{count}} error",
  "Idea",
  "Panel",
  "Auto",
  "Local",
  "Zoom",
  "General",
  "Personal",
  "Color",
  "Variables",
  "Chat",
  "Chats",
  "Chat {{value0}}",
  "Bot",
  "Emoji",
  "Plan",
  "Manual",
  "· PR",
  "upstream",
]);

const UI_PROPS = new Set([
  "title",
  "description",
  "label",
  "placeholder",
  "aria-label",
  "aria-description",
  "alt",
  "tooltip",
  "emptyMessage",
  "loadingMessage",
  "confirmLabel",
  "cancelLabel",
  "closeLabel",
  "groupLabel",
  "menuLabel",
]);
const UI_COMPONENT_PROPS: Readonly<Record<string, readonly string[]>> = {
  WorkspaceFilePreviewHeader: ["saveState"],
};
const TRANSLATORS = new Set(["t", "translate", "sourceTranslate"]);
const SEMANTIC_KEY = /^[a-z][A-Za-z0-9_-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const UI_METADATA_CONTAINERS = new Set([
  "SETTINGS_NAV_GROUPS",
  "SETTINGS_NAV_ITEMS",
  "SETTINGS_SEARCH_ENTRIES",
  "SIDEBAR_SURFACE_PICKER_COPY",
  "DEVICE_RAIL_GROUPS",
  "PROJECT_ICON_OPTIONS",
]);
const UI_LABEL_DICTIONARIES = new Set(["RAIL_PANEL_ITEM_LABELS", "PROJECT_COLOR_LABELS"]);
const UI_METADATA_HELPERS = new Set([
  "renderBooleanSettingRow",
  "renderSettingRow",
  "renderSelectSettingRow",
]);

function sortedDiagnostics(diagnostics: LocalizationDiagnostic[]): LocalizationDiagnostic[] {
  return diagnostics.toSorted(
    (left, right) =>
      left.file.localeCompare(right.file, "en") ||
      (left.line ?? 0) - (right.line ?? 0) ||
      (left.key ?? "").localeCompare(right.key ?? "", "en") ||
      left.code.localeCompare(right.code, "en"),
  );
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]!).toSorted();
}

function protectedTokens(value: string): string[] {
  const words = new Set(value.match(/[A-Za-z][A-Za-z0-9_-]*/g) ?? []);
  return [
    ...PROTECTED_TOKENS.filter(
      (token) =>
        (words.has(token) || (token === "worktree" && words.has("worktrees"))) &&
        // This setting names the editor caret; it does not refer to the Cursor provider.
        !(token === "Cursor" && value === "Cursor colors"),
    ),
    ...[...value.matchAll(/`([^`\n]+)`/g)].map((match) => match[0]),
    ...[...value.matchAll(/\bSYNARA_[A-Z0-9_]+\b/g)].map((match) => match[0]),
  ];
}

/** Catalog parity is exact; the English catalog owns message identities, not UI source text. */
export function validateCatalogs(
  catalogs: Catalogs,
  locales: readonly string[],
  slots: Readonly<Record<string, readonly string[]>> = {},
): LocalizationDiagnostic[] {
  const errors: LocalizationDiagnostic[] = [];
  const english = catalogs.en;
  if (!english || Object.keys(english).length === 0) {
    return [
      { code: "missing-reference", file: "en", message: "English reference catalogs are missing." },
    ];
  }
  for (const locale of locales) {
    const namespaces = catalogs[locale] ?? {};
    for (const namespace of new Set([...Object.keys(english), ...Object.keys(namespaces)])) {
      const file = `${locale}/${namespace}.json`;
      const reference = english[namespace];
      const translated = namespaces[namespace];
      if (!reference || !translated) {
        errors.push({
          code: reference ? "missing-namespace" : "extra-namespace",
          file,
          message: reference ? "Missing namespace." : "Namespace is absent from English.",
        });
        continue;
      }
      for (const key of new Set([...Object.keys(reference), ...Object.keys(translated)])) {
        if (!Object.hasOwn(reference, key) || !Object.hasOwn(translated, key)) {
          errors.push({
            code: Object.hasOwn(reference, key) ? "missing-key" : "extra-key",
            file,
            key,
            message: Object.hasOwn(reference, key)
              ? "Missing translation."
              : "Key is absent from English.",
          });
          continue;
        }
        const source = reference[key]!;
        const value = translated[key]!;
        const allowedSlots = slots[`${namespace}:${key}`] ?? [];
        const tags = [...value.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)([^<>]*)>/g)];
        const openTags: string[] = [];
        let unbalanced = false;
        for (const tag of tags) {
          if (!allowedSlots.includes(tag[1]!))
            errors.push({
              code: "unknown-rich-slot",
              file,
              key,
              message: `Tag <${tag[1]}> is not an explicitly supplied React slot.`,
            });
          if (tag[2]!.trim() !== "" && tag[2]!.trim() !== "/")
            errors.push({
              code: "rich-slot-attributes",
              file,
              key,
              message:
                "Catalog slots must not contain HTML attributes or override component props.",
            });
          if (tag[0].startsWith("</")) {
            if (openTags.pop() !== tag[1]) unbalanced = true;
          } else if (tag[2]!.trim() !== "/") openTags.push(tag[1]!);
        }
        if (unbalanced || openTags.length)
          errors.push({
            code: "rich-slot-nesting",
            file,
            key,
            message: "React slots must have balanced, correctly nested tags.",
          });
        const sourceTags = [...source.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)([^<>]*)>/g)]
          .map((tag) => tag[1]!)
          .toSorted();
        if (JSON.stringify(sourceTags) !== JSON.stringify(tags.map((tag) => tag[1]!).toSorted()))
          errors.push({
            code: "rich-slot-parity",
            file,
            key,
            message: "React slot names or occurrence counts differ from English.",
          });
        if (!value.trim())
          errors.push({ code: "empty-value", file, key, message: "Translation is empty." });
        if (JSON.stringify(placeholders(source)) !== JSON.stringify(placeholders(value))) {
          errors.push({
            code: "interpolation",
            file,
            key,
            message: "Interpolation names or occurrence counts differ from English.",
          });
        }
        for (const token of new Set(protectedTokens(source))) {
          if (!value.includes(token))
            errors.push({
              code: "protected-token",
              file,
              key,
              message: `Protected token ${JSON.stringify(token)} is missing or changed.`,
            });
        }
      }
    }
  }
  return sortedDiagnostics(errors);
}

function isAllowedLiteral(value: string): boolean {
  const normalized = value.trim();
  return (
    !/\p{L}/u.test(normalized.replace(/&(?:[a-z]+|#\d+|#x[\da-f]+);/gi, "")) ||
    Object.hasOwn(UI_LITERAL_ALLOWLIST, normalized) ||
    /^[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(normalized) ||
    // Executable paths, URLs, flags, and key chords are literal examples/data.
    /^(?:https?:\/\/|file:\/\/|(?:~|\.)?\/|[A-Za-z]:\\)\S+$/.test(normalized) ||
    /^--[a-z][a-z0-9-]*(?:=\S+)?$/.test(normalized) ||
    /^(?:(?:Ctrl|Control|Alt|Option|Shift|Meta|Cmd|Command)[+ -])+(?:[A-Z0-9]|Enter|Tab|Escape|Backspace|Delete|Space|Arrow(?:Up|Down|Left|Right))$/.test(
      normalized,
    ) ||
    /^(?:⌘|⌥|⇧|⌃)+[A-Z0-9↵⌫⇥]$/.test(normalized)
  );
}

function catalogHasKey(english: Catalogs[string], key: string): boolean {
  const separator = key.indexOf(":");
  const namespace = english[key.slice(0, separator)];
  const name = key.slice(separator + 1);
  if (!namespace) return false;
  return (
    Object.hasOwn(namespace, name) ||
    // i18next resolves count/context variants from a base message identity.
    Object.keys(namespace).some((candidate) => candidate.startsWith(`${name}_`))
  );
}

function translatorName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === "t") return "t";
  return undefined;
}

function stringValue(node: ts.Node): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

function isUiString(node: ts.Node): boolean {
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isJsxAttribute(parent)) {
      const name = parent.name.getText();
      const element = parent.parent.parent;
      return (
        UI_PROPS.has(name) ||
        ((ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) &&
          (UI_COMPONENT_PROPS[element.tagName.getText()]?.includes(name) ?? false))
      );
    }
    if (ts.isJsxSpreadAttribute(parent)) return false;
    if (ts.isConditionalExpression(parent) && child === parent.condition) return false;
    if (ts.isBinaryExpression(parent)) {
      if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        if (child === parent.left) return false;
      } else if (
        ![ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
          parent.operatorToken.kind,
        )
      )
        return false;
    }
    if (ts.isElementAccessExpression(parent) || ts.isTypeNode(parent)) return false;
    if (ts.isPropertyAssignment(parent) && child === parent.name) return false;
    if (ts.isCallExpression(parent)) return false;
    if (
      ts.isJsxExpression(parent) &&
      parent.parent &&
      (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent))
    )
      return true;
    if (ts.isStatement(parent)) return false;
  }
  return false;
}

function isEmbeddedCode(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxElement(parent))
      return ["style", "script"].includes(parent.openingElement.tagName.getText());
  }
  return false;
}

function isUiMetadata(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent || !ts.isPropertyAssignment(parent) || parent.initializer !== node) return false;
  const name =
    ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name) ? parent.name.text : "";
  return UI_PROPS.has(name) || ["keywords", "labelKey", "keywordsKey"].includes(name);
}

function isKnownUiMetadataValue(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent || !ts.isPropertyAssignment(parent) || parent.initializer !== node) return false;
  const name =
    ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name) ? parent.name.text : "";
  const isUiProperty =
    UI_PROPS.has(name) || ["keywords", "ariaLabel", "ariaDescription"].includes(name);
  for (let ancestor: ts.Node | undefined = parent.parent; ancestor; ancestor = ancestor.parent) {
    if (
      ts.isSatisfiesExpression(ancestor) &&
      ts.isTypeReferenceNode(ancestor.type) &&
      ["ComponentProps", "React.ComponentProps"].includes(ancestor.type.typeName.getText()) &&
      ancestor.type.typeArguments?.length === 1 &&
      ts.isTypeQueryNode(ancestor.type.typeArguments[0]!)
    )
      return isUiProperty;
    if (ts.isVariableDeclaration(ancestor) && ts.isIdentifier(ancestor.name)) {
      return (
        UI_LABEL_DICTIONARIES.has(ancestor.name.text) ||
        (isUiProperty && UI_METADATA_CONTAINERS.has(ancestor.name.text))
      );
    }
    if (ts.isCallExpression(ancestor))
      return isUiProperty && UI_METADATA_HELPERS.has(ancestor.expression.getText());
    if (ts.isFunctionLike(ancestor)) return false;
  }
  return false;
}

// These helpers return display copy. Adjacent serialization/parsing helpers still
// own user content and protocol strings, so do not scan every string in the file.
const UI_PRESENTATION_HELPERS: Readonly<Record<string, readonly string[]>> = {
  "apps/web/src/lib/composerPastedText.ts": ["formatPastedTextCountLabel", "pastedTextTitle"],
  "apps/web/src/components/chat/ComposerSlashStatusDialog.tsx": [
    "formatRateLimitMessage",
    "formatEnvironmentLabel",
  ],
  "apps/web/src/components/settings/ExternalMcpSettingsPanel.tsx": ["formatDate"],
  "apps/web/src/lib/runningChatsQuitConfirmation.ts": [
    "runningChatsQuitCopy",
    "runningChatDisplayTitle",
  ],
};

function isKnownUiPresentationValue(node: ts.Node, file: string): boolean {
  // This default also becomes persisted draft titles and parsed prompt metadata.
  // Display consumers supply their own translated fallback; never translate data.
  if (
    file === "apps/web/src/lib/composerPastedText.ts" &&
    stringValue(node) === "Pasted text" &&
    ts.isParameter(node.parent) &&
    node.parent.initializer === node &&
    ts.isIdentifier(node.parent.name) &&
    node.parent.name.text === "fallback" &&
    ts.isFunctionDeclaration(node.parent.parent) &&
    node.parent.parent.name?.text === "pastedTextTitle"
  )
    return false;
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isConditionalExpression(parent) && child === parent.condition) return false;
    if (
      ts.isBinaryExpression(parent) &&
      ![
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(parent.operatorToken.kind)
    )
      return false;
    if (ts.isElementAccessExpression(parent) || ts.isTypeNode(parent)) return false;
    if (ts.isBindingElement(parent)) return false;
    if (ts.isPropertyAssignment(parent)) {
      const name =
        ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name) ? parent.name.text : "";
      if (child === parent.name || !(UI_PROPS.has(name) || name.endsWith("Label"))) return false;
    }
    if (ts.isCallExpression(parent)) {
      if (
        file === "apps/web/src/components/Sidebar.tsx" &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === "renderListSectionHeader"
      )
        return parent.arguments[0] === child;
      // The first argument is clipboard data; only the second is a displayed title.
      return (
        file === "apps/web/src/components/settings/ExternalMcpSettingsPanel.tsx" &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === "copyWithToast" &&
        parent.arguments[1] === child
      );
    }
    if (ts.isFunctionLike(parent))
      return (
        ts.isFunctionDeclaration(parent) &&
        parent.name !== undefined &&
        (UI_PRESENTATION_HELPERS[file]?.includes(parent.name.text) ?? false)
      );
  }
  return false;
}

function implicitPlatformFormatter(node: ts.CallExpression): string | undefined {
  const expression = node.expression;
  const method = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : ts.isElementAccessExpression(expression) && expression.argumentExpression
      ? stringValue(expression.argumentExpression)
      : undefined;
  if (!method || !["toLocaleString", "toLocaleDateString", "toLocaleTimeString"].includes(method))
    return undefined;
  const locale = node.arguments[0];
  return !locale ||
    (ts.isIdentifier(locale) && locale.text === "undefined") ||
    ts.isVoidExpression(locale)
    ? method
    : undefined;
}

/** AST-based and deliberately conservative: report literal UI copy without translating data. */
export function inspectUiSource(
  file: string,
  contents: string,
  english: Catalogs[string],
): SourceInspection {
  const result: SourceInspection = {
    references: [],
    slots: {},
    dynamicCalls: 0,
    errors: [],
    literals: [],
  };
  const ast = ts.createSourceFile(
    file,
    contents,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const dictionaries = new Map<string, Map<string, string>>();
  const translatedDictionaries = new Set<string>();
  const collectMetadata = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const entries = node.initializer.properties.flatMap((property): [string, string][] => {
        if (
          !ts.isPropertyAssignment(property) ||
          !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        )
          return [];
        const value = stringValue(property.initializer);
        return value === undefined ? [] : [[property.name.text, value]];
      });
      dictionaries.set(node.name.text, new Map(entries));
    }
    if (ts.isCallExpression(node) && TRANSLATORS.has(translatorName(node.expression) ?? "")) {
      const argument = node.arguments[0];
      if (
        argument &&
        ts.isElementAccessExpression(argument) &&
        ts.isIdentifier(argument.expression)
      )
        translatedDictionaries.add(argument.expression.text);
    }
    ts.forEachChild(node, collectMetadata);
  };
  collectMetadata(ast);
  const hasLocalizedMetadata = (node: ts.Node): boolean => {
    const property = node.parent;
    if (
      !property ||
      !ts.isPropertyAssignment(property) ||
      !ts.isObjectLiteralExpression(property.parent)
    )
      return false;
    const object = property.parent;
    const name =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : "";
    const siblingValue = (key: string) => {
      const sibling = object.properties.find(
        (entry) =>
          ts.isPropertyAssignment(entry) &&
          (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
          entry.name.text === key,
      );
      return sibling && ts.isPropertyAssignment(sibling)
        ? stringValue(sibling.initializer)
        : undefined;
    };
    // English aliases remain searchable; their explicit sibling key owns displayed copy.
    const siblingKey = ["label", "keywords"].includes(name)
      ? siblingValue(`${name}Key`)
      : undefined;
    if (siblingKey && SEMANTIC_KEY.test(siblingKey) && catalogHasKey(english, siblingKey))
      return true;
    for (
      let ancestor: ts.Node | undefined = property.parent;
      ancestor;
      ancestor = ancestor.parent
    ) {
      if (!ts.isVariableDeclaration(ancestor) || !ts.isIdentifier(ancestor.name)) continue;
      let translatedKey: string | undefined;
      // Project colors export legacy English aliases beside a complete key dictionary.
      if (ancestor.name.text === "PROJECT_COLOR_LABELS")
        translatedKey = dictionaries.get("PROJECT_COLOR_LABEL_KEYS")?.get(name);
      // Device actions retain source labels for metadata consumers; require their keyed
      // dictionary AND an actual translator call using that dictionary in this module.
      if (
        ancestor.name.text === "DEVICE_RAIL_GROUPS" &&
        name === "label" &&
        translatedDictionaries.has("DEVICE_RAIL_LABEL_KEYS")
      ) {
        const id = siblingValue("id");
        if (id) translatedKey = dictionaries.get("DEVICE_RAIL_LABEL_KEYS")?.get(id);
      }
      return (
        translatedKey !== undefined &&
        SEMANTIC_KEY.test(translatedKey) &&
        catalogHasKey(english, translatedKey)
      );
    }
    return false;
  };
  const handled = new Set<ts.Node>();
  const report = (
    node: ts.Node,
    code: string,
    message: string,
    key?: string,
  ): LocalizationDiagnostic => ({
    code,
    file,
    line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
    ...(key === undefined ? {} : { key }),
    message,
  });
  const reference = (node: ts.Node, key: string) => {
    result.references.push(key);
    if (!catalogHasKey(english, key))
      result.errors.push(
        report(node, "unknown-key", "Semantic key is absent from English catalogs.", key),
      );
  };
  const literal = (node: ts.Node, value: string, code = "ui-literal") => {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!isAllowedLiteral(normalized))
      result.literals.push(
        report(node, code, `Untranslated UI candidate: ${JSON.stringify(normalized)}`),
      );
  };
  const inspectTranslationArgument = (argument: ts.Expression | undefined): boolean => {
    if (!argument) return true;
    const value = stringValue(argument);
    if (value !== undefined) {
      handled.add(argument);
      if (SEMANTIC_KEY.test(value)) reference(argument, value);
      else literal(argument, value, "source-string-call");
      return false;
    }
    if (ts.isParenthesizedExpression(argument))
      return inspectTranslationArgument(argument.expression);
    if (ts.isConditionalExpression(argument)) {
      // Only outputs reach the translator. Conditions and dynamic branches are data.
      const dynamicWhenTrue = inspectTranslationArgument(argument.whenTrue);
      const dynamicWhenFalse = inspectTranslationArgument(argument.whenFalse);
      return dynamicWhenTrue || dynamicWhenFalse;
    }
    return true;
  };
  const visit = (node: ts.Node): void => {
    if (file.startsWith("apps/web/src/") && ts.isCallExpression(node)) {
      const formatter = implicitPlatformFormatter(node);
      if (formatter)
        result.literals.push(
          report(
            node,
            "implicit-format-locale",
            `${formatter} uses the platform locale; pass the resolved UI locale explicitly.`,
          ),
        );
    }
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText() === "Translation"
    ) {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const message = attributes.find(
        (attribute) => attribute.name.getText() === "message",
      )?.initializer;
      const messageKey = message && stringValue(message);
      if (message && messageKey && SEMANTIC_KEY.test(messageKey)) reference(message, messageKey);
      const components = attributes.find(
        (attribute) => attribute.name.getText() === "components",
      )?.initializer;
      if (
        messageKey &&
        components &&
        ts.isJsxExpression(components) &&
        components.expression &&
        ts.isObjectLiteralExpression(components.expression)
      ) {
        const names = components.expression.properties.flatMap((property) =>
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            ? [property.name.text]
            : [],
        );
        result.slots[messageKey] = [
          ...new Set([...(result.slots[messageKey] ?? []), ...names]),
        ].toSorted();
      }
    }
    if (ts.isCallExpression(node) && TRANSLATORS.has(translatorName(node.expression) ?? "")) {
      if (inspectTranslationArgument(node.arguments[0])) result.dynamicCalls += 1;
    }
    const value = stringValue(node);
    if (value !== undefined && !handled.has(node)) {
      const namespace = value.slice(0, value.indexOf(":"));
      if (
        SEMANTIC_KEY.test(value) &&
        Object.hasOwn(english, namespace) &&
        (catalogHasKey(english, value) || isUiString(node) || isUiMetadata(node))
      )
        reference(node, value);
      else if (
        (isUiString(node) ||
          isKnownUiMetadataValue(node) ||
          isKnownUiPresentationValue(node, file)) &&
        !isEmbeddedCode(node) &&
        !hasLocalizedMetadata(node)
      )
        literal(node, value);
    }
    if (
      ts.isTemplateExpression(node) &&
      (isUiString(node) ||
        isKnownUiMetadataValue(node) ||
        isKnownUiPresentationValue(node, file)) &&
      !isEmbeddedCode(node) &&
      !hasLocalizedMetadata(node)
    ) {
      // Inspect only static copy; interpolation expressions remain application data.
      literal(
        node,
        [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" "),
      );
    }
    if (ts.isJsxText(node) && !isEmbeddedCode(node)) literal(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  result.references = [...new Set(result.references)].toSorted();
  result.errors = sortedDiagnostics(result.errors);
  result.literals = sortedDiagnostics(result.literals);
  return result;
}

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .toSorted((a, b) => a.name.localeCompare(b.name, "en"))
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? filesIn(file) : [file];
    });
}

export function loadCatalogs(
  directory: string,
  locales: readonly string[],
): { catalogs: Catalogs; errors: LocalizationDiagnostic[] } {
  const catalogs: Catalogs = {};
  const errors: LocalizationDiagnostic[] = [];
  const present = new Set(
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  for (const locale of locales) {
    catalogs[locale] = {};
    if (!present.has(locale)) continue;
    for (const file of filesIn(path.join(directory, locale)).filter((entry) =>
      entry.endsWith(".json"),
    )) {
      const relative = path.relative(directory, file).split(path.sep).join("/");
      const contents = readFileSync(file, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents);
      } catch {
        errors.push({
          code: "invalid-json",
          file: relative,
          message: "Catalog is not valid JSON.",
        });
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        errors.push({
          code: "invalid-catalog",
          file: relative,
          message: "Catalog must be a flat object of string messages.",
        });
        continue;
      }
      const namespace: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string")
          errors.push({
            code: "invalid-value",
            file: relative,
            key,
            message: "Catalog messages must be strings.",
          });
        else namespace[key] = value;
      }
      const ast = ts.parseJsonText(file, contents);
      const seen = new Set<string>();
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) {
          const key = node.name.text;
          if (seen.has(key))
            errors.push({
              code: "duplicate-key",
              file: relative,
              key,
              message: "Duplicate JSON key would overwrite a translation.",
            });
          seen.add(key);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      catalogs[locale]![path.basename(file, ".json")] = namespace;
    }
  }
  return { catalogs, errors: sortedDiagnostics(errors) };
}

export function auditLocalization(root: string) {
  const loaded = loadCatalogs(path.join(root, "packages/shared/src/locales"), UI_LOCALES);
  const catalogs = loaded.catalogs;
  const errors = [...loaded.errors];
  const slots: Record<string, string[]> = {};
  const literals: LocalizationDiagnostic[] = [];
  const references = new Set<string>();
  let dynamicCalls = 0;
  let files = 0;
  for (const directory of ["apps/web/src", "apps/desktop/src"]) {
    for (const file of filesIn(path.join(root, directory))) {
      if (
        !/\.tsx?$/.test(file) ||
        /\.(test(?:-support)?|browser|spec)\.|(?:^|\/)__fixtures__\/|routeTree\.gen\./.test(file)
      )
        continue;
      const relative = path.relative(root, file).split(path.sep).join("/");
      const inspected = inspectUiSource(relative, readFileSync(file, "utf8"), catalogs.en ?? {});
      errors.push(...inspected.errors);
      for (const [key, names] of Object.entries(inspected.slots))
        slots[key] = [...new Set([...(slots[key] ?? []), ...names])].toSorted();
      literals.push(...inspected.literals);
      inspected.references.forEach((key) => references.add(key));
      dynamicCalls += inspected.dynamicCalls;
      files += 1;
    }
  }
  errors.push(...validateCatalogs(catalogs, UI_LOCALES, slots));
  const unchanged: LocalizationDiagnostic[] = [];
  for (const locale of UI_LOCALES.filter((value) => value !== "en")) {
    for (const [namespace, messages] of Object.entries(catalogs[locale] ?? {})) {
      for (const [key, value] of Object.entries(messages)) {
        if (
          value === catalogs.en?.[namespace]?.[key] &&
          !isAllowedLiteral(value) &&
          !(locale === "es" && SPANISH_INVARIANT_MESSAGES.has(value)) &&
          /[A-Za-z]{2}/.test(value.replace(/\{\{[^{}]+\}\}/g, ""))
        ) {
          unchanged.push({
            code: "unchanged-translation",
            file: `${locale}/${namespace}.json`,
            key,
            message: `Translation matches English: ${JSON.stringify(value)}`,
          });
        }
      }
    }
  }
  return {
    errors: sortedDiagnostics(errors),
    literals: sortedDiagnostics(literals),
    unchanged: sortedDiagnostics(unchanged),
    summary: {
      locales: [...UI_LOCALES],
      namespaces: Object.keys(catalogs.en ?? {}).length,
      messages: Object.values(catalogs.en ?? {}).reduce(
        (count, namespace) => count + Object.keys(namespace).length,
        0,
      ),
      referencedKeys: references.size,
      dynamicCalls,
      files,
      uiLiterals: literals.length,
      unchangedTranslations: unchanged.length,
    },
  };
}

function main(args: string[]): number {
  const command = args[0] ?? "check";
  if (
    !["check", "coverage", "extract"].includes(command) ||
    args.slice(1).some((arg) => !["--check", "--json"].includes(arg))
  ) {
    process.stderr.write(
      "Usage: bun scripts/i18n.ts [check|coverage|extract] [--check] [--json]\nAll modes are read-only.\n",
    );
    return 2;
  }
  const report = auditLocalization(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const diagnostics =
    command === "check"
      ? report.errors
      : command === "extract"
        ? report.literals
        : [...report.errors, ...report.literals, ...report.unchanged];
  if (args.includes("--json"))
    process.stdout.write(`${JSON.stringify({ summary: report.summary, diagnostics }, null, 2)}\n`);
  else {
    process.stdout.write(`Localization: ${JSON.stringify(report.summary)}\n`);
    for (const item of diagnostics)
      process.stdout.write(
        `${item.file}${item.line ? `:${item.line}` : ""}${item.key ? ` [${item.key}]` : ""}: ${item.code}: ${item.message}\n`,
      );
    process.stdout.write(
      `${diagnostics.length} ${command === "check" ? "errors" : "findings"}. No files changed.\n`,
    );
  }
  return report.errors.length > 0 || (args.includes("--check") && diagnostics.length > 0) ? 1 : 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
