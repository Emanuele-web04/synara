import { Schema } from "effect";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

const ExtensionId = TrimmedNonEmptyString.check(Schema.isMaxLength(257));
const Digest = Schema.String.check(Schema.isMaxLength(64));
export const EditorExtensionConsent = Schema.Struct({ id: ExtensionId, digest: Digest });
export type EditorExtensionConsent = typeof EditorExtensionConsent.Type;
export const EditorExtensionSummary = Schema.Struct({
  id: ExtensionId,
  version: Schema.String,
  displayName: Schema.String,
  description: Schema.String,
  digest: Digest,
  enabled: Schema.Boolean,
  approved: Schema.Boolean,
  source: Schema.Literals(["open-vsx", "vsix"]),
  dependencies: Schema.Array(ExtensionId),
  error: Schema.optional(Schema.String),
  updateVersion: Schema.optional(Schema.String),
});
export type EditorExtensionSummary = typeof EditorExtensionSummary.Type;
export const EditorRegistryExtension = Schema.Struct({
  namespace: Schema.String,
  name: Schema.String,
  version: Schema.String,
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  downloadCount: Schema.optional(NonNegativeInt),
  categories: Schema.optional(Schema.Array(Schema.String)),
  license: Schema.optional(Schema.String),
  apiRange: Schema.optional(Schema.String),
});
export const EditorExtensionsInput = Schema.Struct({
  operation: Schema.Literals([
    "list",
    "inspect",
    "search",
    "catalog",
    "details",
    "install",
    "remove",
    "setEnabled",
    "configure",
    "checkUpdates",
    "setTrust",
    "uploadBegin",
    "uploadAppend",
    "uploadFinish",
    "uploadCancel",
  ]),
  id: Schema.optional(ExtensionId),
  version: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  category: Schema.optional(
    Schema.Literals(["Programming Languages", "Formatters", "Linters", "Debuggers"]),
  ),
  sortBy: Schema.optional(Schema.Literals(["relevance", "downloadCount", "timestamp"])),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
  enabled: Schema.optional(Schema.Boolean),
  trusted: Schema.optional(Schema.Boolean),
  consent: Schema.optional(Schema.Array(EditorExtensionConsent).check(Schema.isMaxLength(64))),
  configurationJson: Schema.optional(Schema.String.check(Schema.isMaxLength(512_000))),
  uploadId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  chunk: Schema.optional(Schema.String.check(Schema.isMaxLength(1_048_576))),
  offset: Schema.optional(NonNegativeInt),
  total: Schema.optional(NonNegativeInt.check(Schema.isLessThanOrEqualTo(134_217_728))),
});
export type EditorExtensionsInput = typeof EditorExtensionsInput.Type;
export const EditorExtensionsResult = Schema.Struct({
  apiVersion: Schema.String,
  extensions: Schema.Array(EditorExtensionSummary),
  registryResults: Schema.Array(EditorRegistryExtension),
  registryTotal: Schema.optional(NonNegativeInt),
  registryNextOffset: Schema.optional(NonNegativeInt),
  registryDetails: Schema.optional(EditorRegistryExtension),
  trustedWorkspaces: Schema.Array(Schema.String),
  runtime: Schema.Literals([
    "not-built",
    "stopped",
    "starting",
    "running",
    "stopping",
    "failed",
    "unsupported",
  ]),
  uploadId: Schema.optional(Schema.String),
  offset: Schema.optional(NonNegativeInt),
  configurationJson: Schema.optional(Schema.String),
  configurationSchemaJson: Schema.optional(Schema.String),
});
export type EditorExtensionsResult = typeof EditorExtensionsResult.Type;
