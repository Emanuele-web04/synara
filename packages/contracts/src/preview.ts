import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const PreviewRuntimeStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "stopped",
  "error",
]);
export type PreviewRuntimeStatus = typeof PreviewRuntimeStatus.Type;

export const PreviewRuntimeState = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  projectId: Schema.NullOr(ProjectId),
  cwd: TrimmedNonEmptyString,
  status: PreviewRuntimeStatus,
  url: Schema.NullOr(TrimmedNonEmptyString),
  port: Schema.NullOr(NonNegativeInt),
  command: Schema.NullOr(TrimmedNonEmptyString),
  terminalId: Schema.NullOr(TrimmedNonEmptyString),
  ownedBySynara: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type PreviewRuntimeState = typeof PreviewRuntimeState.Type;

export const PreviewRuntimeInput = Schema.Struct({
  threadId: ThreadId,
  projectId: Schema.optional(ProjectId),
  cwd: TrimmedNonEmptyString,
});
export type PreviewRuntimeInput = Schema.Codec.Encoded<typeof PreviewRuntimeInput>;

export const PreviewStartInput = Schema.Struct({
  ...PreviewRuntimeInput.fields,
  preferredPort: Schema.optional(NonNegativeInt),
  command: Schema.optional(TrimmedNonEmptyString),
  reuseOnly: Schema.optional(Schema.Boolean),
});
export type PreviewStartInput = Schema.Codec.Encoded<typeof PreviewStartInput>;

export const PreviewRuntimeEvent = Schema.Struct({
  type: Schema.Literal("state"),
  state: PreviewRuntimeState,
});
export type PreviewRuntimeEvent = typeof PreviewRuntimeEvent.Type;
