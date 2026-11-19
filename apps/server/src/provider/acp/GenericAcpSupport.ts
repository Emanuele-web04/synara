/**
 * Generic ACP support - builds the spawn input for a user-registered
 * ACP-compatible agent and resolves auth/model config generically.
 *
 * One provider instance = one agent binary speaking the Agent Client Protocol
 * over stdio. The agent itself may multiplex many upstream providers through
 * its model list (like `omp acp` or `opencode acp` do); Synara does not need to
 * know about the upstreams.
 *
 * @module GenericAcpSupport
 */
import { createHash } from "node:crypto";

import {
  type AcpAgentModel,
  type ProviderInteractionMode,
  type ProviderModelDescriptor,
} from "@synara/contracts";
import { Effect, Layer, Scope, ServiceMap } from "effect";
import * as AcpErrors from "./AcpErrors.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { ChildProcessSpawner } from "effect/unstable/process";

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

/**
 * The boundary an `acp` child runs inside. A selected environment or a
 * non-default provider instance gets a private synthetic HOME (its own
 * credentials and session state); the default instance keeps the user's
 * ambient environment exactly.
 */
export interface AcpAgentBoundary {
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly instanceId?: string | undefined;
  readonly homeDir?: string | undefined;
  readonly isolationRootDir?: string | undefined;
}

export interface AcpAgentRuntimeSettings extends AcpAgentBoundary {
  /** Executable path or bare command name resolved through PATH. */
  readonly command?: string;
  /** Arguments appended after the executable; defaults to `["acp"]`. */
  readonly args?: ReadonlyArray<string>;
  /** ACP `session/authenticate` method id; first advertised method when unset. */
  readonly authMethodId?: string;
  /** Config-option id carrying the model selector; defaults to `"model"`. */
  readonly modelConfigId?: string;
  /** Config-option id carrying the reasoning effort; defaults to `"thinking"`. */
  readonly effortConfigId?: string;
  /** Static model catalog served when the agent does not advertise one. */
  readonly models?: ReadonlyArray<AcpAgentModel>;
}

export function acpAgentIsolatesInstance(boundary: AcpAgentBoundary): boolean {
  const instanceId = boundary.instanceId?.trim();
  return boundary.environment !== undefined || (instanceId !== undefined && instanceId !== "acp");
}

function acpInstanceProcessEnv(boundary: AcpAgentBoundary): NodeJS.ProcessEnv {
  return buildProviderProcessEnv({
    driver: "acp",
    env: process.env,
    ...(boundary.environment !== undefined ? { environment: boundary.environment } : {}),
    ...(boundary.instanceId !== undefined ? { instanceId: boundary.instanceId } : {}),
    ...(boundary.homeDir !== undefined ? { homeDir: boundary.homeDir } : {}),
    ...(boundary.isolationRootDir !== undefined
      ? { isolationRootDir: boundary.isolationRootDir }
      : {}),
  });
}

/** Environment for every `acp` child (ACP runtime and discovery) of one instance. */
export function buildAcpAgentProcessEnv(boundary: AcpAgentBoundary): NodeJS.ProcessEnv {
  return buildProviderChildEnvironment({
    provider: "acp",
    baseEnv: acpInstanceProcessEnv(boundary),
  });
}

/** Stable discovery-cache scope for one ACP instance. */
export function acpInstanceCacheScope(boundary: AcpAgentBoundary): string {
  if (!acpAgentIsolatesInstance(boundary)) return "";
  const environment = Object.entries(boundary.environment ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  // Hashed: selected environments can carry credentials and cache keys are logged.
  return createHash("sha256")
    .update(JSON.stringify([boundary.instanceId?.trim() ?? "acp", environment]))
    .digest("hex");
}

export interface AcpAgentRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "resolveAuthMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly agentSettings: AcpAgentRuntimeSettings | null | undefined;
}

export interface AcpAgentModelSelectionErrorContext {
  readonly cause: AcpErrors.AcpError;
  readonly method: "session/set_config_option" | "session/get_config_options";
}

export interface AcpAgentModeSelectionErrorContext {
  readonly cause: AcpErrors.AcpError;
  readonly method: "session/set_config_option" | "session/get_config_options";
}

const ACP_DEFAULT_MODEL_CONFIG_ID = "model";
const ACP_DEFAULT_EFFORT_CONFIG_ID = "thinking";
const ACP_MODE_CONFIG_ID = "mode";
const ACP_DEFAULT_MODE_ID = "default";
const ACP_PLAN_MODE_ID = "plan";

const isBareCommandName = (command: string): boolean =>
  !command.includes("/") && !command.includes("\\");

/**
 * Honors a configured executable first; a bare command name passes through so
 * the child spawner resolves it from PATH with the same rules as every other
 * provider launch.
 */
export function resolveAcpAgentCommand(command?: string | null): string {
  return command?.trim() || "";
}

export function buildGenericAcpSpawnInput(
  agentSettings: AcpAgentRuntimeSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  const command = resolveAcpAgentCommand(agentSettings?.command);
  return {
    command,
    // ACP agents conventionally serve the protocol from an `acp` subcommand.
    args: [...(agentSettings?.args ?? ["acp"])],
    cwd,
    env: buildAcpAgentProcessEnv(agentSettings ?? {}),
    ...(isBareCommandName(command) ? {} : {}),
  };
}

/**
 * Generic auth: a configured method id wins (sent even when the agent does not
 * advertise it, since explicit configuration is authoritative), then the first
 * advertised method. Agents advertising no methods and requiring no auth pair
 * with `authPolicy: "on-demand"`, which never reaches this resolver.
 */
export const resolveGenericAcpAuthMethodId = (
  initializeResult: Acp.InitializeResponse,
  configuredAuthMethodId?: string,
): Effect.Effect<string, AcpErrors.AcpError> =>
  Effect.gen(function* () {
    const authMethodIds = availableAuthMethodIds(initializeResult);
    const configured = configuredAuthMethodId?.trim();
    if (configured) {
      if (authMethodIds.size === 0 || authMethodIds.has(configured)) {
        return configured;
      }
      return yield* new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: `The ACP agent does not advertise the configured auth method "${configured}".`,
        data: { authMethods: [...authMethodIds] },
      });
    }
    const first = [...authMethodIds][0];
    if (first === undefined) {
      return yield* new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "The ACP agent requires authentication but advertises no auth methods.",
        data: { authMethods: [] },
      });
    }
    return first;
  });

export const makeGenericAcpRuntime = (
  input: AcpAgentRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGenericAcpSpawnInput(input.agentSettings, input.cwd),
        resolveAuthMethodId: (initializeResult) =>
          resolveGenericAcpAuthMethodId(initializeResult, input.agentSettings?.authMethodId),
        // With an explicit auth method the agent is authenticated up front;
        // otherwise session setup runs first and only a verified auth-required
        // failure retries with the first advertised method.
        authPolicy: input.agentSettings?.authMethodId?.trim() ? "always" : "on-demand",
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
 * Applies the requested model and reasoning effort over ACP. Generic agents
 * read both from session config options; the option ids default to OMP's
 * `model`/`thinking` convention and are configurable per instance.
 */
export function applyAcpAgentModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "getConfigOptions" | "setConfigOption">;
  readonly model: string;
  readonly thinkingLevel?: string | null | undefined;
  readonly modelConfigId?: string;
  readonly effortConfigId?: string;
  readonly mapError: (context: AcpAgentModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const mapError = (cause: AcpErrors.AcpError) =>
      input.mapError({ cause, method: "session/set_config_option" });
    const model = input.model.trim();
    const modelConfigId = input.modelConfigId?.trim() || ACP_DEFAULT_MODEL_CONFIG_ID;
    if (model) {
      yield* input.runtime.setConfigOption(modelConfigId, model).pipe(Effect.mapError(mapError));
    }
    const thinkingLevel = input.thinkingLevel?.trim().toLowerCase();
    if (thinkingLevel) {
      const effortConfigId = input.effortConfigId?.trim() || ACP_DEFAULT_EFFORT_CONFIG_ID;
      yield* input.runtime
        .setConfigOption(effortConfigId, thinkingLevel)
        .pipe(Effect.mapError(mapError));
    }
  });
}

/**
 * Applies the interaction mode over ACP. `plan` maps to the advertised `plan`
 * mode, everything else to `default`; agents without a mode option are left on
 * their current mode.
 */
export function applyAcpAgentInteractionMode<E>(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "getConfigOptions" | "setConfigOption">;
  readonly interactionMode?: ProviderInteractionMode;
  readonly mapError: (context: AcpAgentModeSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  const requestedModeId = input.interactionMode === "plan" ? ACP_PLAN_MODE_ID : ACP_DEFAULT_MODE_ID;
  return Effect.gen(function* () {
    const mapError = (cause: AcpErrors.AcpError) =>
      input.mapError({ cause, method: "session/set_config_option" });
    const options = yield* input.runtime.getConfigOptions.pipe(
      Effect.mapError((cause) => input.mapError({ cause, method: "session/get_config_options" })),
    );
    const modeConfig = findSelectConfig(options, {
      id: ACP_MODE_CONFIG_ID,
      category: "mode",
    });
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

const ACP_EFFORT_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  auto: "Auto",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
  xhigh: "XHigh",
};

const acpEffortLabel = (value: string): string =>
  ACP_EFFORT_LABELS[value] ?? value.charAt(0).toUpperCase() + value.slice(1);

/**
 * Maps a configured static model catalog to provider model descriptors. Used
 * when an agent does not advertise its catalog in-band through ACP config
 * options.
 */
export function parseConfiguredModelList(
  models: ReadonlyArray<AcpAgentModel> | undefined,
): ReadonlyArray<ProviderModelDescriptor> {
  const seen = new Set<string>();
  const result: ProviderModelDescriptor[] = [];
  for (const model of models ?? []) {
    const slug = model.slug.trim();
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const name = model.name?.trim() || slug;
    const efforts = (model.reasoningEfforts ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value !== "");
    result.push({
      slug,
      name,
      ...(efforts.length > 0
        ? {
            supportedReasoningEfforts: efforts.map((value) => ({
              value,
              label: acpEffortLabel(value),
            })),
          }
        : {}),
    });
  }
  return result;
}
