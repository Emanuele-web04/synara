// FILE: editorProviders.ts
// Purpose: Bridge the engine's language features for TypeScript and JavaScript
//          (completion, hover, signature help, navigation, peek, symbols, code
//          actions, inlay hints, formatting, folding) to the server's
//          project-aware TypeScript service. Rename and workspace-symbol search
//          go through Synara's own dialog and picker in MonacoEditorSurface.
// Layer: Web editor runtime
// Exports: registerEditorProviders, INTELLIGENCE_LANGUAGES, APPLY_EDITS_COMMAND

import * as monaco from "monaco-editor/editor/editor.api";
import type { EditorFileEdits, EditorIntelligenceResult } from "@synara/contracts";

import {
  applyEditorEdits,
  editorEntry,
  editorUri,
  ensureEditorModels,
  entryForUri,
  locationRange,
  offsetRange,
  requestIntelligence,
  setEditorServiceStatus,
  type EditorModelEntry,
} from "./editorModels";

/** Shiki language ids the project language service understands. */
export const INTELLIGENCE_LANGUAGES = ["typescript", "tsx", "javascript", "jsx"] as const;
/** The engine command that applies a code action's edits through the shared transaction. */
export const APPLY_EDITS_COMMAND = "synara.editor.applyEdits";
const selector = INTELLIGENCE_LANGUAGES.map((language) => ({
  language,
  scheme: "synara-workspace",
}));
const kinds: Record<string, monaco.languages.CompletionItemKind> = {
  method: monaco.languages.CompletionItemKind.Method,
  function: monaco.languages.CompletionItemKind.Function,
  constructor: monaco.languages.CompletionItemKind.Constructor,
  property: monaco.languages.CompletionItemKind.Property,
  var: monaco.languages.CompletionItemKind.Variable,
  let: monaco.languages.CompletionItemKind.Variable,
  const: monaco.languages.CompletionItemKind.Constant,
  parameter: monaco.languages.CompletionItemKind.Variable,
  class: monaco.languages.CompletionItemKind.Class,
  interface: monaco.languages.CompletionItemKind.Interface,
  module: monaco.languages.CompletionItemKind.Module,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  enum: monaco.languages.CompletionItemKind.Enum,
  "enum member": monaco.languages.CompletionItemKind.EnumMember,
  type: monaco.languages.CompletionItemKind.TypeParameter,
};
const symbolKinds: Record<string, monaco.languages.SymbolKind> = {
  class: monaco.languages.SymbolKind.Class,
  interface: monaco.languages.SymbolKind.Interface,
  function: monaco.languages.SymbolKind.Function,
  method: monaco.languages.SymbolKind.Method,
  constructor: monaco.languages.SymbolKind.Constructor,
  property: monaco.languages.SymbolKind.Property,
  getter: monaco.languages.SymbolKind.Property,
  setter: monaco.languages.SymbolKind.Property,
  var: monaco.languages.SymbolKind.Variable,
  let: monaco.languages.SymbolKind.Variable,
  const: monaco.languages.SymbolKind.Constant,
  module: monaco.languages.SymbolKind.Module,
  enum: monaco.languages.SymbolKind.Enum,
  "enum member": monaco.languages.SymbolKind.EnumMember,
  type: monaco.languages.SymbolKind.TypeParameter,
  alias: monaco.languages.SymbolKind.Variable,
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
type Symbols = NonNullable<EditorIntelligenceResult["symbols"]>;

/** Document symbols as the engine's tree: the server lists them flat, in document order, with extents. */
function symbolTree(symbols: Symbols): monaco.languages.DocumentSymbol[] {
  const roots: monaco.languages.DocumentSymbol[] = [];
  const open: { symbol: monaco.languages.DocumentSymbol; end: number }[] = [];
  for (const symbol of symbols) {
    const extent = symbol.extent ?? symbol.location;
    const node: monaco.languages.DocumentSymbol = {
      name: symbol.name,
      detail: "",
      kind: symbolKinds[symbol.kind] ?? monaco.languages.SymbolKind.Variable,
      tags: [],
      range: locationRange(extent),
      selectionRange: locationRange(symbol.location),
      children: [],
    };
    while (open.length && extent.start >= open[open.length - 1]!.end) open.pop();
    (open.length ? open[open.length - 1]!.symbol.children! : roots).push(node);
    open.push({ symbol: node, end: extent.start + extent.length });
  }
  return roots;
}

/**
 * Locations the engine can peek: models for other workspace files are loaded
 * first, and a file that could not be loaded (read-only format, capacity, the
 * dependency bound) is left out rather than handed over without a model.
 */
async function peekableLocations(
  entry: EditorModelEntry,
  locations: EditorIntelligenceResult["locations"],
  token: monaco.CancellationToken,
) {
  const results = locations ?? [];
  await ensureEditorModels(
    entry,
    results.map((location) => location.relativePath),
  );
  if (token.isCancellationRequested) return [];
  return results.flatMap((location) => {
    const uri = editorUri(entry.client, entry.cwd, location.relativePath);
    return location.relativePath === entry.relativePath || monaco.editor.getModel(uri)
      ? [{ uri, range: locationRange(location) }]
      : [];
  });
}

export function registerEditorProviders() {
  const navigation =
    (operation: "definition" | "typeDefinition" | "references") =>
    async (
      model: monaco.editor.ITextModel,
      position: monaco.Position,
      token: monaco.CancellationToken,
    ) => {
      const entry = editorEntry(model);
      if (!entry) return [];
      const result = await requestIntelligence(entry, operation, {
        offset: model.getOffsetAt(position),
        token,
      });
      return peekableLocations(entry, result?.locations, token);
    };
  const disposables: monaco.IDisposable[] = [
    monaco.editor.registerCommand(
      APPLY_EDITS_COMMAND,
      async (_accessor, uri: string, edits: readonly EditorFileEdits[]) => {
        const entry = entryForUri(monaco.Uri.parse(uri));
        if (!entry) throw new Error("The source document is no longer open.");
        // The standalone engine only logs command failures; a stale buffer or
        // conflict must reach the surface's notice bar instead.
        try {
          await applyEditorEdits(entry, edits);
        } catch (error) {
          setEditorServiceStatus(
            entry,
            error instanceof Error ? error.message : "The code action did not apply.",
          );
        }
      },
    ),
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
            kind: kinds[item.kind] ?? monaco.languages.CompletionItemKind.Text,
            sortText: item.sortText,
            insertText: item.insertText,
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
    // Ctrl/Cmd-click, F12, peek definition/references and Alt+F12 resolve
    // through these; other workspace files open through Synara's file opener.
    monaco.languages.registerDefinitionProvider(selector, {
      provideDefinition: navigation("definition"),
    }),
    monaco.languages.registerTypeDefinitionProvider(selector, {
      provideTypeDefinition: navigation("typeDefinition"),
    }),
    monaco.languages.registerReferenceProvider(selector, {
      provideReferences: (model, position, _context, token) =>
        navigation("references")(model, position, token),
    }),
    // Outline for sticky headers, diff breadcrumbs and the symbol picker.
    monaco.languages.registerDocumentSymbolProvider(selector, {
      displayName: "Synara TypeScript",
      async provideDocumentSymbols(model, token) {
        const entry = editorEntry(model);
        if (!entry) return [];
        const result = await requestIntelligence(entry, "documentSymbols", { token });
        return symbolTree(result?.symbols ?? []);
      },
    }),
    // Lightbulb, quick fix, refactor and organize-imports menus; every edit
    // applies through the shared multi-file transaction.
    monaco.languages.registerCodeActionProvider(
      selector,
      {
        async provideCodeActions(model, range, context, token) {
          const entry = editorEntry(model);
          if (!entry) return { actions: [], dispose() {} };
          const offset = model.getOffsetAt(range.getStartPosition());
          const length = model.getOffsetAt(range.getEndPosition()) - offset;
          const result =
            context.only === "source.organizeImports"
              ? await requestIntelligence(entry, "organizeImports", { token })
              : await requestIntelligence(entry, "codeActions", { offset, length, token });
          const actions =
            result?.actions ??
            (result?.edits
              ? [{ title: "Organize imports", kind: "source.organizeImports", edits: result.edits }]
              : []);
          return {
            actions: actions
              .filter((action) => !context.only || action.kind.startsWith(context.only))
              .map((action) => ({
                title: action.title,
                kind: action.kind,
                diagnostics: context.markers.filter((marker) =>
                  monaco.Range.areIntersecting(marker, range),
                ),
                command: {
                  id: APPLY_EDITS_COMMAND,
                  title: action.title,
                  arguments: [model.uri.toString(), action.edits],
                },
              })),
            dispose() {},
          };
        },
      },
      { providedCodeActionKinds: ["quickfix", "refactor", "source.organizeImports"] },
    ),
    monaco.languages.registerInlayHintsProvider(selector, {
      async provideInlayHints(model, range, token) {
        const entry = editorEntry(model);
        if (!entry) return { hints: [], dispose() {} };
        const offset = model.getOffsetAt(range.getStartPosition());
        const length = model.getOffsetAt(range.getEndPosition()) - offset;
        const result = await requestIntelligence(entry, "inlayHints", { offset, length, token });
        return {
          hints: (result?.hints ?? []).map((hint) => ({
            position: model.getPositionAt(hint.offset),
            label: hint.text,
            kind:
              hint.kind === "parameter"
                ? monaco.languages.InlayHintKind.Parameter
                : monaco.languages.InlayHintKind.Type,
            paddingLeft: hint.whitespaceBefore,
            paddingRight: hint.whitespaceAfter,
          })),
          dispose() {},
        };
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
