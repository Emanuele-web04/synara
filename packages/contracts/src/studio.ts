import { Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

const STUDIO_RECENT_OUTPUTS_MAX_LIMIT = 100;

export const StudioListRecentOutputsInput = Schema.Struct({
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(STUDIO_RECENT_OUTPUTS_MAX_LIMIT)),
  ),
});
export type StudioListRecentOutputsInput = typeof StudioListRecentOutputsInput.Type;

export const StudioOutputEntry = Schema.Struct({
  /** File name, e.g. "2026-06-09_synara_local_dev_server_x_posts.md". */
  name: TrimmedNonEmptyString,
  /** Path relative to the Outbox root, e.g. "Content/2026-06-09_....md". */
  relativePath: TrimmedNonEmptyString,
  /** Absolute path, used for reveal-in-Finder. */
  fullPath: TrimmedNonEmptyString,
  /** ISO timestamp of the last modification. */
  modifiedAt: TrimmedNonEmptyString,
});
export type StudioOutputEntry = typeof StudioOutputEntry.Type;

export const StudioListRecentOutputsResult = Schema.Struct({
  outboxRoot: TrimmedNonEmptyString,
  entries: Schema.Array(StudioOutputEntry),
});
export type StudioListRecentOutputsResult = typeof StudioListRecentOutputsResult.Type;
