import { Schema } from "effect";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";
import { EditorDocument } from "./editorIntelligence";

export const EditorExtensionRuntimeInput = Schema.Struct({
  operation: Schema.Literals(["start", "stop", "restart", "request", "poll", "respond", "sync"]),
  cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  hostId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  method: Schema.optional(
    Schema.Literals(["activate", "language", "command", "state", "debug", "tree", "ui"]),
  ),
  paramsJson: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000_000))),
  documents: Schema.optional(Schema.Array(EditorDocument).check(Schema.isMaxLength(64))),
  after: Schema.optional(NonNegativeInt),
  requestId: Schema.optional(NonNegativeInt),
  responseJson: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000_000))),
  error: Schema.optional(Schema.String.check(Schema.isMaxLength(16_384))),
});
export type EditorExtensionRuntimeInput = typeof EditorExtensionRuntimeInput.Type;
export const EditorExtensionRuntimeEvent = Schema.Struct({
  sequence: NonNegativeInt,
  event: Schema.String,
  bodyJson: Schema.String,
});
export type EditorExtensionRuntimeEvent = typeof EditorExtensionRuntimeEvent.Type;
export const EditorExtensionRuntimeResult = Schema.Struct({
  hostId: Schema.String,
  status: Schema.Literals([
    "stopped",
    "starting",
    "running",
    "stopping",
    "failed",
    "unsupported",
    "not-built",
  ]),
  sequence: NonNegativeInt,
  events: Schema.Array(EditorExtensionRuntimeEvent),
  resultJson: Schema.optional(Schema.String),
});
export type EditorExtensionRuntimeResult = typeof EditorExtensionRuntimeResult.Type;
