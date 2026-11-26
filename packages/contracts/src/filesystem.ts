import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const FILESYSTEM_PATH_MAX_LENGTH = 512;

// Directory names may legally start or end with whitespace ("Photos "). A trimming
// schema rejects them when encoding a listing or using a listed folder as cwd.
const FilesystemPathString = Schema.String.check(Schema.isNonEmpty());

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(FilesystemPathString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

export const FilesystemCreateFolderInput = Schema.Struct({
  parentPath: FilesystemPathString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
});
export type FilesystemCreateFolderInput = typeof FilesystemCreateFolderInput.Type;

export const FilesystemBrowseEntry = Schema.Struct({
  name: FilesystemPathString,
  fullPath: FilesystemPathString,
});
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type;

export const FilesystemBrowseResult = Schema.Struct({
  parentPath: FilesystemPathString,
  entries: Schema.Array(FilesystemBrowseEntry),
});
export type FilesystemBrowseResult = typeof FilesystemBrowseResult.Type;
