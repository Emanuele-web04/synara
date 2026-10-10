import { Schema } from "effect";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

/** the web filters this kind out of the transcript work log and uses it to invalidate the Studio outputs query */
export const STUDIO_OUTPUTS_ACTIVITY_KIND = "studio.outputs.captured";

export const StudioListThreadOutputsInput = Schema.Struct({
  threadId: ThreadId,
});
export type StudioListThreadOutputsInput = typeof StudioListThreadOutputsInput.Type;

export const StudioOutputEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString,
  fullPath: TrimmedNonEmptyString,
  modifiedAt: TrimmedNonEmptyString,
});
export type StudioOutputEntry = typeof StudioOutputEntry.Type;

export const StudioListThreadOutputsResult = Schema.Struct({
  entries: Schema.Array(StudioOutputEntry),
});
export type StudioListThreadOutputsResult = typeof StudioListThreadOutputsResult.Type;
