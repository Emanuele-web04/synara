// FILE: providerInstance.ts
// Purpose: Defines generic provider-instance routing keys and config envelopes.
// Layer: Shared contracts
// Exports: ProviderInstanceId, ProviderDriverKind, config map schemas, helpers

import { Schema, SchemaTransformation } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

const PROVIDER_SLUG_MAX_CHARS = 64;
const PROVIDER_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ENVIRONMENT_VARIABLE_NAME_MAX_CHARS = 128;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Preserve the opaque runtime type while declaring its JSON transport shape.
const JsonUnknown: Schema.Codec<unknown, unknown> = Schema.Json.pipe(
  Schema.decodeTo(
    Schema.Unknown,
    SchemaTransformation.transform({
      decode: (value): unknown => value,
      encode: (value): Schema.Json => value as Schema.Json,
    }),
  ),
);

const ProviderSlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_SLUG_MAX_CHARS),
  Schema.isPattern(PROVIDER_SLUG_PATTERN),
);

// Driver kind names the implementation (codex, claudeAgent, cursor, ...).
export const ProviderDriverKind = ProviderSlug;
export type ProviderDriverKind = typeof ProviderDriverKind.Type;
const isProviderDriverKindValue = Schema.is(ProviderDriverKind);
export const isProviderDriverKind = (value: unknown): value is ProviderDriverKind =>
  isProviderDriverKindValue(value);

// Instance id is the routing key: multiple ids may share the same driver.
export const ProviderInstanceId = ProviderSlug;
export type ProviderInstanceId = typeof ProviderInstanceId.Type;

export const ProviderInstanceRef = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
});
export type ProviderInstanceRef = typeof ProviderInstanceRef.Type;

export const ProviderInstanceEnvironmentVariableName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ENVIRONMENT_VARIABLE_NAME_MAX_CHARS),
  Schema.isPattern(ENVIRONMENT_VARIABLE_NAME_PATTERN),
);
export type ProviderInstanceEnvironmentVariableName =
  typeof ProviderInstanceEnvironmentVariableName.Type;

export const ProviderInstanceEnvironmentVariable = Schema.Struct({
  name: ProviderInstanceEnvironmentVariableName,
  value: Schema.optional(Schema.String).pipe(Schema.withDecodingDefault(() => "")),
  sensitive: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  valueRedacted: Schema.optionalKey(Schema.Boolean),
});
export type ProviderInstanceEnvironmentVariable = typeof ProviderInstanceEnvironmentVariable.Type;

export const ProviderInstanceEnvironment = Schema.Array(ProviderInstanceEnvironmentVariable);
export type ProviderInstanceEnvironment = typeof ProviderInstanceEnvironment.Type;

// Opaque driver-specific config. Drivers decode this at the runtime boundary.
export const ProviderInstanceConfig = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optionalKey(ProviderInstanceEnvironment),
  enabled: Schema.optionalKey(Schema.Boolean),
  config: Schema.optionalKey(JsonUnknown),
});
export type ProviderInstanceConfig = typeof ProviderInstanceConfig.Type;

export const ProviderInstanceConfigMap = Schema.Record(ProviderInstanceId, ProviderInstanceConfig);
export type ProviderInstanceConfigMap = typeof ProviderInstanceConfigMap.Type;

// Legacy single-provider ids remain the default instance ids for migrations.
export function defaultInstanceIdForDriver(driver: ProviderDriverKind): ProviderInstanceId {
  return driver;
}

// ── Generic ACP agent instances ────────────────────────────────────────
// `config` payload for provider instances whose driver is "acp": a single
// agent binary that serves the Agent Client Protocol over stdio. One
// instance = one agent; the agent may itself multiplex upstream providers
// through its model list.

export const AcpAgentModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: Schema.optional(TrimmedNonEmptyString),
  reasoningEfforts: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type AcpAgentModel = typeof AcpAgentModel.Type;

export const AcpAgentInstanceConfig = Schema.Struct({
  // Executable plus the argv serving ACP, e.g. command "myagent" args ["acp"].
  command: TrimmedNonEmptyString,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
  // Static catalog used when the agent does not advertise a `model` config
  // option in-band; entries may still be overridden by in-band discovery.
  models: Schema.optionalKey(Schema.Array(AcpAgentModel)),
  // authenticate is attempted only when the agent advertises auth methods:
  // the configured id wins, otherwise the first advertised method is used.
  authMethodId: Schema.optionalKey(TrimmedNonEmptyString),
  // ACP config-option ids the agent uses for model and effort selection.
  // Default to the de-facto "model"/"thinking" ids shared by ACP agents.
  modelConfigId: Schema.optionalKey(TrimmedNonEmptyString),
  effortConfigId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AcpAgentInstanceConfig = typeof AcpAgentInstanceConfig.Type;
