import { Schema } from "effect";
import { EnvironmentId, boundedTrimmedNonEmptyString } from "./baseSchemas";

const ResourceId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,256}$/));
const ResourcePath = boundedTrimmedNonEmptyString(4096);
const ResourceText = boundedTrimmedNonEmptyString(256);
export const RemoteResource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("attachment"), attachmentId: ResourceId }),
  Schema.Struct({
    kind: Schema.Literal("attachment-upload"),
    threadId: ResourceId,
    type: Schema.Literals(["image", "file"]),
    name: ResourceText,
    mimeType: ResourceText,
  }),
  Schema.Struct({ kind: Schema.Literal("attachment-cancel") }),
  Schema.Struct({
    kind: Schema.Literal("workspace-preview"),
    cwd: Schema.optional(ResourcePath),
    path: ResourcePath,
    revision: Schema.optional(ResourceText),
    grant: Schema.optional(boundedTrimmedNonEmptyString(4096)),
    download: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ kind: Schema.Literal("thread-export"), threadId: ResourceId }),
  Schema.Struct({ kind: Schema.Literal("project-favicon"), cwd: ResourcePath }),
  Schema.Struct({
    kind: Schema.Literal("site-favicon"),
    domain: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9.-]{1,253}$/)),
  }),
  Schema.Struct({ kind: Schema.Literal("editor-icon"), editorId: ResourceId }),
  Schema.Struct({
    kind: Schema.Literal("voice-upload"),
    provider: ResourceId,
    providerInstanceId: Schema.optional(ResourceText),
    cwd: ResourcePath,
    threadId: Schema.optional(ResourceId),
    mimeType: ResourceText,
    sampleRateHz: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 8000, maximum: 192000 }),
    ),
    durationMs: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 3600000 })),
  }),
]);
export type RemoteResource = typeof RemoteResource.Type;
export const RemoteResourceReference = Schema.Struct({
  environmentId: EnvironmentId,
  resource: RemoteResource,
});
export type RemoteResourceReference = typeof RemoteResourceReference.Type;
