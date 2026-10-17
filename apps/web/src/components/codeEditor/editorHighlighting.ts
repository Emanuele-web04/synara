// FILE: editorHighlighting.ts
// Purpose: Tokenize editor models with the Shiki highlighter the read-only
//          previews and diffs already use, so edited code keeps Synara's
//          GitHub themes instead of the engine's built-in palette.
// Layer: Web editor runtime
// Exports: ensureEditorLanguage, editorTokenRules, editorLanguageForPath
// Depends on: the shared Pierre/Shiki highlighter (lib/syntaxHighlighting) and
//             Monaco's language registry.

import * as monaco from "monaco-editor/editor/editor.api";
import type { DiffsHighlighter } from "@pierre/diffs";

import { resolveDiffThemeName, type DiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise, getSyntaxLanguageForPath } from "~/lib/syntaxHighlighting";

// vscode-textmate packs the theme colour index and font style into each token's
// metadata word; these masks are the published encoding (EncodedTokenMetadata).
const FOREGROUND_MASK = 0b00000000111111111000000000000000;
const FOREGROUND_OFFSET = 15;
const FONT_STYLE_MASK = 0b00000000000000000111100000000000;
const FONT_STYLE_OFFSET = 11;
const FONT_STYLE_NAMES = ["italic", "bold", "underline", "strikethrough"] as const;

// Monaco language configurations (brackets, comments, auto-closing pairs) come
// from the engine's bundled definitions; the Monarch grammar they also export
// is never installed because Shiki owns tokenization.
type LanguageDefinition = { conf: monaco.languages.LanguageConfiguration };
const definitions: Record<string, () => Promise<LanguageDefinition>> = {
  typescript: () => import("monaco-editor/languages/definitions/typescript/typescript"),
  tsx: () => import("monaco-editor/languages/definitions/typescript/typescript"),
  javascript: () => import("monaco-editor/languages/definitions/javascript/javascript"),
  jsx: () => import("monaco-editor/languages/definitions/javascript/javascript"),
  css: () => import("monaco-editor/languages/definitions/css/css"),
  scss: () => import("monaco-editor/languages/definitions/scss/scss"),
  less: () => import("monaco-editor/languages/definitions/less/less"),
  html: () => import("monaco-editor/languages/definitions/html/html"),
  vue: () => import("monaco-editor/languages/definitions/html/html"),
  svelte: () => import("monaco-editor/languages/definitions/html/html"),
  xml: () => import("monaco-editor/languages/definitions/xml/xml"),
  markdown: () => import("monaco-editor/languages/definitions/markdown/markdown"),
  mdx: () => import("monaco-editor/languages/definitions/mdx/mdx"),
  yaml: () => import("monaco-editor/languages/definitions/yaml/yaml"),
  shellscript: () => import("monaco-editor/languages/definitions/shell/shell"),
  bash: () => import("monaco-editor/languages/definitions/shell/shell"),
  sh: () => import("monaco-editor/languages/definitions/shell/shell"),
  zsh: () => import("monaco-editor/languages/definitions/shell/shell"),
  python: () => import("monaco-editor/languages/definitions/python/python"),
  rust: () => import("monaco-editor/languages/definitions/rust/rust"),
  go: () => import("monaco-editor/languages/definitions/go/go"),
  java: () => import("monaco-editor/languages/definitions/java/java"),
  kotlin: () => import("monaco-editor/languages/definitions/kotlin/kotlin"),
  swift: () => import("monaco-editor/languages/definitions/swift/swift"),
  c: () => import("monaco-editor/languages/definitions/cpp/cpp"),
  cpp: () => import("monaco-editor/languages/definitions/cpp/cpp"),
  csharp: () => import("monaco-editor/languages/definitions/csharp/csharp"),
  ruby: () => import("monaco-editor/languages/definitions/ruby/ruby"),
  php: () => import("monaco-editor/languages/definitions/php/php"),
  sql: () => import("monaco-editor/languages/definitions/sql/sql"),
  lua: () => import("monaco-editor/languages/definitions/lua/lua"),
  dart: () => import("monaco-editor/languages/definitions/dart/dart"),
  elixir: () => import("monaco-editor/languages/definitions/elixir/elixir"),
  graphql: () => import("monaco-editor/languages/definitions/graphql/graphql"),
  dockerfile: () => import("monaco-editor/languages/definitions/dockerfile/dockerfile"),
  powershell: () => import("monaco-editor/languages/definitions/powershell/powershell"),
  perl: () => import("monaco-editor/languages/definitions/perl/perl"),
  r: () => import("monaco-editor/languages/definitions/r/r"),
  scala: () => import("monaco-editor/languages/definitions/scala/scala"),
  toml: () => import("monaco-editor/languages/definitions/ini/ini"),
  ini: () => import("monaco-editor/languages/definitions/ini/ini"),
};
// Languages without a bundled configuration still get matching brackets and
// closing quotes; JSON and friends need nothing more.
const GENERIC_CONFIGURATION: monaco.languages.LanguageConfiguration = {
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "'", close: "'", notIn: ["string"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

/**
 * The model language for a workspace path: Shiki's id, shared with the
 * previews. The id is registered with the engine on the spot, because a model
 * created with an unknown language silently falls back to plain text.
 */
export function editorLanguageForPath(pathValue: string): string {
  const language = getSyntaxLanguageForPath(pathValue);
  if (language === "text") return "plaintext";
  if (!monaco.languages.getLanguages().some((item) => item.id === language))
    monaco.languages.register({ id: language });
  return language;
}

class ShikiTokenizerState implements monaco.languages.IState {
  constructor(readonly ruleStack: unknown) {}
  clone() {
    return new ShikiTokenizerState(this.ruleStack);
  }
  equals(other: monaco.languages.IState) {
    return other instanceof ShikiTokenizerState && other.ruleStack === this.ruleStack;
  }
}

let activeTheme: DiffThemeName = resolveDiffThemeName("dark");
export function setEditorHighlightingTheme(theme: "light" | "dark") {
  activeTheme = resolveDiffThemeName(theme);
}

function tokensProvider(
  highlighter: DiffsHighlighter,
  language: string,
): monaco.languages.TokensProvider {
  const grammar = highlighter.getLanguage(language);
  return {
    getInitialState: () => new ShikiTokenizerState(null),
    tokenize(line, state) {
      if (line.length > 20_000) return { endState: state, tokens: [{ startIndex: 0, scopes: "" }] };
      // Previews can switch the shared registry's theme between calls, so pin
      // the editor's theme before every line; the registry caches the switch.
      highlighter.setTheme(activeTheme);
      const result = grammar.tokenizeLine2(
        line,
        (state as ShikiTokenizerState).ruleStack as never,
        500,
      );
      const tokens: monaco.languages.IToken[] = [];
      for (let index = 0; index < result.tokens.length; index += 2) {
        const metadata = result.tokens[index + 1]!;
        const color = (metadata & FOREGROUND_MASK) >>> FOREGROUND_OFFSET;
        const style = (metadata & FONT_STYLE_MASK) >>> FONT_STYLE_OFFSET;
        tokens.push({ startIndex: result.tokens[index]!, scopes: tokenName(color, style) });
      }
      return { endState: new ShikiTokenizerState(result.ruleStack), tokens };
    },
  };
}

function tokenName(color: number, style: number) {
  let name = `shiki${color}`;
  FONT_STYLE_NAMES.forEach((flag, bit) => {
    if (style & (1 << bit)) name += `.${flag}`;
  });
  return name;
}

/** `rrggbb` for a theme colour; short hex is expanded, anything else is skipped. */
function monacoHex(color: string | undefined): string | null {
  const match = /^#?([0-9a-f]{3,8})$/i.exec(color?.trim() ?? "");
  if (!match) return null;
  const digits = match[1]!;
  const expanded =
    digits.length < 6
      ? digits
          .slice(0, 3)
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : digits.slice(0, 6);
  return expanded.length === 6 ? expanded.toLowerCase() : null;
}

/** Monaco theme rules naming every colour of the Shiki theme, incl. font-style variants. */
export function editorTokenRules(
  highlighter: DiffsHighlighter | null,
  theme: "light" | "dark",
): monaco.editor.ITokenThemeRule[] {
  if (!highlighter) return [];
  const { colorMap } = highlighter.setTheme(resolveDiffThemeName(theme));
  const rules: monaco.editor.ITokenThemeRule[] = [];
  colorMap.forEach((color, index) => {
    const foreground = monacoHex(color);
    if (!foreground) return;
    for (let style = 0; style < 1 << FONT_STYLE_NAMES.length; style++) {
      const fontStyle = FONT_STYLE_NAMES.filter((_, bit) => style & (1 << bit)).join(" ");
      rules.push({
        token: tokenName(index, style),
        foreground,
        ...(fontStyle ? { fontStyle } : {}),
      });
    }
  });
  return rules;
}

const registered = new Map<string, Promise<DiffsHighlighter>>();

/**
 * Registers `language` with Monaco (once) with Shiki tokenization and the
 * engine's bundled language configuration, and resolves the shared highlighter
 * with that grammar loaded. Plain text needs no registration.
 */
export function ensureEditorLanguage(language: string): Promise<DiffsHighlighter> {
  let pending = registered.get(language);
  if (pending) return pending;
  pending = (async () => {
    const highlighter = await getSyntaxHighlighterPromise(
      language === "plaintext" ? "text" : language,
    );
    if (language === "plaintext") return highlighter;
    if (!monaco.languages.getLanguages().some((item) => item.id === language))
      monaco.languages.register({ id: language });
    const definition = await definitions[language]?.().catch(() => undefined);
    monaco.languages.setLanguageConfiguration(language, definition?.conf ?? GENERIC_CONFIGURATION);
    if (highlighter.getLoadedLanguages().includes(language))
      monaco.languages.setTokensProvider(language, tokensProvider(highlighter, language));
    return highlighter;
  })();
  pending.catch(() => registered.delete(language));
  registered.set(language, pending);
  return pending;
}
