import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

const FILESYSTEM_PATH_MAX_LENGTH = 512;

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

// Directory names may legally start or end with whitespace ("Photos "). A trimming
// schema rejects them when the server encodes the listing, failing the whole folder.
const FilesystemPathString = Schema.String.check(Schema.isNonEmpty());

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
