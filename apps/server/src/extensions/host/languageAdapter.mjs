// Code-OSS owns the providers and their DTOs. This adapter removes wire-only
// compression before sending data to Synara's native editor components.
import {
  ISuggestDataDtoField as Suggest,
  ISuggestResultDtoField as Result,
} from "@code-oss/vs/workbench/api/common/extHost.protocol.js";
import { CancellationToken } from "@code-oss/vs/base/common/cancellation.js";
import { URI } from "@code-oss/vs/base/common/uri.js";
import { requestSemanticTokens } from "./semanticTokenAdapter.mjs";
import { snapshotWorkspaceEdit } from "./workspaceEditAdapter.mjs";
import { score } from "@code-oss/vs/editor/common/languageSelector.js";

function completion(item, defaultRange) {
  const label = item[Suggest.label];
  return {
    label,
    kind: item[Suggest.kind] ?? 9,
    detail: item[Suggest.detail],
    documentation: item[Suggest.documentation],
    sortText: item[Suggest.sortText],
    filterText: item[Suggest.filterText],
    preselect: item[Suggest.preselect],
    insertText: item[Suggest.insertText] ?? (typeof label === "string" ? label : label.label),
    range: item[Suggest.range] ?? defaultRange,
    insertTextRules: item[Suggest.insertTextRules],
    additionalTextEdits: item[Suggest.additionalTextEdits],
    commitCharacters: item[Suggest.commitCharacters]
      ? Array.from(item[Suggest.commitCharacters])
      : undefined,
  };
}

export async function requestLanguageProvider(
  target,
  provider,
  params,
  documents,
  cancellation = CancellationToken.None,
) {
  const handle = provider.handle;
  const resource = URI.file(params.path);
  const document = documents.get(resource.toString());
  const snapshots = new Map(documents);
  if (!document) throw new Error("The language provider requires a synchronized native document.");
  if (
    provider.kind !== "workspaceSymbols" &&
    score(provider.selector, resource, document.languageId, true, undefined, undefined) === 0
  )
    return null;
  const position = params.position ?? { lineNumber: 1, column: 1 };
  const range = params.range ?? {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 1,
  };
  const options = params.options ?? { tabSize: 2, insertSpaces: true };
  switch (provider.kind) {
    case "format":
      return target.$provideDocumentFormattingEdits(handle, resource, options, cancellation);
    case "rangeFormat":
      return target.$provideDocumentRangeFormattingEdits(
        handle,
        resource,
        range,
        options,
        cancellation,
      );
    case "completion": {
      const result = await target.$provideCompletionItems(
        handle,
        resource,
        position,
        params.context ?? { triggerKind: 0 },
        cancellation,
      );
      if (!result) return null;
      try {
        // Return self-contained suggestions. Deferred resolution and commands
        // attached to completion acceptance are not advertised as supported.
        return {
          suggestions: result[Result.completions].map((item) =>
            completion(item, result[Result.defaultRanges]),
          ),
          incomplete: Boolean(result[Result.isIncomplete]),
        };
      } finally {
        if (typeof result.x === "number") await target.$releaseCompletionItems(handle, result.x);
      }
    }
    case "hover":
      return target.$provideHover(handle, resource, position, { verbosityDelta: 0 }, cancellation);
    case "signature": {
      const result = await target.$provideSignatureHelp(
        handle,
        resource,
        position,
        params.context ?? { triggerKind: 1, isRetrigger: false },
        cancellation,
      );
      if (!result) return null;
      try {
        return {
          signatures: result.signatures,
          activeSignature: result.activeSignature,
          activeParameter: result.activeParameter,
        };
      } finally {
        await target.$releaseSignatureHelp(handle, result.id);
      }
    }
    case "definition":
      return target.$provideDefinition(handle, resource, position, cancellation);
    case "declaration":
      return target.$provideDeclaration(handle, resource, position, cancellation);
    case "typeDefinition":
      return target.$provideTypeDefinition(handle, resource, position, cancellation);
    case "implementation":
      return target.$provideImplementation(handle, resource, position, cancellation);
    case "references":
      return target.$provideReferences(
        handle,
        resource,
        position,
        { includeDeclaration: params.includeDeclaration !== false },
        cancellation,
      );
    case "documentSymbols":
      return target.$provideDocumentSymbols(handle, resource, cancellation);
    case "workspaceSymbols": {
      const result = await target.$provideWorkspaceSymbols(
        handle,
        params.query ?? "",
        cancellation,
      );
      try {
        return result?.symbols ?? [];
      } finally {
        if (typeof result?.cacheId === "number")
          await target.$releaseWorkspaceSymbols(handle, result.cacheId);
      }
    }
    case "codeActions": {
      const result = await target.$provideCodeActions(
        handle,
        resource,
        range,
        params.context ?? { trigger: 1 },
        cancellation,
      );
      if (!result) return null;
      try {
        return result.actions
          .filter((action) => action.edit && !action.command)
          .map((action) => ({ ...action, edit: snapshotWorkspaceEdit(action.edit, snapshots) }));
      } finally {
        if (typeof result.cacheId === "number")
          await target.$releaseCodeActions(handle, result.cacheId);
      }
    }
    case "rename":
      return snapshotWorkspaceEdit(
        await target.$provideRenameEdits(handle, resource, position, params.newName, cancellation),
        snapshots,
      );
    case "folding":
      return target.$provideFoldingRanges(handle, resource, {}, cancellation);
    case "semanticTokens":
      return requestSemanticTokens(target, handle, resource, cancellation);
    case "inlayHints": {
      const result = await target.$provideInlayHints(handle, resource, range, cancellation);
      if (!result) return null;
      try {
        return result.hints;
      } finally {
        if (typeof result.cacheId === "number")
          await target.$releaseInlayHints(handle, result.cacheId);
      }
    }
    default:
      throw new Error(`Synara has no native adapter for ${provider.kind}.`);
  }
}
