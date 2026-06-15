import { Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_SEARCH_LOCAL_ENTRIES_MAX_LIMIT = 100;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_DIRECTORY_LIST_MAX_DEPTH = 32;
const PROJECT_TEXT_EDIT_MAX_LENGTH = 20_000;
const PROJECT_STYLE_EDIT_TEXT_MAX_LENGTH = 4_000;
const PROJECT_STYLE_EDIT_HTML_MAX_LENGTH = 12_000;
const PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH = 2_000;

export const ProjectKind = Schema.Literals(["project", "chat"]);
export type ProjectKind = typeof ProjectKind.Type;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectDirectoryEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  parentPath: Schema.optional(TrimmedNonEmptyString),
  hasChildren: Schema.Boolean,
});
export type ProjectDirectoryEntry = typeof ProjectDirectoryEntry.Type;

export const ProjectFileSystemEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  parentPath: Schema.optional(TrimmedNonEmptyString),
  kind: ProjectEntryKind,
  hasChildren: Schema.optional(Schema.Boolean),
});
export type ProjectFileSystemEntry = typeof ProjectFileSystemEntry.Type;

export const ProjectListDirectoriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
  depth: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_DIRECTORY_LIST_MAX_DEPTH)),
  ),
  includeFiles: Schema.optional(Schema.Boolean),
});
export type ProjectListDirectoriesInput = typeof ProjectListDirectoriesInput.Type;

export const ProjectListDirectoriesResult = Schema.Struct({
  entries: Schema.Array(ProjectFileSystemEntry),
});
export type ProjectListDirectoriesResult = typeof ProjectListDirectoriesResult.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectSearchLocalEntriesInput = Schema.Struct({
  rootPath: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_LOCAL_ENTRIES_MAX_LIMIT)),
  ),
  includeFiles: Schema.optional(Schema.Boolean),
});
export type ProjectSearchLocalEntriesInput = typeof ProjectSearchLocalEntriesInput.Type;

export const ProjectLocalSearchEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  parentPath: Schema.optional(TrimmedNonEmptyString),
  kind: ProjectEntryKind,
});
export type ProjectLocalSearchEntry = typeof ProjectLocalSearchEntry.Type;

export const ProjectSearchLocalEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectLocalSearchEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchLocalEntriesResult = typeof ProjectSearchLocalEntriesResult.Type;

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

const ProjectEditableElement = Schema.Struct({
  tagName: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_TEXT_MAX_LENGTH))),
  outerHTML: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_HTML_MAX_LENGTH)),
  ),
  attributes: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export const ProjectApplyTextEditInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  originalText: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_TEXT_EDIT_MAX_LENGTH)),
  nextText: Schema.String.check(Schema.isMaxLength(PROJECT_TEXT_EDIT_MAX_LENGTH)),
  element: Schema.optional(ProjectEditableElement),
});
export type ProjectApplyTextEditInput = typeof ProjectApplyTextEditInput.Type;

export const ProjectApplyTextEditResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  replacements: PositiveInt,
});
export type ProjectApplyTextEditResult = typeof ProjectApplyTextEditResult.Type;

export const ProjectElementStylePatch = Schema.Struct({
  color: Schema.optional(Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH))),
  backgroundColor: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  backgroundImage: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  backgroundPosition: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  backgroundSize: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  fontFamily: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  fontSize: Schema.optional(Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH))),
  fontWeight: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  fontStyle: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  lineHeight: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  letterSpacing: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  textAlign: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  opacity: Schema.optional(Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH))),
  padding: Schema.optional(Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH))),
  margin: Schema.optional(Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH))),
  borderWidth: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  borderColor: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  borderRadius: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  boxShadow: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  filter: Schema.optional(Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH))),
  animationName: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  animationDuration: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  animationTimingFunction: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  animationIterationCount: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_STYLE_EDIT_VALUE_MAX_LENGTH)),
  ),
  effectTarget: Schema.optional(Schema.Literals(["element", "::before", "::after"])),
});
export type ProjectElementStylePatch = typeof ProjectElementStylePatch.Type;

export const ProjectApplyStyleEditInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  element: ProjectEditableElement,
  patch: ProjectElementStylePatch,
});
export type ProjectApplyStyleEditInput = typeof ProjectApplyStyleEditInput.Type;

export const ProjectApplyStyleEditResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  replacements: PositiveInt,
});
export type ProjectApplyStyleEditResult = typeof ProjectApplyStyleEditResult.Type;
