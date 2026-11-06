/**
 * Kiro ACP support - builds the `kiro-cli acp` stdio command, reports missing
 * sign-in, selects model/effort/agent in-session, and maps Kiro's advertised
 * model catalog.
 *
 * @module KiroAcpSupport
 */
import { type ProviderListModelsResult, type ProviderModelDescriptor } from "@synara/contracts";
import { Effect, Layer, Scope, ServiceMap } from "effect";
import type * as Acp from "@agentclientprotocol/sdk";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as AcpErrors from "./AcpErrors.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSessionRuntimeStartResult,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";
import {
  availableAuthMethodIds,
  buildAcpModelDescriptor,
  findSelectConfig,
  flattenConfigOptions,
} from "./AcpConfigOptions.ts";

export const KIRO_DEFAULT_BINARY = "kiro-cli";

const KIRO_MODEL_CONFIG_ID = "model";
// Kiro 3.0 advertises effort as `effortLevel` (category thought_level) once
// the selected model supports it.
const KIRO_EFFORT_CONFIG_ID = "effortLevel";
const KIRO_SIGN_IN_MESSAGE =
  "Kiro CLI is not signed in. Run `kiro-cli login` in a terminal, then start the session again.";

export interface KiroAcpRuntimeSettings {
  readonly binaryPath?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly instanceId?: string;
  readonly homeDir?: string;
  readonly isolationRootDir?: string;
}

export interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "authPolicy" | "resolveAuthMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kiroSettings: KiroAcpRuntimeSettings | null | undefined;
}

export function resolveKiroBinaryPath(binaryPath?: string | null): string {
  return binaryPath?.trim() || KIRO_DEFAULT_BINARY;
}

/**
 * Model and effort are deliberately not launch flags: with `kiro-cli` 3.0.0,
 * `acp --model` or `acp --effort` leaves `session/new` unanswered. Both are
 * selected through session config options after the session exists.
 */
export function buildKiroAcpSpawnInput(
  kiroSettings: KiroAcpRuntimeSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  return {
    command: resolveKiroBinaryPath(kiroSettings?.binaryPath),
    args: ["acp"],
    cwd,
    providerEnvironment: {
      driver: "kiro",
      ...(kiroSettings?.instanceId !== undefined ? { instanceId: kiroSettings.instanceId } : {}),
      ...(kiroSettings?.environment !== undefined ? { environment: kiroSettings.environment } : {}),
      ...(kiroSettings?.homeDir !== undefined ? { homeDir: kiroSettings.homeDir } : {}),
      ...(kiroSettings?.isolationRootDir !== undefined
        ? { isolationRootDir: kiroSettings.isolationRootDir }
        : {}),
    },
  };
}

/**
 * Kiro reads its own login from the CLI credential store, so Synara never
 * authenticates up front. This runs only after Kiro reports that a session
 * needs authentication, which a headless client cannot complete.
 */
export const resolveKiroAcpAuthMethodId = (
  initializeResult: Acp.InitializeResponse,
): Effect.Effect<string, AcpErrors.AcpError> =>
  Effect.fail(
    new AcpErrors.AcpRequestError({
      code: -32000,
      errorMessage: KIRO_SIGN_IN_MESSAGE,
      data: {
        authMethods: [...availableAuthMethodIds(initializeResult)],
        reason: "credentials_missing",
      },
    }),
  );

export const makeKiroAcpRuntime = (
  input: KiroAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const { kiroSettings, childProcessSpawner, ...runtimeOptions } = input;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        spawn: buildKiroAcpSpawnInput(kiroSettings, input.cwd),
        authPolicy: "on-demand",
        resolveAuthMethodId: resolveKiroAcpAuthMethodId,
      }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export interface KiroAdvertisedModel {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/**
 * Reads the pre-1.0 ACP `models` block (`availableModels` + `currentModelId`)
 * that Kiro documented before session config options existed. The typed SDK
 * no longer models it, so the session setup result is inspected defensively.
 */
export function readKiroLegacyModelState(
  sessionSetupResult: AcpSessionRuntimeStartResult["sessionSetupResult"],
):
  | { readonly currentModelId?: string; readonly models: ReadonlyArray<KiroAdvertisedModel> }
  | undefined {
  const raw = (sessionSetupResult as unknown as Record<string, unknown>).models;
  if (!isRecord(raw) || !Array.isArray(raw.availableModels)) {
    return undefined;
  }
  const models = raw.availableModels.flatMap((entry): KiroAdvertisedModel[] => {
    if (!isRecord(entry)) return [];
    const id = nonEmptyString(entry.modelId) ?? nonEmptyString(entry.id);
    if (!id) return [];
    const description = nonEmptyString(entry.description);
    return [
      {
        id,
        name: nonEmptyString(entry.name) ?? id,
        ...(description ? { description } : {}),
      },
    ];
  });
  const currentModelId = nonEmptyString(raw.currentModelId);
  return { ...(currentModelId ? { currentModelId } : {}), models };
}

function findKiroModelConfig(options: ReadonlyArray<Acp.SessionConfigOption>) {
  return findSelectConfig(options, { id: KIRO_MODEL_CONFIG_ID, category: "model" });
}

function findKiroEffortConfig(options: ReadonlyArray<Acp.SessionConfigOption>) {
  return findSelectConfig(options, { id: KIRO_EFFORT_CONFIG_ID, category: "thought_level" });
}

export type KiroModelSelectionOutcome =
  | { readonly _tag: "Applied"; readonly via: "config_option" | "set_model" }
  | { readonly _tag: "AlreadyCurrent" }
  | { readonly _tag: "NotAdvertised"; readonly advertised: ReadonlyArray<string> }
  | { readonly _tag: "NoModelControl" };

/**
 * Selects the requested model in a live session. Config options win because
 * they are the ACP 1.x mechanism; the legacy `session/set_model` request is a
 * fallback for Kiro builds that still advertise only the `models` block. A
 * model Kiro does not advertise is reported instead of being sent blindly.
 */
export function applyKiroAcpModelSelection(input: {
  readonly runtime: Pick<
    AcpSessionRuntimeShape,
    "getConfigOptions" | "setConfigOption" | "request"
  >;
  readonly started: Pick<AcpSessionRuntimeStartResult, "sessionId" | "sessionSetupResult">;
  readonly model: string;
}): Effect.Effect<KiroModelSelectionOutcome, AcpErrors.AcpError> {
  return Effect.gen(function* () {
    const model = input.model.trim();
    if (!model) {
      return { _tag: "AlreadyCurrent" } as const;
    }

    const modelConfig = findKiroModelConfig(yield* input.runtime.getConfigOptions);
    if (modelConfig) {
      const advertised = flattenConfigOptions(modelConfig.options).map((option) => option.value);
      if (modelConfig.currentValue === model) {
        return { _tag: "AlreadyCurrent" } as const;
      }
      if (!advertised.includes(model)) {
        return { _tag: "NotAdvertised", advertised } as const;
      }
      yield* input.runtime.setConfigOption(modelConfig.id, model);
      return { _tag: "Applied", via: "config_option" } as const;
    }

    const legacy = readKiroLegacyModelState(input.started.sessionSetupResult);
    if (!legacy || legacy.models.length === 0) {
      return { _tag: "NoModelControl" } as const;
    }
    if (legacy.currentModelId === model) {
      return { _tag: "AlreadyCurrent" } as const;
    }
    const advertised = legacy.models.map((entry) => entry.id);
    if (!advertised.includes(model)) {
      return { _tag: "NotAdvertised", advertised } as const;
    }
    yield* input.runtime.request("session/set_model", {
      sessionId: input.started.sessionId,
      modelId: model,
    });
    return { _tag: "Applied", via: "set_model" } as const;
  });
}

export type KiroEffortSelectionOutcome =
  | { readonly _tag: "Applied" }
  | { readonly _tag: "AlreadyCurrent" }
  | { readonly _tag: "NotAdvertised"; readonly advertised: ReadonlyArray<string> }
  | { readonly _tag: "NoEffortControl" };

/**
 * Selects the effort level after the model, because Kiro only advertises the
 * `effortLevel` option (with that model's ladder) for models that support it.
 */
export function applyKiroAcpEffortSelection(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "getConfigOptions" | "setConfigOption">;
  readonly reasoningEffort: string;
}): Effect.Effect<KiroEffortSelectionOutcome, AcpErrors.AcpError> {
  return Effect.gen(function* () {
    const reasoningEffort = input.reasoningEffort.trim();
    if (!reasoningEffort) {
      return { _tag: "AlreadyCurrent" } as const;
    }
    const effortConfig = findKiroEffortConfig(yield* input.runtime.getConfigOptions);
    if (!effortConfig) {
      return { _tag: "NoEffortControl" } as const;
    }
    if (effortConfig.currentValue === reasoningEffort) {
      return { _tag: "AlreadyCurrent" } as const;
    }
    const advertised = flattenConfigOptions(effortConfig.options).map((option) => option.value);
    if (!advertised.includes(reasoningEffort)) {
      return { _tag: "NotAdvertised", advertised } as const;
    }
    yield* input.runtime.setConfigOption(effortConfig.id, reasoningEffort);
    return { _tag: "Applied" } as const;
  });
}

/**
 * Switches the Kiro agent (an ACP mode). The shared runtime only switches
 * modes through a `mode` session config option, so Kiro builds that expose
 * modes solely through the standard `modes` block get `session/set_mode`.
 */
export function applyKiroAcpSessionMode(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "getConfigOptions" | "setMode" | "request">;
  readonly sessionId: string;
  readonly modeId: string;
}): Effect.Effect<"config_option" | "set_mode", AcpErrors.AcpError> {
  return Effect.gen(function* () {
    const options = yield* input.runtime.getConfigOptions;
    const modeConfig = options.find(
      (option) => option.type === "select" && (option.category === "mode" || option.id === "mode"),
    );
    if (modeConfig) {
      yield* input.runtime.setMode(input.modeId);
      return "config_option" as const;
    }
    yield* input.runtime.request("session/set_mode", {
      sessionId: input.sessionId,
      modeId: input.modeId,
    });
    return "set_mode" as const;
  });
}

const KIRO_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/**
 * Kiro does not expose effort as a session config option; each model option
 * carries its own ladder in `_meta.kiro` (`hasEffort`, `effortLevels`,
 * `defaultEffortLevel`). This rebuilds it as the select option the shared
 * descriptor builder understands.
 */
export function readKiroModelEffortOption(
  model: Acp.SessionConfigSelectOption,
): Extract<Acp.SessionConfigOption, { readonly type: "select" }> | undefined {
  const meta = isRecord(model._meta) && isRecord(model._meta.kiro) ? model._meta.kiro : undefined;
  if (meta?.hasEffort !== true || !Array.isArray(meta.effortLevels)) return undefined;
  const levels = meta.effortLevels.flatMap((level) => {
    const value = nonEmptyString(level);
    return value ? [value] : [];
  });
  if (levels.length === 0) return undefined;
  const defaultLevel = nonEmptyString(meta.defaultEffortLevel);
  return {
    id: KIRO_EFFORT_CONFIG_ID,
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: defaultLevel && levels.includes(defaultLevel) ? defaultLevel : levels[0]!,
    options: levels.map((value) => ({ value, name: KIRO_EFFORT_LABELS[value] ?? value })),
  };
}

/** Builds the model catalog from a disposable discovery session. */
export function discoverKiroAcpModels(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "getConfigOptions">;
  readonly started: Pick<AcpSessionRuntimeStartResult, "sessionSetupResult">;
}): Effect.Effect<ProviderListModelsResult, AcpErrors.AcpError> {
  return Effect.gen(function* () {
    const options = yield* input.runtime.getConfigOptions;
    const modelConfig = findKiroModelConfig(options);
    if (modelConfig) {
      const sessionEffortConfig = findKiroEffortConfig(options);
      return {
        models: flattenConfigOptions(modelConfig.options).map((model) => {
          const effortOption = readKiroModelEffortOption(model) ?? sessionEffortConfig;
          const descriptor: {
            -readonly [K in keyof ProviderModelDescriptor]: ProviderModelDescriptor[K];
          } = buildAcpModelDescriptor(model, effortOption);
          if (effortOption?.currentValue) {
            descriptor.defaultReasoningEffort = effortOption.currentValue;
          }
          return descriptor;
        }),
        source: "kiro-acp",
        cached: false,
      } satisfies ProviderListModelsResult;
    }

    const legacy = readKiroLegacyModelState(input.started.sessionSetupResult);
    if (legacy && legacy.models.length > 0) {
      return {
        models: legacy.models.map(
          (model): ProviderModelDescriptor =>
            model.description
              ? {
                  slug: model.id,
                  name: model.name,
                  description: model.description,
                  supportsFastMode: false,
                  supportsThinkingToggle: false,
                }
              : {
                  slug: model.id,
                  name: model.name,
                  supportsFastMode: false,
                  supportsThinkingToggle: false,
                },
        ),
        source: "kiro-acp",
        cached: false,
      } satisfies ProviderListModelsResult;
    }

    return yield* new AcpErrors.AcpRequestError({
      code: -32602,
      errorMessage: "Kiro ACP did not advertise a model list.",
    });
  });
}
