import { Schema } from "effect";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

/** UTF-16 offsets, relative paths, and immutable snapshots. Services never save files. */
const EditorPath = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
const EditorText = Schema.String.check(Schema.isMaxLength(2_000_000));
export const EditorDocument = Schema.Struct({
  relativePath: EditorPath,
  contents: EditorText,
  version: NonNegativeInt,
});
export type EditorDocument = typeof EditorDocument.Type;
export const EditorOperation = Schema.Literals([
  "completion",
  "completionResolve",
  "hover",
  "signature",
  "definition",
  "typeDefinition",
  "references",
  "rename",
  "documentSymbols",
  "workspaceSymbols",
  "diagnostics",
  "codeActions",
  "format",
  "organizeImports",
  "inlayHints",
  "folding",
]);
export type EditorOperation = typeof EditorOperation.Type;
export const EditorIntelligenceInput = Schema.Struct({
  cwd: EditorPath,
  relativePath: EditorPath,
  documents: Schema.Array(EditorDocument).check(Schema.isMaxLength(64)),
  operation: EditorOperation,
  offset: NonNegativeInt,
  length: NonNegativeInt,
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
  completionSource: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  newName: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  tabSize: Schema.optional(NonNegativeInt.check(Schema.isLessThanOrEqualTo(16))),
  insertSpaces: Schema.optional(Schema.Boolean),
});
export type EditorIntelligenceInput = typeof EditorIntelligenceInput.Type;
const EditorSpan = Schema.Struct({ start: NonNegativeInt, length: NonNegativeInt });
export const EditorTextEdit = Schema.Struct({ ...EditorSpan.fields, newText: Schema.String });
export type EditorTextEdit = typeof EditorTextEdit.Type;
export const EditorFileEdits = Schema.Struct({
  relativePath: EditorPath,
  expectedContents: EditorText,
  edits: Schema.Array(EditorTextEdit),
});
export type EditorFileEdits = typeof EditorFileEdits.Type;
export const EditorLocation = Schema.Struct({
  relativePath: EditorPath,
  ...EditorSpan.fields,
  line: NonNegativeInt,
  character: NonNegativeInt,
  endLine: NonNegativeInt,
  endCharacter: NonNegativeInt,
});
export type EditorLocation = typeof EditorLocation.Type;
export const EditorDiagnostic = Schema.Struct({
  ...EditorSpan.fields,
  severity: Schema.Literals(["error", "warning", "info", "hint"]),
  message: Schema.String,
  code: NonNegativeInt,
  unnecessary: Schema.Boolean,
  deprecated: Schema.Boolean,
});
export type EditorDiagnostic = typeof EditorDiagnostic.Type;
export const EditorCompletion = Schema.Struct({
  label: Schema.String,
  kind: Schema.String,
  sortText: Schema.String,
  insertText: Schema.String,
  replacement: EditorSpan,
  source: Schema.optional(Schema.String),
});
export const EditorSymbol = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  containerName: Schema.String,
  location: EditorLocation,
});
export const EditorCodeAction = Schema.Struct({
  title: Schema.String,
  kind: Schema.String,
  edits: Schema.Array(EditorFileEdits),
});
export const EditorSignature = Schema.Struct({
  label: Schema.String,
  documentation: Schema.String,
  parameters: Schema.Array(Schema.Struct({ label: Schema.String, documentation: Schema.String })),
});
export const EditorIntelligenceResult = Schema.Struct({
  version: NonNegativeInt,
  completions: Schema.optional(Schema.Array(EditorCompletion)),
  text: Schema.optional(Schema.String),
  span: Schema.optional(EditorSpan),
  locations: Schema.optional(Schema.Array(EditorLocation)),
  edits: Schema.optional(Schema.Array(EditorFileEdits)),
  symbols: Schema.optional(Schema.Array(EditorSymbol)),
  diagnostics: Schema.optional(Schema.Array(EditorDiagnostic)),
  actions: Schema.optional(Schema.Array(EditorCodeAction)),
  signatures: Schema.optional(Schema.Array(EditorSignature)),
  activeSignature: Schema.optional(NonNegativeInt),
  activeParameter: Schema.optional(NonNegativeInt),
  hints: Schema.optional(
    Schema.Array(
      Schema.Struct({
        offset: NonNegativeInt,
        text: Schema.String,
        kind: Schema.Literals(["type", "parameter"]),
        whitespaceBefore: Schema.Boolean,
        whitespaceAfter: Schema.Boolean,
      }),
    ),
  ),
  folding: Schema.optional(Schema.Array(EditorSpan)),
});
export type EditorIntelligenceResult = typeof EditorIntelligenceResult.Type;
