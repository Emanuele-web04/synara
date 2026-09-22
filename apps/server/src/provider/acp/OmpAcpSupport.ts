/**
 * OMP ACP support - builds the Oh My Pi `omp acp` command and resolves auth.
 *
 * @module OmpAcpSupport
 */
import { existsSync } from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import { resolveExecutable } from "@synara/shared/executable";
import { supportsPosixPermissions } from "@synara/shared/filesystemPlatform";
import {
  type ProviderInteractionMode,
  type ProviderModelDescriptor,
  type OmpRoleDescriptor,
  type OmpThinkingLevel,
  OMP_THINKING_LEVEL_OPTIONS,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema, Scope, ServiceMap } from "effect";
import YAML from "yaml";
import * as AcpErrors from "./AcpErrors.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { ChildProcessSpawner } from "effect/unstable/process";

import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";
import {
  availableAuthMethodIds,
  findSelectConfig,
  flattenConfigOptions,
} from "./AcpConfigOptions.ts";

export interface OmpAcpRuntimeSettings {
  readonly binaryPath?: string;
  readonly agentDir?: string;
}

export interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "resolveAuthMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ompSettings: OmpAcpRuntimeSettings | null | undefined;
}

export interface OmpAcpModelSelectionErrorContext {
  readonly cause: AcpErrors.AcpError;
  readonly method: "session/set_config_option";
}

export interface OmpAcpModeSelectionErrorContext {
  readonly cause: AcpErrors.AcpError;
  readonly method: "session/set_config_option" | "session/get_config_options";
}

const OMP_MODEL_CONFIG_ID = "model";
const OMP_THINKING_CONFIG_ID = "thinking";
const OMP_MODE_CONFIG_ID = "mode";
const OMP_DEFAULT_MODE_ID = "default";
const OMP_PLAN_MODE_ID = "plan";

const OMP_AGENT_AUTH_METHOD_ID = "agent";

export interface OmpCliResolutionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly pathExists?: (path: string) => boolean;
}

/** Honors a configured binary path first, then resolves `omp` from PATH. */
export function resolveOmpCliBinaryPath(
  binaryPath?: string | null,
  options: OmpCliResolutionOptions = {},
): string {
  const configured = binaryPath?.trim();
  if (configured) {
    return configured;
  }
  const name = "omp";
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const resolved = resolveExecutable(name, { platform, env });
  if (resolved) {
    return resolved;
  }
  if (supportsPosixPermissions(platform)) {
    const localBin = nodePath.join(options.homeDir ?? nodeOs.homedir(), ".local", "bin", name);
    if ((options.pathExists ?? existsSync)(localBin)) {
      return localBin;
    }
  }
  return name;
}

export function buildOmpAcpSpawnInput(
  ompSettings: OmpAcpRuntimeSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  return {
    command: resolveOmpCliBinaryPath(ompSettings?.binaryPath),
    args: ["acp"],
    cwd,
    env: buildProviderChildEnvironment({
      provider: "omp",
      // omp is pi-lineage: PI_CODING_AGENT_DIR selects the profile directory
      // (auth, sessions, skills, models) for every child invocation.
      ...(ompSettings?.agentDir?.trim()
        ? { overrides: { PI_CODING_AGENT_DIR: ompSettings.agentDir.trim() } }
        : undefined),
    }),
  };
}

export const resolveOmpAcpAuthMethodId = (
  initializeResult: Acp.InitializeResponse,
  agentDir?: string,
): Effect.Effect<string, AcpErrors.AcpError> =>
  Effect.gen(function* () {
    const authMethodIds = availableAuthMethodIds(initializeResult);
    if (authMethodIds.has(OMP_AGENT_AUTH_METHOD_ID)) {
      return OMP_AGENT_AUTH_METHOD_ID;
    }
    return yield* new AcpErrors.AcpRequestError({
      code: -32602,
      errorMessage: "OMP ACP authentication is unavailable.",
      data: {
        authMethods: [...authMethodIds],
        detail: `Run \`omp\` to authenticate locally so ${agentDir?.trim() || "~/.omp"} credentials exist.`,
      },
    });
  });

export const makeOmpAcpRuntime = (
  input: OmpAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOmpAcpSpawnInput(input.ompSettings, input.cwd),
        resolveAuthMethodId: (initializeResult) =>
          resolveOmpAcpAuthMethodId(initializeResult, input.ompSettings?.agentDir),
        authenticateMeta: { headless: true },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });

/**
 * Applies the requested model and thinking level over ACP. `omp acp` reads its
 * model and thinking from session config options (not CLI flags), so
 * `session/set_config_option` is the only mechanism that switches them. The
 * model is applied first because it determines which thinking levels are valid.
 * The shared runtime validates values against the advertised options and skips
 * the RPC when the current value already matches.
 */
export function applyOmpAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "setConfigOption">;
  readonly model: string;
  readonly thinkingLevel?: string | null | undefined;
  readonly mapError: (context: OmpAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const mapError = (cause: AcpErrors.AcpError) =>
      input.mapError({ cause, method: "session/set_config_option" });
    const model = input.model.trim();
    if (model) {
      yield* input.runtime
        .setConfigOption(OMP_MODEL_CONFIG_ID, model)
        .pipe(Effect.mapError(mapError));
    }
    const thinkingLevel = input.thinkingLevel?.trim().toLowerCase();
    if (thinkingLevel) {
      yield* input.runtime
        .setConfigOption(OMP_THINKING_CONFIG_ID, thinkingLevel)
        .pipe(Effect.mapError(mapError));
    }
  });
}

/**
 * Applies OMP's native mode config option before a prompt is dispatched. OMP
 * advertises a `mode` select option (category "mode") with `default` always
 * present and `plan` only when plan mode is enabled. Synara's `plan`
 * interaction mode routes to OMP `"plan"`; everything else passes through as
 * `default`. If the requested mode is not advertised (e.g. plan disabled), or
 * OMP did not advertise a mode option, OMP is left on its current (default) mode.
 */
export function applyOmpAcpInteractionMode<E>(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "getConfigOptions" | "setConfigOption">;
  readonly interactionMode?: ProviderInteractionMode;
  readonly mapError: (context: OmpAcpModeSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  const requestedModeId = input.interactionMode === "plan" ? OMP_PLAN_MODE_ID : OMP_DEFAULT_MODE_ID;
  return Effect.gen(function* () {
    const mapError = (cause: AcpErrors.AcpError) =>
      input.mapError({ cause, method: "session/set_config_option" });
    const options = yield* input.runtime.getConfigOptions.pipe(
      Effect.mapError((cause) => input.mapError({ cause, method: "session/get_config_options" })),
    );
    const modeConfig = findSelectConfig(options, {
      id: OMP_MODE_CONFIG_ID,
      category: "mode",
    });
    // Unknown/unavailable requested mode, or no mode option advertised → leave OMP as-is.
    if (!modeConfig) {
      return;
    }
    const advertisedValues = new Set(
      flattenConfigOptions(modeConfig.options).map((choice) => choice.value),
    );
    if (!advertisedValues.has(requestedModeId)) {
      return;
    }
    yield* input.runtime
      .setConfigOption(modeConfig.id, requestedModeId)
      .pipe(Effect.mapError(mapError));
  });
}

/**
 * Parses the multi-provider model catalog emitted by `omp models --json`.
 *
 * OMP aggregates many upstream providers (alibaba, cursor, google, xai, …) and
 * `omp models --json` returns every model in a single subprocess call, each with
 * its own `thinking` effort list inline. Discovery is therefore O(1) round-trips
 * and scales to OMP's full catalog. The in-band ACP model option exposes only
 * slug/name; reading per-model thinking that way needs one
 * `session/set_config_option` round-trip per model, which is unscalable for the
 * 300+ model catalogs OMP routinely serves.
 */
const OMP_THINKING_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  auto: "Auto",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
  xhigh: "XHigh",
};

const ompThinkingLabel = (value: string): string =>
  OMP_THINKING_LABELS[value] ?? value.charAt(0).toUpperCase() + value.slice(1);
const OMP_THINKING_LEVEL_SET: ReadonlySet<string> = new Set(OMP_THINKING_LEVEL_OPTIONS);

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readStringArrayField(record: Record<string, unknown>, key: string): ReadonlyArray<string> {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

/** Raw `YAML.parse` output — the trust boundary for `~/.omp` config reads. */
type OmpConfigYamlValue = ReturnType<typeof YAML.parse>;

const OmpConfigRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const toOmpConfigRecordOption = Schema.decodeUnknownOption(OmpConfigRecordSchema);

/** OMP accepts a role value as a string or an all-strings array (a comma-joined
 * fallback chain); anything else is skipped, matching `modelRoleValueFromUnknown`. */
function ompRolePatternsFromUnknown(rawValue: unknown): ReadonlyArray<string> {
  const entries =
    typeof rawValue === "string"
      ? [rawValue]
      : Array.isArray(rawValue)
        ? rawValue.every((entry): entry is string => typeof entry === "string")
          ? rawValue
          : []
        : [];
  return entries
    .flatMap((entry) => entry.split(","))
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

/**
 * Split a trailing `:<level>` selector off a pattern, like OMP's
 * `splitThinkingSuffix` — every known thinking level plus the guarded `:auto`
 * sentinel and `:max` tier split here; the colon must sit strictly after
 * `minColonIndex` (role-alias callers pass the alias prefix length).
 */
function splitOmpThinkingSuffix(
  pattern: string,
  minColonIndex = 0,
): { base: string; level?: OmpThinkingLevel } {
  const lastColon = pattern.lastIndexOf(":");
  if (lastColon <= minColonIndex) return { base: pattern };
  const suffix = pattern.slice(lastColon + 1);
  const level = OMP_THINKING_LEVEL_OPTIONS.find((candidate) => candidate === suffix);
  return level === undefined ? { base: pattern } : { base: pattern.slice(0, lastColon), level };
}

function ompCatalogParts(model: ProviderModelDescriptor): { provider: string; id: string } {
  const slash = model.slug.indexOf("/");
  return slash === -1
    ? { provider: "", id: model.slug }
    : { provider: model.slug.slice(0, slash), id: model.slug.slice(slash + 1) };
}

/**
 * OMP `matchModel`'s exact phases: a `provider/id` selector, then a bare id —
 * both case-insensitive. A `provider/…` pattern stays locked to that provider
 * when it exists in the catalog (`isProviderLockedCrossMatch`), so a bare id
 * matching only another provider's model does not resolve.
 */
function matchOmpCatalogExact(
  pattern: string,
  catalog: ReadonlyArray<ProviderModelDescriptor>,
): ProviderModelDescriptor | undefined {
  const lower = pattern.toLowerCase();
  const ref = catalog.find((model) => model.slug.toLowerCase() === lower);
  if (ref) return ref;
  const slash = pattern.indexOf("/");
  const lockedProvider =
    slash > 0 &&
    catalog.some(
      (model) =>
        ompCatalogParts(model).provider.toLowerCase() === pattern.slice(0, slash).toLowerCase(),
    )
      ? pattern.slice(0, slash).toLowerCase()
      : undefined;
  return catalog.find(
    (model) =>
      ompCatalogParts(model).id.toLowerCase() === lower &&
      (lockedProvider === undefined ||
        ompCatalogParts(model).provider.toLowerCase() === lockedProvider),
  );
}

/**
 * OMP `matchModel`'s non-exact phases, approximated for picker display:
 * `provider/partial` substring-matches ids within that provider (a miss there
 * exhausts the pattern — the provider lock does not fall through), and anything
 * else substring-matches id or name. Catalog order decides ties where OMP
 * scores fuzzy hits and consults usage ranks.
 */
function matchOmpCatalogModel(
  pattern: string,
  catalog: ReadonlyArray<ProviderModelDescriptor>,
  exactOnly: boolean,
): ProviderModelDescriptor | undefined {
  const exact = matchOmpCatalogExact(pattern, catalog);
  if (exact) return exact;
  if (exactOnly) return undefined;
  const slash = pattern.indexOf("/");
  if (slash > 0) {
    const provider = pattern.slice(0, slash).toLowerCase();
    const providerModels = catalog.filter(
      (model) => ompCatalogParts(model).provider.toLowerCase() === provider,
    );
    if (providerModels.length > 0) {
      const idPattern = pattern.slice(slash + 1).toLowerCase();
      return providerModels.find((model) =>
        ompCatalogParts(model).id.toLowerCase().includes(idPattern),
      );
    }
    // The prefix is not a catalog provider — the slash stays part of the id.
  }
  const lower = pattern.toLowerCase();
  return catalog.find(
    (model) =>
      ompCatalogParts(model).id.toLowerCase().includes(lower) ||
      model.name.toLowerCase().includes(lower),
  );
}

interface OmpRolePatternResult {
  readonly model: string;
  readonly thinkingLevel?: OmpThinkingLevel | undefined;
  /** Set when resolution went through OMP's invalid-`:suffix` fallback path. */
  readonly warning?: string | undefined;
}

/**
 * Resolve one role pattern against the discovered catalog, mirroring OMP's
 * `parseModelPatternWithContext`: whole-pattern exact first (literal ids keep a
 * `:level`), then the guarded thinking-suffix split — whose recursion strips
 * the level when the inner match carries a warning — then the non-exact
 * catalog match, and finally the invalid-`:suffix` fallback that resolves the
 * prefix and reports a warning like OMP does.
 */
function matchOmpRolePattern(
  pattern: string,
  catalog: ReadonlyArray<ProviderModelDescriptor>,
): OmpRolePatternResult | undefined {
  const exact = matchOmpCatalogModel(pattern, catalog, true);
  if (exact) return { model: exact.slug };

  const { base, level } = splitOmpThinkingSuffix(pattern);
  if (level !== undefined) {
    // A literal catalog id can itself end in `:<level>` (`router:low`) — a
    // fuzzy hit on the full pattern whose id does wins over the split.
    const literal = matchOmpCatalogModel(pattern, catalog, false);
    if (literal !== undefined && ompCatalogParts(literal).id.toLowerCase().endsWith(`:${level}`)) {
      return { model: literal.slug };
    }
    const inner = matchOmpRolePattern(base, catalog);
    if (inner === undefined) return undefined;
    return {
      model: inner.model,
      ...(inner.warning === undefined ? { thinkingLevel: level } : {}),
      ...(inner.warning !== undefined ? { warning: inner.warning } : {}),
    };
  }

  const fuzzy = matchOmpCatalogModel(pattern, catalog, false);
  if (fuzzy) return { model: fuzzy.slug };

  // Invalid `:suffix` — drop it and resolve the prefix; OMP resolves the model
  // and warns that the configured level is ignored.
  const lastColon = pattern.lastIndexOf(":");
  if (lastColon > 0) {
    const inner = matchOmpRolePattern(pattern.slice(0, lastColon), catalog);
    if (inner !== undefined) {
      return { model: inner.model, warning: `invalid thinking level in "${pattern}"` };
    }
  }
  return undefined;
}

/** OMP's built-in role ids — an alias resolves against these or any configured `modelRoles` key. */
const OMP_BUILTIN_ROLE_IDS: ReadonlySet<string> = new Set([
  "advisor",
  "commit",
  "default",
  "dictation",
  "image",
  "judge",
  "memory",
  "plan",
  "slow",
  "smol",
  "speech",
  "task",
  "tiny",
  "vision",
  "web",
]);

/**
 * OMP `resolveConfiguredRolePattern`: `@role`, `pi/role`, and `*` (the default
 * role) expand to that role's configured chain — recursively, and dropping
 * cycles. The alias's own `:level` suffix rides onto every expanded pattern.
 * A pattern that is not a role alias stays literal, and one whose alias is
 * unresolvable (unconfigured role — OMP would consult its built-in priority
 * defaults, which live in the agent, not the catalog) contributes nothing.
 */
function expandOmpRolePattern(
  pattern: string,
  modelRoles: Record<string, unknown>,
  visited: ReadonlySet<string>,
): ReadonlyArray<string> | undefined {
  const prefixLength = pattern.startsWith("@")
    ? 1
    : pattern.startsWith("pi/")
      ? 3
      : pattern === "*"
        ? 0
        : -1;
  if (prefixLength === -1) return [pattern];
  const { base, level } = splitOmpThinkingSuffix(pattern, prefixLength);
  const candidate = base === "*" ? "default" : base.slice(prefixLength);
  if (!OMP_BUILTIN_ROLE_IDS.has(candidate) && !Object.hasOwn(modelRoles, candidate)) {
    return [pattern];
  }
  if (visited.has(candidate)) return undefined;
  const nextVisited = new Set(visited).add(candidate);
  const configured = Object.hasOwn(modelRoles, candidate)
    ? ompRolePatternsFromUnknown(modelRoles[candidate])
    : [];
  const expanded = configured.flatMap(
    (nested) => expandOmpRolePattern(nested, modelRoles, nextVisited) ?? [],
  );
  return level !== undefined ? expanded.map((nested) => `${nested}:${level}`) : expanded;
}

/**
 * Parses OMP `modelRoles` entries (from `<agentDir>/config.yml` or
 * `<cwd>/.omp/config.yml`) into role descriptors. Each value is a fallback
 * chain — a comma-separated string or an all-strings array, with `@role` /
 * `pi/role` / `*` aliases expanded against the same map — whose first entry
 * resolving against `catalog` wins, carrying its `:level` thinking suffix when
 * present. Unresolvable chains surface their first entry so committing them
 * fails against the provider the way OMP's unresolved-role warning does.
 * Insertion order is preserved so the picker lists roles in config order.
 */
export function parseOmpModelRoles(
  modelRoles: OmpConfigYamlValue,
  catalog: ReadonlyArray<ProviderModelDescriptor> = [],
): ReadonlyArray<OmpRoleDescriptor> {
  const record = Option.getOrUndefined(toOmpConfigRecordOption(modelRoles));
  if (record === undefined) return [];
  const roles: OmpRoleDescriptor[] = [];
  for (const [name, rawValue] of Object.entries(record)) {
    const patterns = ompRolePatternsFromUnknown(rawValue);
    if (patterns.length === 0) continue;
    const expanded = patterns.flatMap(
      (pattern) => expandOmpRolePattern(pattern, record, new Set()) ?? [],
    );
    const resolved = expanded
      .map((pattern) => matchOmpRolePattern(pattern, catalog))
      .find((match) => match !== undefined);
    if (resolved) {
      roles.push({
        name,
        model: resolved.model,
        ...(resolved.thinkingLevel !== undefined ? { thinkingLevel: resolved.thinkingLevel } : {}),
      });
      continue;
    }
    const { base, level } = splitOmpThinkingSuffix(patterns[0]!);
    roles.push({ name, model: base, ...(level !== undefined ? { thinkingLevel: level } : {}) });
  }
  return roles;
}

const OmpAgentConfigSchema = Schema.Struct({
  modelRoles: Schema.optional(OmpConfigRecordSchema),
});
const toOmpAgentConfigOption = Schema.decodeUnknownOption(OmpAgentConfigSchema);

/**
 * Reads the raw `modelRoles` map out of a `config.yml`/`config.yaml` text for
 * layer merging — callers combine global and project maps (project wins per
 * role name, matching OMP's layer order) before resolving with
 * {@link parseOmpModelRoles}. An unparseable YAML document throws to the
 * caller; a document whose `modelRoles` subtree is absent or malformed yields
 * an empty map.
 */
export function ompModelRolesMapFromConfig(configYaml: string): Record<string, unknown> {
  const config = Option.getOrUndefined(toOmpAgentConfigOption(YAML.parse(configYaml)));
  return Option.getOrUndefined(toOmpConfigRecordOption(config?.modelRoles)) ?? {};
}

export function parseOmpCliModelList(stdout: string): ReadonlyArray<ProviderModelDescriptor> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  let rawModels: ReadonlyArray<unknown>;
  if (Array.isArray(parsed)) {
    rawModels = parsed;
  } else if (isStringRecord(parsed) && "models" in parsed && Array.isArray(parsed.models)) {
    rawModels = parsed.models;
  } else {
    rawModels = [];
  }
  const seen = new Set<string>();
  const models: ProviderModelDescriptor[] = [];
  for (const entry of rawModels) {
    if (!isStringRecord(entry)) {
      continue;
    }
    const slug = readStringField(entry, "selector").trim();
    const name = readStringField(entry, "name").trim();
    if (!slug || !name || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const upstreamProviderId = readStringField(entry, "provider").trim();
    const thinking = readStringArrayField(entry, "thinking");
    const seenEfforts = new Set<string>();
    const efforts = thinking
      .map((value) => value.trim().toLowerCase())
      .filter((value): value is string => {
        if (seenEfforts.has(value) || !OMP_THINKING_LEVEL_SET.has(value)) {
          return false;
        }
        seenEfforts.add(value);
        return true;
      });
    models.push({
      slug,
      name,
      ...(upstreamProviderId ? { upstreamProviderId } : {}),
      ...(efforts.length > 0
        ? {
            supportedReasoningEfforts: efforts.map((value) => ({
              value,
              label: ompThinkingLabel(value),
            })),
          }
        : {}),
    });
  }
  return models;
}
