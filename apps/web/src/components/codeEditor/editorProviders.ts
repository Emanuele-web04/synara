// FILE: editorProviders.ts
// Purpose: Bridge the engine's in-editor language features (completion, hover,
//          signature help, ctrl-click definition, formatting, folding) to the
//          server's project-aware TypeScript service. Navigation pickers,
//          rename, code actions and diagnostics go through Synara's own UI in
//          MonacoEditorSurface instead of engine widgets.
// Layer: Web editor runtime
// Exports: registerEditorProviders, INTELLIGENCE_LANGUAGES

import * as monaco from "monaco-editor/editor/editor.api";
import {
  editorEntry,
  editorUri,
  entryForUri,
  locationRange,
  offsetRange,
  requestIntelligence,
} from "./editorModels";

/** Shiki language ids the project language service understands. */
export const INTELLIGENCE_LANGUAGES = ["typescript", "tsx", "javascript", "jsx"] as const;
const selector = INTELLIGENCE_LANGUAGES.map((language) => ({
  language,
  scheme: "synara-workspace",
}));
const kinds: Record<string, monaco.languages.CompletionItemKind> = {
  method: monaco.languages.CompletionItemKind.Method,
  function: monaco.languages.CompletionItemKind.Function,
  class: monaco.languages.CompletionItemKind.Class,
  interface: monaco.languages.CompletionItemKind.Interface,
  var: monaco.languages.CompletionItemKind.Variable,
  const: monaco.languages.CompletionItemKind.Constant,
  let: monaco.languages.CompletionItemKind.Variable,
  parameter: monaco.languages.CompletionItemKind.Variable,
  property: monaco.languages.CompletionItemKind.Property,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  module: monaco.languages.CompletionItemKind.Module,
  enum: monaco.languages.CompletionItemKind.Enum,
  "enum member": monaco.languages.CompletionItemKind.EnumMember,
  type: monaco.languages.CompletionItemKind.TypeParameter,
};
// Repository documentation is plain text, never trusted markdown, HTML or command links.
const plainText = (text: string): monaco.IMarkdownString => ({
  value: text.replace(/[\\`*_{}[\]()<>#+.!|-]/g, "\\$&"),
  isTrusted: false,
  supportHtml: false,
});
type CompletionMetadata = {
  uri: string;
  version: number;
  offset: number;
  label: string;
  source?: string | undefined;
};

export function registerEditorProviders() {
  const disposables: monaco.IDisposable[] = [
    monaco.languages.registerCompletionItemProvider(selector, {
      triggerCharacters: [".", '"', "'", "/", "@"],
      async provideCompletionItems(model, position, _context, token) {
        const entry = editorEntry(model);
        if (!entry) return;
        const offset = model.getOffsetAt(position);
        const result = await requestIntelligence(entry, "completion", { offset, token });
        return {
          suggestions: (result?.completions ?? []).map((item) => ({
            label: item.label,
            insertText: item.insertText,
            kind: kinds[item.kind] ?? monaco.languages.CompletionItemKind.Text,
            sortText: item.sortText,
            range: offsetRange(model, item.replacement),
            ...(item.source ? { detail: item.source } : {}),
            synara: {
              uri: model.uri.toString(),
              version: model.getVersionId(),
              offset,
              label: item.label,
              source: item.source,
            } satisfies CompletionMetadata,
          })),
        };
      },
      async resolveCompletionItem(item, token) {
        const metadata = (item as monaco.languages.CompletionItem & { synara?: CompletionMetadata })
          .synara;
        if (!metadata) return item;
        const entry = entryForUri(monaco.Uri.parse(metadata.uri));
        if (!entry || entry.model.getVersionId() !== metadata.version) return item;
        const result = await requestIntelligence(entry, "completionResolve", {
          offset: metadata.offset,
          query: metadata.label,
          token,
          ...(metadata.source ? { completionSource: metadata.source } : {}),
        });
        return result?.text ? { ...item, documentation: plainText(result.text) } : item;
      },
    }),
    monaco.languages.registerHoverProvider(selector, {
      async provideHover(model, position, token) {
        const entry = editorEntry(model);
        if (!entry) return;
        const result = await requestIntelligence(entry, "hover", {
          offset: model.getOffsetAt(position),
          token,
        });
        if (!result?.text) return;
        return {
          contents: [plainText(result.text)],
          ...(result.span ? { range: offsetRange(model, result.span) } : {}),
        };
      },
    }),
    monaco.languages.registerSignatureHelpProvider(selector, {
      signatureHelpTriggerCharacters: ["(", ",", "<"],
      signatureHelpRetriggerCharacters: [")"],
      async provideSignatureHelp(model, position, token) {
        const entry = editorEntry(model);
        if (!entry) return;
        const result = await requestIntelligence(entry, "signature", {
          offset: model.getOffsetAt(position),
          token,
        });
        if (!result?.signatures?.length) return;
        return {
          value: {
            signatures: result.signatures.map((item) => ({
              ...item,
              parameters: [...item.parameters],
            })),
            activeSignature: result.activeSignature ?? 0,
            activeParameter: result.activeParameter ?? 0,
          },
          dispose() {},
        };
      },
    }),
    // Ctrl/Cmd-click links; F12 and the pickers resolve locations themselves.
    monaco.languages.registerDefinitionProvider(selector, {
      async provideDefinition(model, position, token) {
        const entry = editorEntry(model);
        if (!entry) return [];
        const result = await requestIntelligence(entry, "definition", {
          offset: model.getOffsetAt(position),
          token,
        });
        return (result?.locations ?? []).map((location) => ({
          uri: editorUri(entry.client, entry.cwd, location.relativePath),
          range: locationRange(location),
        }));
      },
    }),
    monaco.languages.registerDocumentFormattingEditProvider(selector, {
      displayName: "Synara TypeScript",
      async provideDocumentFormattingEdits(model, _options, token) {
        const entry = editorEntry(model);
        if (!entry) return [];
        const result = await requestIntelligence(entry, "format", { token });
        return (result?.edits?.[0]?.edits ?? []).map((edit) => ({
          range: offsetRange(model, edit),
          text: edit.newText,
        }));
      },
    }),
    monaco.languages.registerDocumentRangeFormattingEditProvider(selector, {
      async provideDocumentRangeFormattingEdits(model, range, _options, token) {
        const entry = editorEntry(model);
        if (!entry) return [];
        const offset = model.getOffsetAt(range.getStartPosition());
        const length = model.getOffsetAt(range.getEndPosition()) - offset;
        const result = await requestIntelligence(entry, "format", { offset, length, token });
        return (result?.edits?.[0]?.edits ?? []).map((edit) => ({
          range: offsetRange(model, edit),
          text: edit.newText,
        }));
      },
    }),
    monaco.languages.registerFoldingRangeProvider(selector, {
      async provideFoldingRanges(model, _context, token) {
        const entry = editorEntry(model);
        if (!entry) return [];
        const result = await requestIntelligence(entry, "folding", { token });
        return (result?.folding ?? [])
          .map((span) => ({
            start: model.getPositionAt(span.start).lineNumber,
            end: model.getPositionAt(span.start + span.length).lineNumber,
          }))
          .filter((range) => range.end > range.start);
      },
    }),
  ];
  return { dispose: () => disposables.forEach((item) => item.dispose()) };
}
