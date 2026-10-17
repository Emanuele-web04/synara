// FILE: editorRuntime.ts
// Purpose: Load the standalone editor engine once with only the editing
//          features Synara exposes, and build its appearance from Synara's
//          theme tokens and the shared Shiki highlighter.
// Layer: Web editor runtime
// Exports: monaco, editorAppearance, EDITOR_LINE_HEIGHT_PX
// Depends on: editorHighlighting (tokenization), editorProviders (language service bridge).

import * as monaco from "monaco-editor/editor/editor.api";
// Editing features only. Engine chrome that duplicates Synara surfaces stays
// out: command palette, quick outline, peek views, rename box, lightbulb, code
// lens, inlay hints, sticky scroll, context menu, inline completions.
import "monaco-editor/features/codeEditor/register";
import "monaco-editor/features/diffEditor/register";
import "monaco-editor/features/bracketMatching/register";
import "monaco-editor/features/caretOperations/register";
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/comment/register";
import "monaco-editor/features/cursorUndo/register";
import "monaco-editor/features/dnd/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/folding/register";
import "monaco-editor/features/format/register";
import "monaco-editor/features/gotoSymbol/register";
import "monaco-editor/features/hover/register";
import "monaco-editor/features/indentation/register";
import "monaco-editor/features/inlineProgress/register";
import "monaco-editor/features/lineSelection/register";
import "monaco-editor/features/linesOperations/register";
import "monaco-editor/features/longLinesHelper/register";
import "monaco-editor/features/multicursor/register";
import "monaco-editor/features/parameterHints/register";
import "monaco-editor/features/readOnlyMessage/register";
import "monaco-editor/features/smartSelect/register";
import "monaco-editor/features/snippet/register";
import "monaco-editor/features/suggest/register";
// The completion controller itself only ships with the inline-completions
// feature, which stays out; register it directly.
import "monaco-editor/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/features/toggleTabFocusMode/register";
import "monaco-editor/features/tokenization/register";
import "monaco-editor/features/unicodeHighlighter/register";
import "monaco-editor/features/unusualLineTerminators/register";
import "monaco-editor/features/wordHighlighter/register";
import "monaco-editor/features/wordOperations/register";
import "monaco-editor/features/wordPartOperations/register";
import "monaco-editor/features/codicon/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import type { DiffsHighlighter } from "@pierre/diffs";

import { editorTokenRules, setEditorHighlightingTheme } from "./editorHighlighting";
import { registerEditorProviders } from "./editorProviders";

(globalThis as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};
const providers = registerEditorProviders();
if (import.meta.hot) import.meta.hot.dispose(() => providers.dispose());

/** Row height shared with the Pierre previews (`--diffs-line-height`). */
export const EDITOR_LINE_HEIGHT_PX = 20;

function hex(channel: number) {
  return channel.toString(16).padStart(2, "0");
}
/** Resolves a CSS colour token to the `#rrggbb` form the engine accepts. */
function tokenColor(style: CSSStyleDeclaration, name: string, fallback: string) {
  const value = style.getPropertyValue(name).trim();
  if (!value) return fallback;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) return fallback;
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
const alpha = (color: string, opacity: number) =>
  `${color.slice(0, 7)}${hex(Math.round(opacity * 255))}`;

/**
 * The engine's construction options for a surface: Synara's theme tokens for
 * every colour, the shared Shiki theme for syntax, and the chat code font.
 * Re-run when the theme or the typography settings change.
 */
export function editorAppearance(
  container: HTMLElement,
  theme: "light" | "dark",
  highlighter: DiffsHighlighter | null,
): monaco.editor.IStandaloneEditorConstructionOptions {
  const style = getComputedStyle(container);
  const dark = theme === "dark";
  const color = (name: string, fallback: string) => tokenColor(style, name, fallback);
  const background = color("--background", dark ? "#18181b" : "#ffffff");
  const surface = color("--app-code-viewer-surface", background);
  const foreground = color("--foreground", dark ? "#e4e4e7" : "#27272a");
  const muted = color("--muted-foreground", "#71717a");
  const border = color("--border", dark ? "#3f3f46" : "#e4e4e7");
  const popover = color("--popover", background);
  const accent = color("--color-text-accent", dark ? "#8ab4f8" : "#1a73e8");
  const selected = color("--color-background-button-secondary", alpha(foreground, 0.08));
  const hover = color("--color-background-button-secondary-hover", alpha(foreground, 0.05));
  const success = color("--success", "#16a34a");
  const destructive = color("--destructive", "#dc2626");
  const warning = color("--warning", "#d97706");
  const info = color("--info", accent);
  const name = `synara-${theme}`;
  setEditorHighlightingTheme(theme);
  monaco.editor.defineTheme(name, {
    base: dark ? "vs-dark" : "vs",
    inherit: false,
    rules: editorTokenRules(highlighter, theme),
    colors: {
      "editor.background": surface,
      "editor.foreground": foreground,
      "editorGutter.background": surface,
      "editorLineNumber.foreground": alpha(muted, 0.7),
      "editorLineNumber.activeForeground": foreground,
      "editor.lineHighlightBackground": alpha(foreground, 0.04),
      "editor.lineHighlightBorder": "#00000000",
      "editorCursor.foreground": foreground,
      "editor.selectionBackground": alpha(accent, 0.24),
      "editor.inactiveSelectionBackground": alpha(accent, 0.12),
      "editor.selectionHighlightBackground": alpha(accent, 0.1),
      "editor.wordHighlightBackground": alpha(foreground, 0.08),
      "editor.wordHighlightStrongBackground": alpha(foreground, 0.12),
      "editor.findMatchBackground": alpha(accent, 0.36),
      "editor.findMatchHighlightBackground": alpha(accent, 0.16),
      "editor.rangeHighlightBackground": alpha(accent, 0.08),
      "editorIndentGuide.background1": alpha(border, 0.55),
      "editorIndentGuide.activeBackground1": border,
      "editorBracketMatch.background": alpha(foreground, 0.08),
      "editorBracketMatch.border": alpha(border, 0.9),
      "editorWhitespace.foreground": alpha(muted, 0.3),
      "editorError.foreground": destructive,
      "editorWarning.foreground": warning,
      "editorInfo.foreground": info,
      "editorHint.foreground": muted,
      "editorUnnecessaryCode.opacity": "#00000080",
      "editorOverviewRuler.border": "#00000000",
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": alpha(foreground, 0.12),
      "scrollbarSlider.hoverBackground": alpha(foreground, 0.2),
      "scrollbarSlider.activeBackground": alpha(foreground, 0.28),
      "widget.shadow": alpha("#000000", dark ? 0.4 : 0.14),
      "editorWidget.background": popover,
      "editorWidget.foreground": foreground,
      "editorWidget.border": border,
      "editorWidget.resizeBorder": border,
      "editorSuggestWidget.background": popover,
      "editorSuggestWidget.foreground": foreground,
      "editorSuggestWidget.border": border,
      "editorSuggestWidget.selectedBackground": selected,
      "editorSuggestWidget.selectedForeground": foreground,
      "editorSuggestWidget.highlightForeground": accent,
      "editorSuggestWidget.focusHighlightForeground": accent,
      "editorHoverWidget.background": popover,
      "editorHoverWidget.foreground": foreground,
      "editorHoverWidget.border": border,
      "editorHoverWidget.statusBarBackground": popover,
      "list.hoverBackground": hover,
      "list.activeSelectionBackground": selected,
      "list.activeSelectionForeground": foreground,
      "list.focusBackground": selected,
      "list.highlightForeground": accent,
      "list.focusHighlightForeground": accent,
      "input.background": background,
      "input.foreground": foreground,
      "input.border": border,
      "input.placeholderForeground": muted,
      "inputOption.activeBorder": accent,
      "inputOption.activeBackground": alpha(accent, 0.16),
      "inputOption.activeForeground": foreground,
      focusBorder: alpha(accent, 0.6),
      "textLink.foreground": accent,
      "textLink.activeForeground": accent,
      "editorLink.activeForeground": accent,
      "diffEditor.insertedTextBackground": alpha(success, 0.22),
      "diffEditor.removedTextBackground": alpha(destructive, 0.22),
      "diffEditor.insertedLineBackground": alpha(success, 0.1),
      "diffEditor.removedLineBackground": alpha(destructive, 0.1),
      "diffEditor.diagonalFill": alpha(border, 0.5),
      "diffEditor.border": border,
      "diffEditorGutter.insertedLineBackground": alpha(success, 0.14),
      "diffEditorGutter.removedLineBackground": alpha(destructive, 0.14),
      "button.background": accent,
      "button.foreground": background,
      "badge.background": selected,
      "badge.foreground": foreground,
      "keybindingLabel.background": alpha(foreground, 0.06),
      "keybindingLabel.foreground": foreground,
      "keybindingLabel.border": alpha(border, 0.8),
      "keybindingLabel.bottomBorder": alpha(border, 0.8),
    },
  });
  const lineHeight =
    Number.parseFloat(style.getPropertyValue("--diffs-line-height")) || EDITOR_LINE_HEIGHT_PX;
  return {
    theme: name,
    fontFamily: style.getPropertyValue("--font-chat-code-family").trim() || "monospace",
    fontSize: Number.parseFloat(style.getPropertyValue("--app-font-size-chat-code")) || 13,
    lineHeight,
    minimap: { enabled: false },
    contextmenu: false,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    fixedOverflowWidgets: true,
    padding: { top: 8, bottom: 8 },
    renderLineHighlight: "line",
    renderLineHighlightOnlyWhenFocus: true,
    stickyScroll: { enabled: false },
    glyphMargin: true,
    folding: true,
    showFoldingControls: "mouseover",
    lineNumbersMinChars: 3,
    lineDecorationsWidth: 12,
    overviewRulerBorder: false,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
    wordBasedSuggestions: "off",
    suggest: { preview: false, showStatusBar: false },
    lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off },
    codeLens: false,
    links: false,
    inlayHints: { enabled: "off" },
    "semanticHighlighting.enabled": false,
    bracketPairColorization: { enabled: false },
    guides: { bracketPairs: false, indentation: true },
    occurrencesHighlight: "singleFile",
    tabFocusMode: false,
    cursorSmoothCaretAnimation: "off",
    smoothScrolling: false,
    accessibilitySupport: "auto",
  };
}
export { monaco };
