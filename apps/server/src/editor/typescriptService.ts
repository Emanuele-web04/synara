import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { isPathInside } from "@synara/shared/pathContainment";
import type {
  EditorIntelligenceInput,
  EditorIntelligenceResult,
  EditorDiagnostic,
  EditorFileEdits,
  EditorLocation,
} from "@synara/contracts";

const MAX_PROJECT_FILES = 10_000;
const MAX_RESULT_ITEMS = 2_000;
const display = (parts: readonly ts.SymbolDisplayPart[] | undefined) =>
  ts.displayPartsToString(parts ? [...parts] : undefined);

/** Runs only in the compiler worker. No tsserver plugins, emit, shell, or disk writes. */
export function createTypeScriptService(workspaceRoot: string) {
  const root = ts.sys.realpath?.(workspaceRoot) ?? path.resolve(workspaceRoot);
  const require = createRequire(import.meta.url);
  const libraryRoot = path.dirname(require.resolve("typescript/lib/lib.d.ts"));
  let documents = new Map<string, { contents: string; version: number; revision: number }>();
  let nextRevision = 0;
  let projectDirectory = root;
  let lastConfigRefresh = 0;
  let projectVersion = 0;
  let files: string[] = [];
  let options: ts.CompilerOptions = {};
  let configuredFiles: string[] = [];
  let configuredOptions: ts.CompilerOptions = {};
  let configStamp = "";
  let inferredJavaScript = false;
  const inferredOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowImportingTsExtensions: true,
    noEmit: true,
    plugins: [],
  };

  const allowed = (file: string) => {
    const absolute = path.resolve(file);
    if (!isPathInside(root, absolute) && !isPathInside(libraryRoot, absolute)) return false;
    try {
      const real = ts.sys.realpath?.(absolute) ?? absolute;
      return isPathInside(root, real) || isPathInside(libraryRoot, real);
    } catch {
      return false;
    }
  };
  const resolve = (relative: string) => {
    if (path.isAbsolute(relative) || relative.includes("\0"))
      throw new Error("Expected a workspace-relative path.");
    const file = path.resolve(root, relative);
    if (!isPathInside(root, file) || !allowed(file))
      throw new Error("Language request escaped its workspace.");
    return file;
  };
  const readFile = (file: string) => {
    if (!allowed(file)) return undefined;
    const contents = documents.get(path.resolve(file))?.contents ?? ts.sys.readFile(file);
    return contents !== undefined && contents.length <= 2_000_000 ? contents : undefined;
  };
  const fileExists = (file: string) =>
    allowed(file) && (documents.has(path.resolve(file)) || ts.sys.fileExists(file));
  const readDirectory: NonNullable<ts.LanguageServiceHost["readDirectory"]> = (
    dir,
    extensions,
    excludes,
    includes,
    depth,
  ) =>
    allowed(dir)
      ? ts.sys
          .readDirectory(dir, extensions, excludes, includes, depth)
          .filter(allowed)
          .slice(0, MAX_PROJECT_FILES + 1)
      : [];

  const refreshConfig = (requestedFile: string) => {
    // Honor the nearest package configuration, not just a monorepo's root config.
    let directory = path.dirname(requestedFile);
    let configFile: string | undefined;
    while (isPathInside(root, directory)) {
      configFile = [
        path.join(directory, "tsconfig.json"),
        path.join(directory, "jsconfig.json"),
      ].find(fileExists);
      if (configFile || directory === root) break;
      directory = path.dirname(directory);
    }
    // The stamp names the configuration only, so alternating .ts/.js requests in one
    // project keep its program and semantic cache warm.
    const stamp = `${configFile ?? "inferred"}:${configFile ? ts.sys.getModifiedTime?.(configFile)?.getTime() : 0}`;
    // Refresh inherited configs/file lists periodically without scanning a project on every keystroke.
    if (stamp !== configStamp || Date.now() - lastConfigRefresh >= 2_000)
      parseConfig(configFile, stamp);
    // TS-only configurations reject JavaScript even when it is an open root.
    // Use an inferred project for those requests without enabling JS or changing
    // strictness in the configured TS project. Switching back restores its options.
    inferredJavaScript = /\.[cm]?jsx?$/i.test(requestedFile) && !configuredOptions.allowJs;
    files = inferredJavaScript ? [] : configuredFiles;
    options = inferredJavaScript ? inferredOptions : configuredOptions;
  };
  const parseConfig = (configFile: string | undefined, stamp: string) => {
    const baseDirectory = configFile ? path.dirname(configFile) : root;
    const config = configFile ? ts.readConfigFile(configFile, readFile) : undefined;
    if (config?.error)
      throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    const parsed = ts.parseJsonConfigFileContent(
      config?.config ?? {
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          allowImportingTsExtensions: true,
        },
        exclude: ["node_modules", ".git", "dist", "build"],
      },
      { ...ts.sys, readFile, fileExists, readDirectory },
      baseDirectory,
      { noEmit: true },
      configFile,
    );
    if (parsed.fileNames.length > MAX_PROJECT_FILES)
      throw new Error(
        "This project exceeds the language service's 10,000-file limit. Open a narrower workspace.",
      );
    configuredFiles = parsed.fileNames.filter(allowed);
    configuredOptions = { ...parsed.options, noEmit: true, plugins: [] };
    projectDirectory = baseDirectory;
    if (configStamp !== stamp) service.cleanupSemanticCache();
    configStamp = stamp;
    lastConfigRefresh = Date.now();
  };

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [
      ...new Set([
        ...files,
        ...[...documents.keys()].filter((file) =>
          (inferredJavaScript ? /\.[cm]?jsx?$/i : /\.[cm]?[jt]sx?$/i).test(file),
        ),
      ]),
    ],
    getScriptVersion: (file) =>
      documents.has(path.resolve(file))
        ? `buffer:${documents.get(path.resolve(file))!.revision}`
        : `disk:${allowed(file) ? ts.sys.getModifiedTime?.(file)?.getTime() : 0}`,
    getScriptSnapshot: (file) => {
      const text = readFile(file);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => projectDirectory,
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    getProjectVersion: () => String(projectVersion),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    readFile,
    fileExists,
    readDirectory,
    directoryExists: (dir) => allowed(dir) && ts.sys.directoryExists(dir),
    getDirectories: (dir) =>
      allowed(dir)
        ? ts.sys.getDirectories(dir).filter((name) => allowed(path.join(dir, name)))
        : [],
    realpath: (file) => (allowed(file) ? (ts.sys.realpath?.(file) ?? file) : file),
  };
  const service = ts.createLanguageService(host);
  const preferences: ts.UserPreferences = {
    includeCompletionsForModuleExports: false,
    includeCompletionsWithInsertText: true,
    includeInlayParameterNameHints: "all",
    includeInlayParameterNameHintsWhenArgumentMatchesName: false,
    includeInlayFunctionParameterTypeHints: true,
    includeInlayVariableTypeHints: true,
    includeInlayPropertyDeclarationTypeHints: true,
    includeInlayFunctionLikeReturnTypeHints: true,
    includeInlayEnumMemberValueHints: true,
  };
  const location = (file: string, span: ts.TextSpan): EditorLocation | undefined => {
    if (!isPathInside(root, file) || !allowed(file)) return undefined;
    const source = service.getProgram()?.getSourceFile(file);
    if (!source) return undefined;
    const start = source.getLineAndCharacterOfPosition(span.start);
    const end = source.getLineAndCharacterOfPosition(span.start + span.length);
    return {
      relativePath: path.relative(root, file).split(path.sep).join("/"),
      ...span,
      line: start.line,
      character: start.character,
      endLine: end.line,
      endCharacter: end.character,
    };
  };
  const fileEdits = (changes: readonly ts.FileTextChanges[]): EditorFileEdits[] => {
    if (changes.length > 200)
      throw new Error(
        "This refactoring affects more than 200 files. Narrow its scope before applying it.",
      );
    let total = 0;
    return changes.map((change) => {
      if (
        change.isNewFile ||
        !isPathInside(root, change.fileName) ||
        !allowed(change.fileName) ||
        path
          .relative(root, change.fileName)
          .split(path.sep)
          .some((part) => part === ".git" || part === "node_modules")
      ) {
        throw new Error(
          "This edit creates a file or changes a file outside the workspace; apply it manually.",
        );
      }
      const expectedContents = readFile(change.fileName);
      if (expectedContents === undefined) throw new Error("Cannot load the source for this edit.");
      total +=
        expectedContents.length +
        change.textChanges.reduce((sum, edit) => sum + edit.newText.length, 0);
      if (total > 8_000_000 || change.textChanges.length > 10_000)
        throw new Error(
          "This refactoring exceeds the safe edit transaction size. Narrow its scope before applying it.",
        );
      return {
        relativePath: path.relative(root, change.fileName).split(path.sep).join("/"),
        expectedContents,
        edits: change.textChanges.map(({ span, newText }) => ({ ...span, newText })),
      };
    });
  };
  const diagnostics = (file: string) =>
    [
      ...service.getSyntacticDiagnostics(file),
      ...service.getSemanticDiagnostics(file),
      ...service.getSuggestionDiagnostics(file),
    ].slice(0, MAX_RESULT_ITEMS);
  const diagnostic = (item: ts.Diagnostic): EditorDiagnostic => ({
    start: item.start ?? 0,
    length: item.length ?? 0,
    severity:
      item.category === ts.DiagnosticCategory.Error
        ? "error"
        : item.category === ts.DiagnosticCategory.Warning
          ? "warning"
          : item.category === ts.DiagnosticCategory.Suggestion
            ? "hint"
            : "info",
    message: ts.flattenDiagnosticMessageText(item.messageText, "\n"),
    code: item.code,
    unnecessary: item.reportsUnnecessary === true,
    deprecated: item.reportsDeprecated === true,
  });

  return {
    dispose: () => service.dispose(),
    request(input: EditorIntelligenceInput): EditorIntelligenceResult {
      if (input.documents.reduce((sum, doc) => sum + doc.contents.length, 0) > 8_000_000)
        throw new Error("Open document snapshots exceed 8 MB.");
      documents = new Map(
        input.documents.map((doc) => {
          const absolute = resolve(doc.relativePath);
          const previous = documents.get(absolute);
          return [
            absolute,
            {
              contents: doc.contents,
              version: doc.version,
              revision: previous?.contents === doc.contents ? previous.revision : ++nextRevision,
            },
          ];
        }),
      );
      const file = resolve(input.relativePath);
      const document = documents.get(file);
      if (!document) throw new Error("A current document snapshot is required.");
      if (
        input.offset > document.contents.length ||
        input.offset + input.length > document.contents.length
      )
        throw new Error("Invalid document range.");
      projectVersion++;
      refreshConfig(file);
      const base = { version: document.version };
      const formatting: ts.FormatCodeSettings = {
        indentSize: input.tabSize || 2,
        tabSize: input.tabSize || 2,
        convertTabsToSpaces: input.insertSpaces ?? true,
        newLineCharacter: "\n",
        semicolons: ts.SemicolonPreference.Ignore,
      };
      const span = { start: input.offset, length: input.length };
      switch (input.operation) {
        case "completion": {
          const result = service.getCompletionsAtPosition(file, input.offset, preferences);
          const word =
            /[$\p{ID_Continue}]*$/u.exec(document.contents.slice(0, input.offset))?.[0] ?? "";
          return {
            ...base,
            completions: (result?.entries ?? []).slice(0, MAX_RESULT_ITEMS).map((entry) => ({
              label: entry.name,
              kind: entry.kind,
              sortText: entry.sortText,
              insertText: entry.insertText ?? entry.name,
              replacement: entry.replacementSpan ??
                result?.optionalReplacementSpan ?? {
                  start: input.offset - word.length,
                  length: word.length,
                },
              ...(entry.source ? { source: entry.source } : {}),
            })),
          };
        }
        case "completionResolve": {
          if (!input.query) return base;
          const result = service.getCompletionEntryDetails(
            file,
            input.offset,
            input.query,
            formatting,
            input.completionSource,
            preferences,
            undefined,
          );
          return result
            ? {
                ...base,
                text: `${display(result.displayParts)}\n\n${display(result.documentation)}`,
              }
            : base;
        }
        case "hover": {
          const result = service.getQuickInfoAtPosition(file, input.offset);
          return result
            ? {
                ...base,
                text: `${display(result.displayParts)}\n\n${display(result.documentation)}`,
                span: result.textSpan,
              }
            : base;
        }
        case "signature": {
          const result = service.getSignatureHelpItems(file, input.offset, undefined);
          return result
            ? {
                ...base,
                activeSignature: result.selectedItemIndex,
                activeParameter: result.argumentIndex,
                signatures: result.items.map((item) => ({
                  label:
                    display(item.prefixDisplayParts) +
                    item.parameters
                      .map((p) => display(p.displayParts))
                      .join(display(item.separatorDisplayParts)) +
                    display(item.suffixDisplayParts),
                  documentation: display(item.documentation),
                  parameters: item.parameters.map((p) => ({
                    label: display(p.displayParts),
                    documentation: display(p.documentation),
                  })),
                })),
              }
            : base;
        }
        case "definition":
        case "typeDefinition":
        case "references": {
          const entries =
            input.operation === "typeDefinition"
              ? service.getTypeDefinitionAtPosition(file, input.offset)
              : input.operation === "references"
                ? service.getReferencesAtPosition(file, input.offset)
                : service.getDefinitionAtPosition(file, input.offset);
          return {
            ...base,
            locations: (entries ?? []).slice(0, MAX_RESULT_ITEMS).flatMap((entry) => {
              const value = location(entry.fileName, entry.textSpan);
              return value ? [value] : [];
            }),
          };
        }
        case "rename": {
          const info = service.getRenameInfo(file, input.offset, {
            allowRenameOfImportPath: false,
          });
          if (!info.canRename) throw new Error(info.localizedErrorMessage);
          if (!input.newName || !/^[$\p{ID_Start}][$\p{ID_Continue}]*$/u.test(input.newName))
            throw new Error("Enter a valid identifier.");
          const changes = new Map<string, ts.TextChange[]>();
          for (const item of service.findRenameLocations(file, input.offset, false, false, true) ??
            []) {
            const edits = changes.get(item.fileName) ?? [];
            edits.push({
              span: item.textSpan,
              newText: (item.prefixText ?? "") + input.newName + (item.suffixText ?? ""),
            });
            changes.set(item.fileName, edits);
          }
          return {
            ...base,
            span: info.triggerSpan,
            edits: fileEdits(
              [...changes].map(([fileName, textChanges]) => ({ fileName, textChanges })),
            ),
          };
        }
        case "documentSymbols": {
          const symbols: NonNullable<EditorIntelligenceResult["symbols"]>[number][] = [];
          const visit = (item: ts.NavigationTree, container: string) => {
            const loc = location(file, item.nameSpan ?? item.spans[0]!);
            if (item.kind !== "script" && loc)
              symbols.push({
                name: item.text,
                kind: item.kind,
                containerName: container,
                location: loc,
              });
            item.childItems?.forEach((child) =>
              visit(child, item.kind === "script" ? "" : item.text),
            );
          };
          visit(service.getNavigationTree(file), "");
          return { ...base, symbols: symbols.slice(0, MAX_RESULT_ITEMS) };
        }
        case "workspaceSymbols":
          return {
            ...base,
            symbols: service
              .getNavigateToItems(input.query ?? "", MAX_RESULT_ITEMS)
              .flatMap((item) => {
                const loc = location(item.fileName, item.textSpan);
                return loc
                  ? [
                      {
                        name: item.name,
                        kind: item.kind,
                        containerName: item.containerName ?? "",
                        location: loc,
                      },
                    ]
                  : [];
              }),
          };
        case "diagnostics":
          return { ...base, diagnostics: diagnostics(file).map(diagnostic) };
        case "codeActions": {
          const codes = diagnostics(file)
            .filter(
              (item) =>
                (item.start ?? 0) <= span.start + span.length &&
                (item.start ?? 0) + (item.length ?? 0) >= span.start,
            )
            .map((item) => item.code);
          const actions: NonNullable<EditorIntelligenceResult["actions"]>[number][] = [];
          for (const fix of service.getCodeFixesAtPosition(
            file,
            span.start,
            span.start + span.length,
            codes,
            formatting,
            preferences,
          )) {
            // Commands may invoke external tools. Only purely textual changes are offered.
            if (fix.commands?.length) continue;
            try {
              actions.push({
                title: fix.description,
                kind: "quickfix",
                edits: fileEdits(fix.changes),
              });
            } catch {
              /* Unsafe or file-creating fixes are not advertised. */
            }
          }
          for (const refactor of service.getApplicableRefactors(
            file,
            { pos: span.start, end: span.start + span.length },
            preferences,
          )) {
            for (const action of refactor.actions) {
              if (action.notApplicableReason) continue;
              try {
                const result = service.getEditsForRefactor(
                  file,
                  formatting,
                  { pos: span.start, end: span.start + span.length },
                  refactor.name,
                  action.name,
                  preferences,
                );
                if (result && !result.commands?.length)
                  actions.push({
                    title: action.description,
                    kind: "refactor",
                    edits: fileEdits(result.edits),
                  });
              } catch {
                /* Only edits representable by the native document transaction are offered. */
              }
            }
          }
          return { ...base, actions };
        }
        case "format":
          return {
            ...base,
            edits: fileEdits([
              {
                fileName: file,
                textChanges: input.length
                  ? service.getFormattingEditsForRange(
                      file,
                      span.start,
                      span.start + span.length,
                      formatting,
                    )
                  : service.getFormattingEditsForDocument(file, formatting),
              },
            ]),
          };
        case "organizeImports":
          return {
            ...base,
            edits: fileEdits(
              service.organizeImports({ type: "file", fileName: file }, formatting, preferences),
            ),
          };
        case "inlayHints":
          return {
            ...base,
            hints: service
              .provideInlayHints(
                file,
                span.length ? span : { start: 0, length: document.contents.length },
                preferences,
              )
              .map((hint) => ({
                offset: hint.position,
                text: hint.text,
                kind: hint.kind === ts.InlayHintKind.Parameter ? "parameter" : "type",
                whitespaceBefore: hint.whitespaceBefore ?? false,
                whitespaceAfter: hint.whitespaceAfter ?? false,
              })),
          };
        case "folding":
          return { ...base, folding: service.getOutliningSpans(file).map((item) => item.textSpan) };
      }
    },
  };
}
