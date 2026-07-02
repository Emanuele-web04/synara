import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

export const PreviewRuntimeStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "stopped",
  "error",
]);
export type PreviewRuntimeStatus = typeof PreviewRuntimeStatus.Type;

export const PreviewResolverKind = Schema.Literals(["url", "package-script", "static"]);
export type PreviewResolverKind = typeof PreviewResolverKind.Type;

export const PreviewRuntimeState = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  projectId: Schema.NullOr(ProjectId),
  cwd: TrimmedNonEmptyString,
  targetCwd: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  status: PreviewRuntimeStatus,
  url: Schema.NullOr(TrimmedNonEmptyString),
  port: Schema.NullOr(NonNegativeInt),
  command: Schema.NullOr(TrimmedNonEmptyString),
  resolverKind: Schema.optionalKey(Schema.NullOr(PreviewResolverKind)),
  framework: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  scriptName: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  diagnostics: Schema.optionalKey(Schema.Array(Schema.String)),
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
  target: Schema.optional(TrimmedNonEmptyString),
  url: Schema.optional(TrimmedNonEmptyString),
  reuseOnly: Schema.optional(Schema.Boolean),
});
export type PreviewStartInput = Schema.Codec.Encoded<typeof PreviewStartInput>;

export const PreviewStopAllInput = Schema.Struct({
  threadId: ThreadId,
});
export type PreviewStopAllInput = Schema.Codec.Encoded<typeof PreviewStopAllInput>;

export const PreviewStopAllResult = Schema.Struct({
  stoppedCount: NonNegativeInt,
  killedPortCount: NonNegativeInt,
  failedCount: NonNegativeInt,
  urls: Schema.Array(TrimmedNonEmptyString),
});
export type PreviewStopAllResult = typeof PreviewStopAllResult.Type;

export const PreviewRuntimeStateEvent = Schema.Struct({
  type: Schema.Literal("state"),
  state: PreviewRuntimeState,
});
export const PreviewRuntimeSourceChangedEvent = Schema.Struct({
  type: Schema.Literal("source-changed"),
  state: PreviewRuntimeState,
  changedPath: Schema.NullOr(Schema.String),
  changedCount: NonNegativeInt,
});
export const PreviewRuntimeEvent = Schema.Union([
  PreviewRuntimeStateEvent,
  PreviewRuntimeSourceChangedEvent,
]);
export type PreviewRuntimeEvent = typeof PreviewRuntimeEvent.Type;
