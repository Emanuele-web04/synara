import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

const ProviderDiscoveryKind = Schema.Literals(["codex", "claudeAgent"]);

export const ProviderSkillInterface = Schema.Struct({
  displayName: Schema.optional(TrimmedNonEmptyString),
  shortDescription: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSkillInterface = typeof ProviderSkillInterface.Type;

export const ProviderSkillDescriptor = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  path: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  scope: Schema.optional(TrimmedNonEmptyString),
  interface: Schema.optional(ProviderSkillInterface),
  dependencies: Schema.optional(Schema.Unknown),
});
export type ProviderSkillDescriptor = typeof ProviderSkillDescriptor.Type;

export const ProviderSkillReference = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
});
export type ProviderSkillReference = typeof ProviderSkillReference.Type;

export const ProviderComposerCapabilities = Schema.Struct({
  provider: ProviderDiscoveryKind,
  supportsSkillMentions: Schema.Boolean,
  supportsSkillDiscovery: Schema.Boolean,
  supportsRuntimeModelList: Schema.Boolean,
});
export type ProviderComposerCapabilities = typeof ProviderComposerCapabilities.Type;

export const ProviderGetComposerCapabilitiesInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
});
export type ProviderGetComposerCapabilitiesInput = typeof ProviderGetComposerCapabilitiesInput.Type;

export const ProviderListSkillsInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
  cwd: TrimmedNonEmptyString,
  threadId: Schema.optional(TrimmedNonEmptyString),
  forceReload: Schema.optional(Schema.Boolean),
});
export type ProviderListSkillsInput = typeof ProviderListSkillsInput.Type;

export const ProviderListSkillsResult = Schema.Struct({
  skills: Schema.Array(ProviderSkillDescriptor),
  source: Schema.optional(TrimmedNonEmptyString),
  cached: Schema.optional(Schema.Boolean),
});
export type ProviderListSkillsResult = typeof ProviderListSkillsResult.Type;

export const ProviderListModelsInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
});
export type ProviderListModelsInput = typeof ProviderListModelsInput.Type;

export const ProviderModelDescriptor = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type ProviderModelDescriptor = typeof ProviderModelDescriptor.Type;

export const ProviderListModelsResult = Schema.Struct({
  models: Schema.Array(ProviderModelDescriptor),
  source: Schema.optional(TrimmedNonEmptyString),
  cached: Schema.optional(Schema.Boolean),
});
export type ProviderListModelsResult = typeof ProviderListModelsResult.Type;
