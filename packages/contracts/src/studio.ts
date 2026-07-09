import { Schema } from "effect";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

/**
 * Thread-activity kind persisted by the server's per-turn Studio output capture
 * (filesystem scan diff). The web filters this kind out of the transcript work log
 * and uses it to invalidate the Studio outputs query.
 */
export const STUDIO_OUTPUTS_ACTIVITY_KIND = "studio.outputs.captured";

export const StudioListThreadOutputsInput = Schema.Struct({
  /** Thread whose produced Studio files should be listed. */
  threadId: ThreadId,
});
export type StudioListThreadOutputsInput = typeof StudioListThreadOutputsInput.Type;

export const StudioOutputEntry = Schema.Struct({
  /** File name, e.g. "2026-06-09_synara_local_dev_server_x_posts.md". */
  name: TrimmedNonEmptyString,
  /** Path relative to the Studio workspace root, e.g. "Outbox/Content/2026-06-09_....md". */
  relativePath: TrimmedNonEmptyString,
  /** Absolute path, used for reveal-in-Finder. */
  fullPath: TrimmedNonEmptyString,
  /** ISO timestamp of the last modification. */
  modifiedAt: TrimmedNonEmptyString,
});
export type StudioOutputEntry = typeof StudioOutputEntry.Type;

export const StudioListThreadOutputsResult = Schema.Struct({
  entries: Schema.Array(StudioOutputEntry),
});
export type StudioListThreadOutputsResult = typeof StudioListThreadOutputsResult.Type;
