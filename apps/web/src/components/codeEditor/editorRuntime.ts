// FILE: editorRuntime.ts
// Purpose: Load the standalone editor engine once with the editing features
//          Synara exposes, the JSON/CSS/HTML language workers, and build its
//          appearance from Synara's theme tokens and the shared Shiki theme.
// Layer: Web editor runtime
// Exports: monaco, editorAppearance, EDITOR_LINE_HEIGHT_PX
// Depends on: editorHighlighting (tokenization), editorProviders (language service bridge).

import * as monaco from "monaco-editor/editor/editor.api";
// Code OSS editing features. Chrome that duplicates Synara's own surfaces stays
// out: the command palette and quick-open pickers, the context menu, the inline
// rename box, code lens and inline completions (nothing provides them).
import "monaco-editor/features/codeEditor/register";
import "monaco-editor/features/diffEditor/register";
import "monaco-editor/features/diffEditorBreadcrumbs/register";
import "monaco-editor/features/anchorSelect/register";
import "monaco-editor/features/bracketMatching/register";
import "monaco-editor/features/caretOperations/register";
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/codeAction/register";
import "monaco-editor/features/colorPicker/register";
import "monaco-editor/features/comment/register";
import "monaco-editor/features/cursorUndo/register";
import "monaco-editor/features/dnd/register";
import "monaco-editor/features/documentSymbols/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/folding/register";
import "monaco-editor/features/format/register";
import "monaco-editor/features/gotoError/register";
import "monaco-editor/features/gotoSymbol/register";
// Go to / peek definition, type definition and references: the feature module
// above only registers ctrl-click links.
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands";
import "monaco-editor/features/hover/register";
import "monaco-editor/features/inPlaceReplace/register";
import "monaco-editor/features/indentation/register";
import "monaco-editor/features/inlayHints/register";
import "monaco-editor/features/inlineProgress/register";
import "monaco-editor/features/lineSelection/register";
import "monaco-editor/features/linesOperations/register";
import "monaco-editor/features/links/register";
import "monaco-editor/features/longLinesHelper/register";
import "monaco-editor/features/multicursor/register";
import "monaco-editor/features/parameterHints/register";
import "monaco-editor/features/readOnlyMessage/register";
import "monaco-editor/features/referenceSearch/register";
import "monaco-editor/features/sectionHeaders/register";
import "monaco-editor/features/smartSelect/register";
import "monaco-editor/features/snippet/register";
import "monaco-editor/features/stickyScroll/register";
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
// JSON, CSS/SCSS/LESS and HTML keep the engine's language workers (completion,
// hover, symbols, colours, folding, formatting, diagnostics). TypeScript and
// JavaScript use the project-aware server compiler instead, so the engine's
// TypeScript worker is never loaded. Shiki still tokenizes every language.
import { jsonDefaults } from "monaco-editor/languages/features/json/register";
import {
  cssDefaults,
  lessDefaults,
  scssDefaults,
} from "monaco-editor/languages/features/css/register";
import "monaco-editor/languages/features/html/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker";
import CssWorker from "monaco-editor/languages/features/css/css.worker?worker";
import HtmlWorker from "monaco-editor/languages/features/html/html.worker?worker";
import type { DiffsHighlighter } from "@pierre/diffs";

import {
  editorThemeColor,
  editorTokenRules,
  setEditorHighlightingTheme,
} from "./editorHighlighting";
import { registerEditorProviders } from "./editorProviders";

(globalThis as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    return new EditorWorker();
  },
};
jsonDefaults.setModeConfiguration({ ...jsonDefaults.modeConfiguration, tokens: false });
// Tailwind's @theme, @apply, @utility and friends are ordinary in Synara
// projects; the CSS service honours this lint rule though its typings omit it.
for (const defaults of [cssDefaults, scssDefaults, lessDefaults])
  defaults.setOptions({
    ...defaults.options,
    lint: { ...defaults.options.lint, unknownAtRules: "ignore" } as NonNullable<
      typeof defaults.options.lint
    >,
  });
const providers = registerEditorProviders();
if (import.meta.hot) import.meta.hot.dispose(() => providers.dispose());

/** Row height shared with the Pierre previews (`--diffs-line-height`). */
export const EDITOR_LINE_HEIGHT_PX = 20;

function hex(channel: number) {
  return channel.toString(16).padStart(2, "0");
}
// A colour the canvas never produces on its own, so an unparseable token is
// detected instead of painting black.
const UNSET_FILL = "#010203";
let colorContext: CanvasRenderingContext2D | null | undefined;
/**
 * Resolves a CSS colour token to the opaque `#rrggbb` form the engine accepts.
 * Synara's tokens are often translucent (`--alpha(... / 4%)`, `color-mix` with
 * transparent), so the token is composited over `base`, the surface it would
 * sit on; tokens the canvas cannot parse, and fully transparent ones, fall back.
 */
function tokenColor(style: CSSStyleDeclaration, name: string, fallback: string, base?: string) {
  const value = style.getPropertyValue(name).trim();
  if (!value) return fallback;
  if (colorContext === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    colorContext = canvas.getContext("2d", { willReadFrequently: true });
  }
  const context = colorContext;
  if (!context) return fallback;
  context.fillStyle = UNSET_FILL;
  context.fillStyle = value;
  if (context.fillStyle === UNSET_FILL) return fallback;
  const parsed = context.fillStyle;
  context.clearRect(0, 0, 1, 1);
  context.fillRect(0, 0, 1, 1);
  if (context.getImageData(0, 0, 1, 1).data[3] === 0) return fallback;
  if (base) {
    context.fillStyle = base;
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = parsed;
    context.fillRect(0, 0, 1, 1);
  }
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
const alpha = (color: string, opacity: number) =>
  `${color.slice(0, 7)}${hex(Math.round(opacity * 255))}`;

/**
 * The engine's construction options for a surface: Synara's theme tokens for
 * every colour, the shared Shiki theme for syntax and bracket pairs, and the
 * chat code font. Re-run when the theme or the typography settings change.
 */
export function editorAppearance(
  container: HTMLElement,
  theme: "light" | "dark",
  highlighter: DiffsHighlighter | null,
): monaco.editor.IStandaloneEditorConstructionOptions {
  const style = getComputedStyle(container);
  const dark = theme === "dark";
  const background = tokenColor(
    style,
    "--background",
    dark ? "#18181b" : "#ffffff",
    dark ? "#000000" : "#ffffff",
  );
  // Every other token is read as it would render over the background.
  const color = (name: string, fallback: string) => tokenColor(style, name, fallback, background);
  const surface = color("--app-code-viewer-surface", background);
  const sticky = color("--app-code-viewer-sticky-surface", surface);
  const elevated = color("--color-background-elevated-secondary", surface);
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
  // Bracket pair colours come from the same GitHub theme Shiki colours the code with.
  const shiki = (name: string, fallback: string) =>
    editorThemeColor(highlighter, theme, name) ?? fallback;
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
      "editorBracketHighlight.foreground1": shiki("editorBracketHighlight.foreground1", accent),
      "editorBracketHighlight.foreground2": shiki("editorBracketHighlight.foreground2", warning),
      "editorBracketHighlight.foreground3": shiki("editorBracketHighlight.foreground3", success),
      "editorBracketHighlight.foreground4": shiki("editorBracketHighlight.foreground4", accent),
      "editorBracketHighlight.foreground5": shiki("editorBracketHighlight.foreground5", warning),
      "editorBracketHighlight.foreground6": shiki("editorBracketHighlight.foreground6", success),
      "editorBracketHighlight.unexpectedBracket.foreground": destructive,
      "editorBracketPairGuide.background1": alpha(
        shiki("editorBracketHighlight.foreground1", accent),
        0.3,
      ),
      "editorBracketPairGuide.background2": alpha(
        shiki("editorBracketHighlight.foreground2", warning),
        0.3,
      ),
      "editorBracketPairGuide.background3": alpha(
        shiki("editorBracketHighlight.foreground3", success),
        0.3,
      ),
      "editorBracketPairGuide.activeBackground1": shiki(
        "editorBracketHighlight.foreground1",
        accent,
      ),
      "editorBracketPairGuide.activeBackground2": shiki(
        "editorBracketHighlight.foreground2",
        warning,
      ),
      "editorBracketPairGuide.activeBackground3": shiki(
        "editorBracketHighlight.foreground3",
        success,
      ),
      "editorWhitespace.foreground": alpha(muted, 0.3),
      "editorError.foreground": destructive,
      "editorWarning.foreground": warning,
      "editorInfo.foreground": info,
      "editorHint.foreground": muted,
      "editorUnnecessaryCode.opacity": "#00000080",
      "editorOverviewRuler.border": "#00000000",
      "editorInlayHint.background": alpha(muted, 0.14),
      "editorInlayHint.foreground": muted,
      "editorInlayHint.typeBackground": alpha(muted, 0.14),
      "editorInlayHint.typeForeground": muted,
      "editorInlayHint.parameterBackground": alpha(muted, 0.14),
      "editorInlayHint.parameterForeground": muted,
      "editorLightBulb.foreground": warning,
      "editorLightBulbAutoFix.foreground": accent,
      "editorLink.activeForeground": accent,
      "editorStickyScroll.background": sticky,
      "editorStickyScroll.border": alpha(border, 0.8),
      "editorStickyScroll.shadow": alpha("#000000", dark ? 0.3 : 0.08),
      "editorStickyScrollHover.background": hover,
      "editorStickyScrollGutter.background": sticky,
      "editorGutter.foldingControlForeground": muted,
      "editor.foldBackground": alpha(accent, 0.08),
      "editor.foldPlaceholderForeground": muted,
      "editorMarkerNavigation.background": popover,
      "editorMarkerNavigationError.background": destructive,
      "editorMarkerNavigationError.headerBackground": alpha(destructive, 0.1),
      "editorMarkerNavigationWarning.background": warning,
      "editorMarkerNavigationWarning.headerBackground": alpha(warning, 0.1),
      "editorMarkerNavigationInfo.background": info,
      "editorMarkerNavigationInfo.headerBackground": alpha(info, 0.1),
      "problemsErrorIcon.foreground": destructive,
      "problemsWarningIcon.foreground": warning,
      "problemsInfoIcon.foreground": info,
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": alpha(foreground, 0.12),
      "scrollbarSlider.hoverBackground": alpha(foreground, 0.2),
      "scrollbarSlider.activeBackground": alpha(foreground, 0.28),
      "widget.shadow": alpha("#000000", dark ? 0.4 : 0.14),
      "widget.border": border,
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
      "editorHoverWidget.highlightForeground": accent,
      "editorActionList.background": popover,
      "editorActionList.foreground": foreground,
      "editorActionList.focusBackground": selected,
      "editorActionList.focusForeground": foreground,
      "peekView.border": alpha(accent, 0.6),
      "peekViewTitle.background": elevated,
      "peekViewTitleLabel.foreground": foreground,
      "peekViewTitleDescription.foreground": muted,
      "peekViewEditor.background": surface,
      "peekViewEditorGutter.background": surface,
      "peekViewEditorStickyScroll.background": sticky,
      "peekViewEditorStickyScrollGutter.background": sticky,
      "peekViewEditor.matchHighlightBackground": alpha(accent, 0.24),
      "peekViewEditor.matchHighlightBorder": "#00000000",
      "peekViewResult.background": popover,
      "peekViewResult.fileForeground": foreground,
      "peekViewResult.lineForeground": muted,
      "peekViewResult.matchHighlightBackground": alpha(accent, 0.24),
      "peekViewResult.selectionBackground": selected,
      "peekViewResult.selectionForeground": foreground,
      "list.hoverBackground": hover,
      "list.activeSelectionBackground": selected,
      "list.activeSelectionForeground": foreground,
      "list.inactiveSelectionBackground": alpha(foreground, 0.06),
      "list.focusBackground": selected,
      "list.highlightForeground": accent,
      "list.focusHighlightForeground": accent,
      "tree.indentGuidesStroke": alpha(border, 0.8),
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
      "textCodeBlock.background": alpha(foreground, 0.06),
      "diffEditor.insertedTextBackground": alpha(success, 0.22),
      "diffEditor.removedTextBackground": alpha(destructive, 0.22),
      "diffEditor.insertedLineBackground": alpha(success, 0.1),
      "diffEditor.removedLineBackground": alpha(destructive, 0.1),
      "diffEditor.diagonalFill": alpha(border, 0.5),
      "diffEditor.border": border,
      "diffEditorGutter.insertedLineBackground": alpha(success, 0.14),
      "diffEditorGutter.removedLineBackground": alpha(destructive, 0.14),
      "diffEditor.unchangedRegionBackground": elevated,
      "diffEditor.unchangedRegionForeground": muted,
      "diffEditor.unchangedRegionShadow": alpha("#000000", dark ? 0.3 : 0.08),
      "diffEditor.unchangedCodeBackground": alpha(foreground, 0.03),
      "button.background": accent,
      "button.foreground": background,
      "badge.background": selected,
      "badge.foreground": foreground,
      "keybindingLabel.background": alpha(foreground, 0.06),
      "keybindingLabel.foreground": foreground,
      "keybindingLabel.border": alpha(border, 0.8),
      "keybindingLabel.bottomBorder": alpha(border, 0.8),
      "toolbar.hoverBackground": hover,
      "toolbar.activeBackground": selected,
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
    find: { addExtraSpaceOnTop: false },
    padding: { top: 8, bottom: 8 },
    renderLineHighlight: "line",
    renderLineHighlightOnlyWhenFocus: true,
    stickyScroll: { enabled: true, maxLineCount: 4 },
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
    lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.OnCode },
    codeLens: false,
    links: true,
    colorDecorators: true,
    inlayHints: { enabled: "onUnlessPressed" },
    "semanticHighlighting.enabled": false,
    bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: false },
    guides: { bracketPairs: "active", indentation: true },
    occurrencesHighlight: "singleFile",
    tabFocusMode: false,
    cursorSmoothCaretAnimation: "off",
    smoothScrolling: false,
    accessibilitySupport: "auto",
  };
}
export { monaco };
