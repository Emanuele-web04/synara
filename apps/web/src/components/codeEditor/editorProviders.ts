import * as monaco from "monaco-editor/editor/editor.api";
import type { EditorFileEdits } from "@synara/contracts";
import {
  applyEditorEdits,
  editorEntry,
  editorUri,
  entryForUri,
  locationRange,
  monacoWorkspaceEdits,
  offsetRange,
  requestIntelligence,
} from "./editorModels";

const selector = ["typescript", "javascript"].map((language) => ({
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
const symbolKinds: Record<string, monaco.languages.SymbolKind> = {
  class: monaco.languages.SymbolKind.Class,
  interface: monaco.languages.SymbolKind.Interface,
  function: monaco.languages.SymbolKind.Function,
  method: monaco.languages.SymbolKind.Method,
  property: monaco.languages.SymbolKind.Property,
  const: monaco.languages.SymbolKind.Constant,
  module: monaco.languages.SymbolKind.Module,
  enum: monaco.languages.SymbolKind.Enum,
};
const semanticLegend: monaco.languages.SemanticTokensLegend = {
  tokenTypes: [
    "class",
    "enum",
    "interface",
    "namespace",
    "typeParameter",
    "type",
    "parameter",
    "variable",
    "enumMember",
    "property",
    "function",
    "method",
  ],
  tokenModifiers: ["declaration", "static", "async", "readonly", "defaultLibrary", "local"],
};

export function registerEditorProviders() {
  const disposables: monaco.IDisposable[] = [];
  disposables.push(
    monaco.editor.registerCommand(
      "synara.editor.applyEdits",
      async (_accessor, uri: string, edits: readonly EditorFileEdits[]) => {
        const entry = entryForUri(monaco.Uri.parse(uri));
        if (!entry) throw new Error("The source document is no longer open.");
        await applyEditorEdits(entry, edits);
      },
    ),
  );
  disposables.push(
    monaco.languages.registerCompletionItemProvider(selector, {
      triggerCharacters: [".", '"', "'", "/", "@"],
      async provideCompletionItems(model, position, _context, token) {
        const entry = editorEntry(model);
        if (!entry) return;
        const result = await requestIntelligence(entry, "completion", {
          offset: model.getOffsetAt(position),
          token,
        });
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
              offset: model.getOffsetAt(position),
              label: item.label,
              source: item.source,
            },
          })),
        };
      },
      async resolveCompletionItem(item, token) {
        const metadata = (
          item as monaco.languages.CompletionItem & {
            synara?: {
              uri: string;
              version: number;
              offset: number;
              label: string;
              source?: string;
            };
          }
        ).synara;
        if (!metadata) return item;
        const entry = entryForUri(monaco.Uri.parse(metadata.uri));
        if (!entry || entry.model.getVersionId() !== metadata.version) return item;
        const result = await requestIntelligence(entry, "completionResolve", {
          offset: metadata.offset,
          query: metadata.label,
          token,
          ...(metadata.source ? { completionSource: metadata.source } : {}),
        });
        return result?.text
          ? {
              ...item,
              documentation: {
                value: result.text.replace(/[\\`*_{}[\]()<>#+.!|-]/g, "\\$&"),
                isTrusted: false,
                supportHtml: false,
              },
            }
          : item;
      },
    }),
  );
  disposables.push(
    monaco.languages.registerHoverProvider(selector, {
      async provideHover(model, position, token) {
        const entry = editorEntry(model);
        if (!entry) return;
        const result = await requestIntelligence(entry, "hover", {
          offset: model.getOffsetAt(position),
          token,
        });
        if (!result?.text) return;
        // Repository documentation is plain text, never trusted HTML or command links.
        return {
          contents: [
            {
              value: result.text.replace(/[\\`*_{}[\]()<>#+.!|-]/g, "\\$&"),
              isTrusted: false,
              supportHtml: false,
            },
          ],
          ...(result.span ? { range: offsetRange(model, result.span) } : {}),
        };
      },
    }),
  );
  disposables.push(
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
            signatures: [...result.signatures].map((item) => ({
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
  );
  const navigation =
    (operation: "definition" | "declaration" | "typeDefinition" | "references") =>
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
      return (result?.locations ?? []).map((loc) => ({
        uri: editorUri(entry.client, entry.cwd, loc.relativePath),
        range: locationRange(loc),
      }));
    };
  disposables.push(
    monaco.languages.registerDefinitionProvider(selector, {
      provideDefinition: navigation("definition"),
    }),
  );
  disposables.push(
    monaco.languages.registerDeclarationProvider(selector, {
      provideDeclaration: navigation("declaration"),
    }),
  );
  disposables.push(
    monaco.languages.registerTypeDefinitionProvider(selector, {
      provideTypeDefinition: navigation("typeDefinition"),
    }),
  );
  disposables.push(
    monaco.languages.registerReferenceProvider(selector, {
      provideReferences: (model, position, _context, token) =>
        navigation("references")(model, position, token),
    }),
  );
  disposables.push(
    monaco.languages.registerRenameProvider(selector, {
      async provideRenameEdits(model, position, newName, token) {
        const entry = editorEntry(model);
        if (!entry) return { edits: [], rejectReason: "The document is no longer open." };
        const result = await requestIntelligence(entry, "rename", {
          offset: model.getOffsetAt(position),
          newName,
          token,
        });
        return result?.edits
          ? monacoWorkspaceEdits(entry, result.edits)
          : { edits: [], rejectReason: "The document changed. Run Rename again." };
      },
    }),
  );
  disposables.push(
    monaco.languages.registerDocumentSymbolProvider(selector, {
      displayName: "Synara TypeScript",
      async provideDocumentSymbols(model, token) {
        const entry = editorEntry(model);
        if (!entry) return [];
        const result = await requestIntelligence(entry, "documentSymbols", { token });
        return (result?.symbols ?? []).map((symbol) => ({
          name: symbol.name,
          detail: symbol.containerName,
          kind: symbolKinds[symbol.kind] ?? monaco.languages.SymbolKind.Variable,
          tags: [],
          range: locationRange(symbol.location),
          selectionRange: locationRange(symbol.location),
        }));
      },
    }),
  );
  disposables.push(
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
  );
  disposables.push(
    monaco.languages.registerDocumentRangeFormattingEditProvider(selector, {
      async provideDocumentRangeFormattingEdits(model, range, _options, token) {
        const entry = editorEntry(model);
        if (!entry) return [];
        const offset = model.getOffsetAt({
          lineNumber: range.startLineNumber,
          column: range.startColumn,
        });
        const end = model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
        const result = await requestIntelligence(entry, "format", {
          offset,
          length: end - offset,
          token,
        });
        return (result?.edits?.[0]?.edits ?? []).map((edit) => ({
          range: offsetRange(model, edit),
          text: edit.newText,
        }));
      },
    }),
  );
  disposables.push(
    monaco.languages.registerCodeActionProvider(
      selector,
      {
        async provideCodeActions(model, range, context, token) {
          const entry = editorEntry(model);
          if (!entry) return { actions: [], dispose() {} };
          const offset = model.getOffsetAt({
            lineNumber: range.startLineNumber,
            column: range.startColumn,
          });
          const end = model.getOffsetAt({
            lineNumber: range.endLineNumber,
            column: range.endColumn,
          });
          const result =
            context.only === "source.organizeImports"
              ? await requestIntelligence(entry, "organizeImports", { token })
              : await requestIntelligence(entry, "codeActions", {
                  offset,
                  length: end - offset,
                  token,
                });
          const actions =
            result?.actions ??
            (result?.edits
              ? [{ title: "Organize imports", kind: "source.organizeImports", edits: result.edits }]
              : []);
          return {
            actions: actions.map((action) => ({
              title: action.title,
              kind: action.kind,
              command: {
                id: "synara.editor.applyEdits",
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
  );
  disposables.push(
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
  );
  disposables.push(
    monaco.languages.registerInlayHintsProvider(selector, {
      async provideInlayHints(model, range, token) {
        const entry = editorEntry(model);
        if (!entry) return { hints: [], dispose() {} };
        const offset = model.getOffsetAt({
          lineNumber: range.startLineNumber,
          column: range.startColumn,
        });
        const end = model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
        const result = await requestIntelligence(entry, "inlayHints", {
          offset,
          length: end - offset,
          token,
        });
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
  );
  disposables.push(
    monaco.languages.registerDocumentSemanticTokensProvider(selector, {
      getLegend: () => semanticLegend,
      releaseDocumentSemanticTokens() {},
      async provideDocumentSemanticTokens(model, _lastResultId, token) {
        const entry = editorEntry(model);
        if (!entry) return null;
        const result = await requestIntelligence(entry, "semanticTokens", { token });
        if (!result?.tokens) return null;
        const data: number[] = [];
        let lastLine = 0,
          lastColumn = 0;
        for (let index = 0; index < result.tokens.length; index += 3) {
          const start = result.tokens[index]!,
            length = result.tokens[index + 1]!,
            classification = result.tokens[index + 2]!;
          const position = model.getPositionAt(start),
            line = position.lineNumber - 1,
            column = position.column - 1;
          data.push(
            line - lastLine,
            line === lastLine ? column - lastColumn : column,
            length,
            (classification >> 8) - 1,
            classification & 255,
          );
          lastLine = line;
          lastColumn = column;
        }
        return { data: new Uint32Array(data) };
      },
    }),
  );
  return { dispose: () => disposables.forEach((item) => item.dispose()) };
}
