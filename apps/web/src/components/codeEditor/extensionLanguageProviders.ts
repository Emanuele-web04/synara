import type { QueryClient } from "@tanstack/react-query";
import { monaco } from "./editorRuntime";
import {
  editorEntry,
  editorUri,
  monacoWorkspaceEdits,
  type EditorModelEntry,
} from "./editorModels";
import type { EditorFileEdits } from "@synara/contracts";

export interface NativeExtensionProvider {
  handle: number;
  kind: string;
  selector: unknown;
  label: string;
  metadata?: readonly unknown[];
}
export interface NativeExtensionLanguageClient {
  client: QueryClient;
  cwd: string;
  provide(
    entry: EditorModelEntry,
    handle: number,
    params: Record<string, unknown>,
    token: monaco.CancellationToken,
  ): Promise<unknown>;
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid extension language response.");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000)
    throw new Error("Invalid extension language result list.");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_000_000)
    throw new Error("Invalid extension language text.");
  return value;
}
function number(value: unknown, minimum = 0, maximum = 1_000_000): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error("Invalid extension language position.");
  return value;
}
export function extensionRange(value: unknown): monaco.IRange {
  const range = object(value);
  const result = {
    startLineNumber: number(range.startLineNumber, 1),
    startColumn: number(range.startColumn, 1),
    endLineNumber: number(range.endLineNumber, 1),
    endColumn: number(range.endColumn, 1),
  };
  if (
    result.startLineNumber > result.endLineNumber ||
    (result.startLineNumber === result.endLineNumber && result.startColumn > result.endColumn)
  )
    throw new Error("Extension language range is reversed.");
  return result;
}
function markdown(value: unknown): monaco.IMarkdownString {
  const content = typeof value === "string" ? value : object(value).value;
  return { value: string(content), isTrusted: false, supportHtml: false };
}
function documentUri(client: NativeExtensionLanguageClient, value: unknown): monaco.Uri {
  const data = typeof value === "string" ? null : object(value);
  const resource =
    typeof value === "string"
      ? monaco.Uri.parse(value)
      : monaco.Uri.from({
          scheme: string(data!.scheme),
          path: string(data!.path),
          ...(typeof data!.authority === "string" ? { authority: data!.authority } : {}),
        });
  const root = monaco.Uri.file(client.cwd).path.replace(/\/$/, "");
  if (resource.scheme !== "file" || resource.authority || !resource.path.startsWith(root + "/"))
    throw new Error("Extension navigation leaves the active workspace.");
  const relativePath = resource.path.slice(root.length + 1);
  if (
    !relativePath ||
    relativePath.split("/").some((segment) => segment === ".." || segment === ".")
  )
    throw new Error("Unsafe extension navigation path.");
  return editorUri(client.client, client.cwd, relativePath);
}
function symbol(value: unknown, depth = 0): monaco.languages.DocumentSymbol {
  if (depth > 16) throw new Error("Extension symbols exceed the nesting limit.");
  const item = object(value);
  return {
    name: string(item.name),
    detail: typeof item.detail === "string" ? item.detail : "",
    kind: number(item.kind, 0, 25),
    tags: [],
    range: extensionRange(item.range),
    selectionRange: extensionRange(item.selectionRange),
    ...(item.children === undefined
      ? {}
      : { children: array(item.children).map((child) => symbol(child, depth + 1)) }),
  };
}
function completionRange(
  value: unknown,
): monaco.IRange | { insert: monaco.IRange; replace: monaco.IRange } {
  const candidate = object(value);
  return candidate.insert === undefined
    ? extensionRange(candidate)
    : { insert: extensionRange(candidate.insert), replace: extensionRange(candidate.replace) };
}
function completion(value: unknown): monaco.languages.CompletionItem {
  const item = object(value);
  const label = typeof item.label === "string" ? item.label : string(object(item.label).label);
  return {
    label,
    kind: number(item.kind, 0, 27),
    insertText: string(item.insertText),
    range: completionRange(item.range),
    ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
    ...(typeof item.sortText === "string" ? { sortText: item.sortText } : {}),
    ...(typeof item.filterText === "string" ? { filterText: item.filterText } : {}),
    ...(item.documentation === undefined ? {} : { documentation: markdown(item.documentation) }),
    ...(item.preselect === true ? { preselect: true } : {}),
    ...(item.insertTextRules === undefined
      ? {}
      : { insertTextRules: number(item.insertTextRules, 0, 5) }),
    ...(item.additionalTextEdits === undefined
      ? {}
      : {
          additionalTextEdits: array(item.additionalTextEdits).map((value) => {
            const edit = object(value);
            return { range: extensionRange(edit.range), text: string(edit.text) };
          }),
        }),
  };
}

/** Bounded legend copied out of extension-controlled registration metadata. */
export function extensionSemanticLegend(value: unknown): monaco.languages.SemanticTokensLegend {
  const legend = object(value);
  const types = array(legend.tokenTypes),
    modifiers = array(legend.tokenModifiers);
  if (types.length > 256 || modifiers.length > 32)
    throw new Error("Extension semantic legend is too large.");
  const names = (values: unknown[]) =>
    values.map((value) => {
      const name = string(value);
      if (name.length === 0 || name.length > 128)
        throw new Error("Invalid extension semantic legend name.");
      return name;
    });
  return { tokenTypes: names(types), tokenModifiers: names(modifiers) };
}

/** Validate every five-integer tuple before Monaco consumes extension token data. */
export function extensionSemanticTokens(
  model: monaco.editor.ITextModel,
  value: unknown,
  legend: monaco.languages.SemanticTokensLegend,
): monaco.languages.SemanticTokens {
  const raw = object(value).data;
  if (!Array.isArray(raw) || raw.length > 250_000 || raw.length % 5 !== 0)
    throw new Error("Invalid extension semantic-token tuples.");
  const data = new Uint32Array(raw.length);
  let line = 0,
    start = 0,
    previousLine = -1,
    previousEnd = 0;
  for (let index = 0; index < raw.length; index += 5) {
    const deltaLine = number(raw[index], 0, 0xffff_ffff);
    const deltaStart = number(raw[index + 1], 0, 0xffff_ffff);
    const length = number(raw[index + 2], 1, 0xffff_ffff);
    const type = number(raw[index + 3], 0, legend.tokenTypes.length - 1);
    const modifiers = number(raw[index + 4], 0, 2 ** legend.tokenModifiers.length - 1);
    line += deltaLine;
    start = deltaLine === 0 ? start + deltaStart : deltaStart;
    if (
      line >= model.getLineCount() ||
      start + length > model.getLineLength(line + 1) ||
      (line === previousLine && start < previousEnd)
    )
      throw new Error("Extension semantic token leaves its document or overlaps another token.");
    data.set([deltaLine, deltaStart, length, type, modifiers], index);
    previousLine = line;
    previousEnd = start + length;
  }
  return { data };
}

/** Display-only hint metadata. Commands/locations requiring live upstream caches are not exposed. */
export function extensionInlayHints(
  model: monaco.editor.ITextModel,
  value: unknown,
): monaco.languages.InlayHintList {
  const hints = array(value).map((raw): monaco.languages.InlayHint => {
    const item = object(raw),
      pos = object(item.position);
    const position = { lineNumber: number(pos.lineNumber, 1), column: number(pos.column, 1) };
    const valid = model.validatePosition(position);
    if (position.lineNumber !== valid.lineNumber || position.column !== valid.column)
      throw new Error("Extension inlay hint leaves its document.");
    const label =
      typeof item.label === "string"
        ? string(item.label)
        : array(item.label).map((raw) => {
            const part = object(raw);
            return {
              label: string(part.label),
              ...(part.tooltip == null ? {} : { tooltip: markdown(part.tooltip) }),
            };
          });
    if (typeof label === "string" ? label.length === 0 : label.every((part) => !part.label))
      throw new Error("Extension inlay hint has an empty label.");
    return {
      position,
      label,
      ...(item.kind === undefined ? {} : { kind: number(item.kind, 1, 2) }),
      ...(item.tooltip == null ? {} : { tooltip: markdown(item.tooltip) }),
      paddingLeft: item.paddingLeft === true,
      paddingRight: item.paddingRight === true,
      // Applying hint edits would need revalidation when the user accepts them,
      // not just when requested. Keep display-only hints until that is wired.
    };
  });
  return { hints, dispose: () => undefined };
}

function richLanguageSelector(provider: NativeExtensionProvider) {
  return array(provider.selector).flatMap((raw) => {
    const filter = object(raw);
    if (filter.notebookType || (filter.scheme && !["file", "*"].includes(string(filter.scheme))))
      return [];
    // An upstream RelativePattern cannot be applied directly to Synara URIs.
    // Never broaden it silently; ordinary string patterns remain supported.
    if (filter.pattern !== undefined && typeof filter.pattern !== "string") return [];
    return [
      {
        scheme: "synara-workspace",
        ...(filter.language ? { language: string(filter.language) } : {}),
        ...(filter.pattern === undefined ? {} : { pattern: string(filter.pattern) }),
      },
    ];
  });
}

async function workspaceEdit(
  client: NativeExtensionLanguageClient,
  source: EditorModelEntry,
  value: unknown,
): Promise<monaco.languages.WorkspaceEdit> {
  const result = object(value);
  const groups = new Map<string, EditorFileEdits>();
  for (const raw of array(result.edits)) {
    const item = object(raw),
      resource = documentUri(client, item.resource);
    const model = monaco.editor.getModel(resource);
    const target = model && editorEntry(model);
    if (!target || target.client !== client.client || target.cwd !== client.cwd)
      throw new Error("Open every extension edit target before applying it.");
    const expectedContents = string(item.expectedContents);
    if (target.model.getValue() !== expectedContents)
      throw new Error("An extension edit target changed. Nothing was modified.");
    const edit = object(item.textEdit),
      range = extensionRange(edit.range);
    if (!monaco.Range.equalsRange(range, target.model.validateRange(range)))
      throw new Error("Extension edit range exceeds its document.");
    const start = target.model.getOffsetAt({
      lineNumber: range.startLineNumber,
      column: range.startColumn,
    });
    const end = target.model.getOffsetAt({
      lineNumber: range.endLineNumber,
      column: range.endColumn,
    });
    const group = groups.get(target.relativePath) ?? {
      relativePath: target.relativePath,
      expectedContents,
      edits: [],
    };
    if (group.expectedContents !== expectedContents)
      throw new Error("Extension edit versions disagree.");
    groups.set(target.relativePath, {
      ...group,
      edits: [...group.edits, { start, length: end - start, newText: string(edit.text) }],
    });
  }
  return monacoWorkspaceEdits(source, [...groups.values()]);
}

/** Registrations only target this Synara client's workspace, never unrelated models. */
export function registerNativeExtensionProviders(
  client: NativeExtensionLanguageClient,
  providers: readonly NativeExtensionProvider[],
): monaco.IDisposable[] {
  const disposables: monaco.IDisposable[] = [];
  const selector = { scheme: "synara-workspace" };
  const entry = (model: monaco.editor.ITextModel) => {
    const source = editorEntry(model);
    return source?.client === client.client && source.cwd === client.cwd ? source : undefined;
  };
  for (const provider of providers) {
    const invoke = async (
      model: monaco.editor.ITextModel,
      token: monaco.CancellationToken,
      params: Record<string, unknown>,
    ) => {
      const source = entry(model);
      if (!source || token.isCancellationRequested) return undefined;
      return client.provide(source, provider.handle, params, token);
    };
    if (provider.kind === "completion")
      disposables.push(
        monaco.languages.registerCompletionItemProvider(selector, {
          provideCompletionItems: async (model, position, context, token) => {
            const value = await invoke(model, token, { position, context });
            if (value == null) return undefined;
            const result = object(value);
            return {
              suggestions: array(result.suggestions).map(completion),
              incomplete: result.incomplete === true,
            };
          },
        }),
      );
    else if (provider.kind === "hover")
      disposables.push(
        monaco.languages.registerHoverProvider(selector, {
          provideHover: async (model, position, token) => {
            const value = await invoke(model, token, { position });
            if (value == null) return undefined;
            const result = object(value);
            return {
              range: extensionRange(result.range),
              contents: array(result.contents).map(markdown),
            };
          },
        }),
      );
    else if (provider.kind === "signature")
      disposables.push(
        monaco.languages.registerSignatureHelpProvider(selector, {
          signatureHelpTriggerCharacters: ["(", ","],
          provideSignatureHelp: async (model, position, token, context) => {
            const value = await invoke(model, token, { position, context });
            if (value == null) return undefined;
            const result = object(value);
            const signatures = array(result.signatures).map(
              (raw): monaco.languages.SignatureInformation => {
                const item = object(raw);
                return {
                  label: string(item.label),
                  ...(item.documentation === undefined
                    ? {}
                    : { documentation: markdown(item.documentation) }),
                  parameters: array(item.parameters).map(
                    (raw): monaco.languages.ParameterInformation => {
                      const parameter = object(raw);
                      let label: string | [number, number];
                      if (typeof parameter.label === "string") label = parameter.label;
                      else {
                        const pair = array(parameter.label);
                        if (pair.length !== 2) throw new Error("Invalid signature parameter.");
                        label = [number(pair[0]), number(pair[1])];
                      }
                      return {
                        label,
                        ...(parameter.documentation === undefined
                          ? {}
                          : { documentation: markdown(parameter.documentation) }),
                      };
                    },
                  ),
                };
              },
            );
            return {
              value: {
                signatures,
                activeSignature: number(result.activeSignature),
                activeParameter: number(result.activeParameter),
              },
              dispose: () => undefined,
            };
          },
        }),
      );
    else if (
      ["definition", "declaration", "typeDefinition", "implementation"].includes(provider.kind)
    ) {
      const provide = async (
        model: monaco.editor.ITextModel,
        position: monaco.Position,
        token: monaco.CancellationToken,
      ): Promise<monaco.languages.LocationLink[] | undefined> => {
        const value = await invoke(model, token, { position });
        if (value == null) return undefined;
        return array(Array.isArray(value) ? value : [value]).map((raw) => {
          const item = object(raw);
          return {
            uri: documentUri(client, item.uri),
            range: extensionRange(item.range),
            ...(item.targetSelectionRange === undefined
              ? {}
              : { targetSelectionRange: extensionRange(item.targetSelectionRange) }),
            ...(item.originSelectionRange === undefined
              ? {}
              : { originSelectionRange: extensionRange(item.originSelectionRange) }),
          };
        });
      };
      if (provider.kind === "definition")
        disposables.push(
          monaco.languages.registerDefinitionProvider(selector, { provideDefinition: provide }),
        );
      else if (provider.kind === "declaration")
        disposables.push(
          monaco.languages.registerDeclarationProvider(selector, { provideDeclaration: provide }),
        );
      else if (provider.kind === "typeDefinition")
        disposables.push(
          monaco.languages.registerTypeDefinitionProvider(selector, {
            provideTypeDefinition: provide,
          }),
        );
      else
        disposables.push(
          monaco.languages.registerImplementationProvider(selector, {
            provideImplementation: provide,
          }),
        );
    } else if (provider.kind === "references")
      disposables.push(
        monaco.languages.registerReferenceProvider(selector, {
          provideReferences: async (model, position, context, token) => {
            const value = await invoke(model, token, {
              position,
              includeDeclaration: context.includeDeclaration,
            });
            return value == null
              ? undefined
              : array(value).map((raw) => {
                  const item = object(raw);
                  return { uri: documentUri(client, item.uri), range: extensionRange(item.range) };
                });
          },
        }),
      );
    else if (provider.kind === "documentSymbols")
      disposables.push(
        monaco.languages.registerDocumentSymbolProvider(selector, {
          displayName: provider.label,
          provideDocumentSymbols: async (model, token) => {
            const value = await invoke(model, token, {});
            return value == null ? undefined : array(value).map((item) => symbol(item));
          },
        }),
      );
    else if (provider.kind === "rename")
      disposables.push(
        monaco.languages.registerRenameProvider(selector, {
          provideRenameEdits: async (model, position, newName, token) => {
            const source = entry(model);
            if (!source) return undefined;
            const value = await invoke(model, token, { position, newName });
            return value == null ? undefined : workspaceEdit(client, source, value);
          },
        }),
      );
    else if (provider.kind === "codeActions")
      disposables.push(
        monaco.languages.registerCodeActionProvider(selector, {
          provideCodeActions: async (model, range, context, token) => {
            const source = entry(model);
            if (!source) return undefined;
            const value = await invoke(model, token, {
              range,
              context: {
                trigger: context.trigger,
                ...(context.only ? { only: context.only } : {}),
              },
            });
            if (value == null) return undefined;
            const actions: monaco.languages.CodeAction[] = [];
            for (const raw of array(value)) {
              const item = object(raw);
              if (item.command || item.disabled || !item.edit) continue;
              actions.push({
                title: string(item.title),
                edit: await workspaceEdit(client, source, item.edit),
                ...(typeof item.kind === "string" ? { kind: item.kind } : {}),
                ...(item.isPreferred === true ? { isPreferred: true } : {}),
              });
            }
            return { actions, dispose: () => undefined };
          },
        }),
      );
    else if (provider.kind === "semanticTokens") {
      const legend = extensionSemanticLegend(provider.metadata?.[0]);
      const richSelector = richLanguageSelector(provider);
      if (richSelector.length === 0) continue;
      disposables.push(
        monaco.languages.registerDocumentSemanticTokensProvider(richSelector, {
          getLegend: () => legend,
          provideDocumentSemanticTokens: async (model, _lastResultId, token) => {
            const value = await invoke(model, token, {});
            return value == null ? null : extensionSemanticTokens(model, value, legend);
          },
          // The host already releases its result cache before returning the snapshot.
          releaseDocumentSemanticTokens: () => undefined,
        }),
      );
    } else if (provider.kind === "inlayHints") {
      const richSelector = richLanguageSelector(provider);
      if (richSelector.length === 0) continue;
      disposables.push(
        monaco.languages.registerInlayHintsProvider(richSelector, {
          displayName: provider.label,
          provideInlayHints: async (model, range, token) => {
            const value = await invoke(model, token, { range });
            return value == null ? undefined : extensionInlayHints(model, value);
          },
        }),
      );
    } else if (provider.kind === "folding")
      disposables.push(
        monaco.languages.registerFoldingRangeProvider(selector, {
          provideFoldingRanges: async (model, _context, token) => {
            const value = await invoke(model, token, {});
            if (value == null) return undefined;
            return array(value).map((raw) => {
              const item = object(raw);
              return {
                start: number(item.start, 1, model.getLineCount()),
                end: number(item.end, 1, model.getLineCount()),
              };
            });
          },
        }),
      );
  }
  return disposables;
}

/** Markers are namespaced and only attached to models already owned by Synara. */
export function applyNativeExtensionDiagnostics(
  client: NativeExtensionLanguageClient,
  payload: unknown,
): void {
  const data = object(payload),
    owner = `synara-extension:${string(data.owner)}`;
  const entries = array(data.entries);
  if (entries.length === 0) {
    for (const model of monaco.editor.getModels()) {
      const source = editorEntry(model);
      if (source?.client === client.client && source.cwd === client.cwd)
        monaco.editor.setModelMarkers(model, owner, []);
    }
  }
  for (const entry of entries) {
    const tuple = array(entry);
    if (tuple.length !== 2) throw new Error("Invalid extension diagnostic tuple.");
    const resource = documentUri(client, tuple[0]);
    const model = monaco.editor.getModel(resource);
    if (!model) continue;
    const markers: monaco.editor.IMarkerData[] = array(tuple[1]).map((raw) => {
      const item = object(raw);
      const severity = number(item.severity, 1, 8);
      if (![1, 2, 4, 8].includes(severity)) throw new Error("Invalid diagnostic severity.");
      return {
        ...extensionRange(item),
        message: string(item.message),
        severity,
        ...(typeof item.source === "string" ? { source: item.source } : {}),
        ...(typeof item.code === "string" ? { code: item.code } : {}),
      };
    });
    monaco.editor.setModelMarkers(model, owner, markers);
  }
}
