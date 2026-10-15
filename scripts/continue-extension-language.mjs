// Temporary, exact-anchor integration for unavailable local execution.
// The normalization workflow removes this script from the application tree.
import { readFile, writeFile } from "node:fs/promises";
async function edit(file, before, after) {
  const value = await readFile(file, "utf8");
  if (value.split(before).length !== 2) throw new Error(`Expected exactly one anchor in ${file}: ${before}`);
  await writeFile(file, value.replace(before, after));
}
const adapter = "apps/server/src/extensions/host/languageAdapter.mjs";
await edit(adapter, 'import { snapshotWorkspaceEdit }', 'import { requestSemanticTokens } from "./semanticTokenAdapter.mjs";\nimport { snapshotWorkspaceEdit }');
await edit(adapter, '    case "inlayHints": {', '    case "semanticTokens":\n      return requestSemanticTokens(target, handle, resource, cancellation);\n    case "inlayHints": {');
const host = "apps/server/src/extensions/host/entry.mjs";
await edit(host, '  const handlers = {\n    MainThreadLanguageFeatures: language,', `  // Code-OSS emits invalidations by event handle, not provider handle. Replaying
  // registrations makes Monaco recompute without exposing a second event bus.
  const refreshLanguage = (kind, eventHandle) => {
    if ([...providers.values()].some((provider) => provider.kind === kind && provider.metadata[1] === eventHandle)) {
      event("providers", [...providers.values()]);
    }
  };
  language.$emitInlayHintsEvent = (handle) => refreshLanguage("inlayHints", handle);
  language.$emitDocumentSemanticTokensEvent = (handle) => refreshLanguage("semanticTokens", handle);
  language.$emitFoldingRangeEvent = (handle) => refreshLanguage("folding", handle);
  const handlers = {
    MainThreadLanguageFeatures: language,`);
const bridge = "apps/web/src/components/codeEditor/editorExtensionBridge.ts";
await edit(bridge, 'type Provider = { handle: number; kind: string; selector: unknown; label: string };', 'type Provider = { handle: number; kind: string; selector: unknown; label: string; metadata: readonly unknown[] };');
await edit(bridge, '            selector: provider.selector,', '            selector: provider.selector,\n            metadata,');
const language = "apps/web/src/components/codeEditor/extensionLanguageProviders.ts";
await edit(language, '  label: string;\n}', '  label: string;\n  metadata?: readonly unknown[];\n}');
await edit(language, 'async function workspaceEdit(', `/** Bounded legend copied out of extension-controlled registration metadata. */
export function extensionSemanticLegend(value: unknown): monaco.languages.SemanticTokensLegend {
  const legend = object(value);
  const types = array(legend.tokenTypes), modifiers = array(legend.tokenModifiers);
  if (types.length > 256 || modifiers.length > 32) throw new Error("Extension semantic legend is too large.");
  const names = (values: unknown[]) => values.map((value) => {
    const name = string(value);
    if (name.length === 0 || name.length > 128) throw new Error("Invalid extension semantic legend name.");
    return name;
  });
  return { tokenTypes: names(types), tokenModifiers: names(modifiers) };
}

/** Validate every five-integer tuple before Monaco consumes extension token data. */
export function extensionSemanticTokens(
  model: monaco.editor.ITextModel, value: unknown, legend: monaco.languages.SemanticTokensLegend,
): monaco.languages.SemanticTokens {
  const raw = object(value).data;
  if (!Array.isArray(raw) || raw.length > 250_000 || raw.length % 5 !== 0) throw new Error("Invalid extension semantic-token tuples.");
  const data = new Uint32Array(raw.length);
  let line = 0, start = 0, previousLine = -1, previousEnd = 0;
  for (let index = 0; index < raw.length; index += 5) {
    const deltaLine = number(raw[index], 0, 0xffff_ffff);
    const deltaStart = number(raw[index + 1], 0, 0xffff_ffff);
    const length = number(raw[index + 2], 1, 0xffff_ffff);
    const type = number(raw[index + 3], 0, legend.tokenTypes.length - 1);
    const modifiers = number(raw[index + 4], 0, 2 ** legend.tokenModifiers.length - 1);
    line += deltaLine;
    start = deltaLine === 0 ? start + deltaStart : deltaStart;
    if (line >= model.getLineCount() || start + length > model.getLineLength(line + 1) ||
      (line === previousLine && start < previousEnd)) throw new Error("Extension semantic token leaves its document or overlaps another token.");
    data.set([deltaLine, deltaStart, length, type, modifiers], index);
    previousLine = line; previousEnd = start + length;
  }
  return { data };
}

/** Display-only hint metadata. Commands/locations requiring live upstream caches are not exposed. */
export function extensionInlayHints(model: monaco.editor.ITextModel, value: unknown): monaco.languages.InlayHintList {
  const hints = array(value).map((raw): monaco.languages.InlayHint => {
    const item = object(raw), pos = object(item.position);
    const position = { lineNumber: number(pos.lineNumber, 1), column: number(pos.column, 1) };
    const valid = model.validatePosition(position);
    if (position.lineNumber !== valid.lineNumber || position.column !== valid.column) throw new Error("Extension inlay hint leaves its document.");
    const label = typeof item.label === "string" ? string(item.label) : array(item.label).map((raw) => {
      const part = object(raw);
      return { label: string(part.label), ...(part.tooltip == null ? {} : { tooltip: markdown(part.tooltip) }) };
    });
    if (typeof label === "string" ? label.length === 0 : label.every((part) => !part.label)) throw new Error("Extension inlay hint has an empty label.");
    return {
      position, label,
      ...(item.kind === undefined ? {} : { kind: number(item.kind, 1, 2) }),
      ...(item.tooltip == null ? {} : { tooltip: markdown(item.tooltip) }),
      paddingLeft: item.paddingLeft === true, paddingRight: item.paddingRight === true,
      // Applying hint edits would need revalidation when the user accepts them,
      // not just when requested. Keep display-only hints until that is wired.
    };
  });
  return { hints, dispose: () => undefined };
}

function richLanguageSelector(provider: NativeExtensionProvider) {
  return array(provider.selector).flatMap((raw) => {
    const filter = object(raw);
    if (filter.notebookType || (filter.scheme && !["file", "*"].includes(string(filter.scheme)))) return [];
    // An upstream RelativePattern cannot be applied directly to Synara URIs.
    // Never broaden it silently; ordinary string patterns remain supported.
    if (filter.pattern !== undefined && typeof filter.pattern !== "string") return [];
    return [{ scheme: "synara-workspace", ...(filter.language ? { language: string(filter.language) } : {}),
      ...(filter.pattern === undefined ? {} : { pattern: string(filter.pattern) }) }];
  });
}

async function workspaceEdit(`);
await edit(language, '    else if (provider.kind === "folding")', `    else if (provider.kind === "semanticTokens") {
      const legend = extensionSemanticLegend(provider.metadata?.[0]);
      const richSelector = richLanguageSelector(provider);
      if (richSelector.length === 0) continue;
      disposables.push(monaco.languages.registerDocumentSemanticTokensProvider(richSelector, {
        getLegend: () => legend,
        provideDocumentSemanticTokens: async (model, _lastResultId, token) => {
          const value = await invoke(model, token, {});
          return value == null ? null : extensionSemanticTokens(model, value, legend);
        },
        // The host already releases its result cache before returning the snapshot.
        releaseDocumentSemanticTokens: () => undefined,
      }));
    } else if (provider.kind === "inlayHints") {
      const richSelector = richLanguageSelector(provider);
      if (richSelector.length === 0) continue;
      disposables.push(monaco.languages.registerInlayHintsProvider(richSelector, {
        displayName: provider.label,
        provideInlayHints: async (model, range, token) => {
          const value = await invoke(model, token, { range });
          return value == null ? undefined : extensionInlayHints(model, value);
        },
      }));
    } else if (provider.kind === "folding")`);
// Reuse the existing real ZIP builder rather than duplicate or mock extraction.
const fixtureFile = "apps/server/src/extensions/vsix.test.ts";
const fixture = await readFile(fixtureFile, "utf8");
const start = fixture.indexOf("export function fixtureVsix(");
const end = fixture.indexOf("\nconst manifest =", start);
if (start < 0 || end < 0) throw new Error("VSIX fixture extraction anchors changed.");
await writeFile("apps/server/src/extensions/vsixFixture.ts", 'import { crc32 } from "node:zlib";\n\n' + fixture.slice(start, end) + "\n");
await writeFile(fixtureFile, fixture.slice(0, start).replace('import { crc32 } from "node:zlib";', 'import { fixtureVsix } from "./vsixFixture";') + fixture.slice(end));
console.log("Connected Code-OSS full semantic snapshots, native inlay hints, provider invalidation and reusable VSIX acceptance fixtures.");
