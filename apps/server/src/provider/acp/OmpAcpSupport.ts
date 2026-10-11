/**
 * OMP ACP support - builds the Oh My Pi `omp acp` command and resolves auth.
 *
 * @module OmpAcpSupport
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import { resolveExecutable } from "@synara/shared/executable";
import { supportsPosixPermissions } from "@synara/shared/filesystemPlatform";
import {
  type ProviderInteractionMode,
  type ProviderModelDescriptor,
  OMP_THINKING_LEVEL_OPTIONS,
} from "@synara/contracts";
import { Effect, Layer, Scope, ServiceMap } from "effect";
import * as AcpErrors from "./AcpErrors.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { ChildProcessSpawner } from "effect/unstable/process";

import { expandProviderAccountHomePath } from "../../providerAccountHomePath.ts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import { buildProviderProcessEnv } from "../providerProcessEnv.ts";
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

export interface OmpAcpRuntimeSettings extends OmpAccountBoundary {
  readonly binaryPath?: string;
  readonly agentDir?: string;
}

/**
 * The account an `omp` child runs as. A selected environment or a non-default
 * provider instance gets a private synthetic HOME (and therefore its own
 * `~/.omp/agent` credentials and sessions); the default instance keeps the
 * user's ambient environment exactly.
 */
export interface OmpAccountBoundary {
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly instanceId?: string | undefined;
  readonly homeDir?: string | undefined;
  readonly isolationRootDir?: string | undefined;
}

export function ompIsolatesAccount(boundary: OmpAccountBoundary): boolean {
  const instanceId = boundary.instanceId?.trim();
  return boundary.environment !== undefined || (instanceId !== undefined && instanceId !== "omp");
}

function ompAccountProcessEnv(boundary: OmpAccountBoundary): NodeJS.ProcessEnv {
  return buildProviderProcessEnv({
    driver: "omp",
    env: process.env,
    ...(boundary.environment !== undefined ? { environment: boundary.environment } : {}),
    ...(boundary.instanceId !== undefined ? { instanceId: boundary.instanceId } : {}),
    ...(boundary.homeDir !== undefined ? { homeDir: boundary.homeDir } : {}),
    ...(boundary.isolationRootDir !== undefined
      ? { isolationRootDir: boundary.isolationRootDir }
      : {}),
  });
}

function expandOmpAgentDir(agentDir: string | undefined, boundary: OmpAccountBoundary) {
  const trimmed = agentDir?.trim();
  return trimmed ? expandProviderAccountHomePath(trimmed, boundary.homeDir) : undefined;
}

/** Environment for every `omp` child (ACP runtime and CLI) of one account. */
export function buildOmpProcessEnv(
  settings: Pick<OmpAcpRuntimeSettings, "agentDir"> & OmpAccountBoundary,
): NodeJS.ProcessEnv {
  const agentDir = expandOmpAgentDir(settings.agentDir, settings);
  return buildProviderChildEnvironment({
    provider: "omp",
    baseEnv: ompAccountProcessEnv(settings),
    // omp is pi-lineage: PI_CODING_AGENT_DIR selects the profile directory
    // (auth, sessions, skills, models) for every child invocation.
    ...(agentDir ? { overrides: { PI_CODING_AGENT_DIR: agentDir } } : undefined),
  });
}

/**
 * Mirrors OMP's getAgentDir() for one account: the configured override, then
 * the account environment, then `<HOME>/<PI_CONFIG_DIR|.omp>/agent`.
 */
export function resolveOmpAgentDir(
  settings: Pick<OmpAcpRuntimeSettings, "agentDir"> & OmpAccountBoundary,
): string {
  const configured = expandOmpAgentDir(settings.agentDir, settings);
  if (configured) return configured;
  const env = ompAccountProcessEnv(settings);
  const home = ompIsolatesAccount(settings)
    ? env.HOME?.trim() || env.USERPROFILE?.trim() || nodeOs.homedir()
    : nodeOs.homedir();
  return (
    env.PI_CODING_AGENT_DIR?.trim() ||
    nodePath.join(home, env.PI_CONFIG_DIR?.trim() || ".omp", "agent")
  );
}

/** Stable discovery-cache scope for one OMP account. */
export function ompAccountCacheScope(boundary: OmpAccountBoundary): string {
  if (!ompIsolatesAccount(boundary)) return "";
  const environment = Object.entries(boundary.environment ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  // Hashed: selected environments can carry credentials and cache keys are logged.
  return createHash("sha256")
    .update(JSON.stringify([boundary.instanceId?.trim() ?? "omp", environment]))
    .digest("hex");
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
  readonly method: "session/set_config_option" | "session/get_config_options";
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
    env: buildOmpProcessEnv(ompSettings ?? {}),
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
  readonly runtime: Pick<AcpSessionRuntimeShape, "getConfigOptions" | "setConfigOption">;
  readonly model: string;
  readonly thinkingLevel?: string | null | undefined;
  readonly mapError: (context: OmpAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const mapError = (cause: AcpErrors.AcpError) =>
      input.mapError({ cause, method: "session/set_config_option" });
    const model = input.model.trim();
    // `role:` was a Synara picker row key, never an OMP role selector. Refuse
    // stale keys before either config write (and therefore before prompting).
    // An exact advertised model remains valid even if its opaque id uses this
    // prefix; don't infer a replacement from role names or catalog rankings.
    if (model.startsWith("role:")) {
      const configOptions = yield* input.runtime.getConfigOptions.pipe(
        Effect.mapError((cause) => input.mapError({ cause, method: "session/get_config_options" })),
      );
      const modelConfig = findSelectConfig(configOptions, {
        id: OMP_MODEL_CONFIG_ID,
        category: "model",
      });
      if (
        !modelConfig ||
        !flattenConfigOptions(modelConfig.options).some((option) => option.value === model)
      ) {
        return yield* Effect.fail(
          mapError(
            new AcpErrors.AcpRequestError({
              code: -32602,
              errorMessage:
                "This saved OMP role is no longer supported. Choose an OMP model before sending.",
            }),
          ),
        );
      }
    }
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
