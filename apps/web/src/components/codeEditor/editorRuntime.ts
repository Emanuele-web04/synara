import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/features/register.all";
import { typescript } from "monaco-editor/languages/register.all";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker";
import CssWorker from "monaco-editor/languages/features/css/css.worker?worker";
import HtmlWorker from "monaco-editor/languages/features/html/html.worker?worker";
import { registerEditorProviders } from "./editorProviders";

// TS/JS use the project-aware server compiler, never a second browser compiler.
const disabled = {
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  definitions: false,
  references: false,
  documentHighlights: false,
  rename: false,
  diagnostics: false,
  documentRangeFormattingEdits: false,
  documentFormattingEdits: false,
  signatureHelp: false,
  inlayHints: false,
};
typescript.typescriptDefaults.setModeConfiguration(disabled);
typescript.javascriptDefaults.setModeConfiguration(disabled);
(globalThis as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === "json") return new JsonWorker();
    if (["css", "scss", "less"].includes(label)) return new CssWorker();
    if (["html", "handlebars", "razor"].includes(label)) return new HtmlWorker();
    return new EditorWorker();
  },
};
registerEditorProviders();

function color(style: CSSStyleDeclaration, name: string, fallback: string) {
  const value = style.getPropertyValue(name).trim();
  if (!value) return fallback;
  // Monaco accepts hex colors; Synara themes also use oklch/color-mix tokens.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) return fallback;
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  return (
    "#" +
    [...context.getImageData(0, 0, 1, 1).data]
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")
  );
}
export function editorAppearance(
  container: HTMLElement,
  theme: "light" | "dark",
): monaco.editor.IStandaloneEditorConstructionOptions {
  const style = getComputedStyle(container);
  const dark = theme === "dark";
  const background = color(style, "--background", dark ? "#18181b" : "#ffffff");
  const foreground = color(style, "--foreground", dark ? "#e4e4e7" : "#27272a");
  const muted = color(style, "--muted-foreground", "#71717a");
  const border = color(style, "--border", dark ? "#3f3f46" : "#e4e4e7");
  const popover = color(style, "--popover", background);
  monaco.editor.defineTheme(`synara-${theme}`, {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": background,
      "editor.foreground": foreground,
      "editorLineNumber.foreground": muted,
      "editorGutter.background": background,
      "editorWidget.background": popover,
      "editorWidget.border": border,
      "editorSuggestWidget.background": popover,
      "editorSuggestWidget.foreground": foreground,
      "editorSuggestWidget.border": border,
      "editorHoverWidget.background": popover,
      "editorHoverWidget.foreground": foreground,
      "editorHoverWidget.border": border,
      "input.background": background,
      "input.foreground": foreground,
      "input.border": border,
    },
  });
  return {
    theme: `synara-${theme}`,
    fontFamily: style.getPropertyValue("--font-chat-code-family").trim() || "monospace",
    fontSize: Number.parseFloat(style.getPropertyValue("--app-font-size-chat-code")) || 13,
    minimap: { enabled: false },
    contextmenu: false,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    overviewRulerBorder: false,
    scrollbar: {
      useShadows: false,
      verticalScrollbarSize: 12,
      horizontalScrollbarSize: 12,
      verticalSliderSize: 12,
      horizontalSliderSize: 12,
      alwaysConsumeMouseWheel: false,
    },
    fixedOverflowWidgets: true,
    padding: { top: 8, bottom: 8 },
    renderLineHighlight: "gutter",
    stickyScroll: { enabled: false },
    glyphMargin: true,
    folding: true,
    showFoldingControls: "mouseover",
    wordBasedSuggestions: "off",
    inlayHints: { enabled: "onUnlessPressed" },
    "semanticHighlighting.enabled": true,
    tabFocusMode: false,
    cursorSmoothCaretAnimation: "off",
    smoothScrolling: false,
    accessibilitySupport: "auto",
    bracketPairColorization: { enabled: true },
  };
}
export { monaco };
