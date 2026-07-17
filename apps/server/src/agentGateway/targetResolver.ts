import {
  CLAUDE_CODE_EFFORT_OPTIONS,
  CODEX_REASONING_EFFORT_OPTIONS,
  DEFAULT_MODEL_BY_PROVIDER,
  DROID_REASONING_EFFORT_OPTIONS,
  GROK_REASONING_EFFORT_OPTIONS,
  PI_THINKING_LEVEL_OPTIONS,
  type ModelSelection,
  type ProviderKind,
  type ProviderListModelsResult,
  type ProviderModelDescriptor,
  type ServerProviderAuthStatus,
} from "@synara/contracts";
import { Effect } from "effect";

import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";

export type AgentGatewayTargetErrorCode =
  | "provider_unavailable"
  | "model_unavailable"
  | "model_option_unavailable";

export class AgentGatewayTargetError extends Error {
  readonly code: AgentGatewayTargetErrorCode;
  readonly details?: unknown;

  constructor(code: AgentGatewayTargetErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AgentGatewayTargetError";
    this.code = code;
    this.details = details;
  }
}

export interface AgentGatewayProviderCatalog {
  readonly provider: ProviderKind;
  readonly defaultModel: string | null;
  readonly models: ReadonlyArray<ProviderModelDescriptor>;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly authStatus?: ServerProviderAuthStatus;
  readonly source?: string;
  readonly error?: string;
}

export interface AgentGatewayProviderAvailability {
  readonly enabled: boolean;
  /** Undefined means health has not produced a trustworthy snapshot yet. */
  readonly available?: boolean;
  readonly authStatus?: ServerProviderAuthStatus;
  readonly message?: string;
}

export const AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION =
  "Provider-specific target options. Use targetConstruction[provider].optionsByModel[model] when present; otherwise use providerOptions. Preserve each option's exact key, valueType, and allowedValues.";

export type AgentGatewayTargetOptionValue = string | number | boolean;

export interface AgentGatewayTargetOptionRule {
  readonly key: string;
  readonly valueType: "string" | "number" | "boolean";
  readonly allowedValues: ReadonlyArray<AgentGatewayTargetOptionValue>;
  readonly allowedValuesSource: "provider-contract" | "model-discovery";
}

export interface AgentGatewayTargetOptionGuidance {
  readonly primaryOptionKey: string;
  readonly alternativeOptionKeys: ReadonlyArray<string>;
  readonly optionSelectionRule: string;
  readonly providerOptions: ReadonlyArray<AgentGatewayTargetOptionRule>;
  readonly optionsByModel: Readonly<Record<string, ReadonlyArray<AgentGatewayTargetOptionRule>>>;
  readonly exampleTarget: {
    readonly provider: ProviderKind;
    readonly model: string;
    readonly options: Readonly<Record<string, AgentGatewayTargetOptionValue>>;
  } | null;
}

interface ProviderTargetOptionConfig {
  readonly primaryOptionKey: string;
  readonly options: ReadonlyArray<AgentGatewayTargetOptionRule>;
}

function providerOptionRule(
  key: string,
  valueType: AgentGatewayTargetOptionRule["valueType"],
  allowedValues: ReadonlyArray<AgentGatewayTargetOptionValue>,
  allowedValuesSource: AgentGatewayTargetOptionRule["allowedValuesSource"] = "provider-contract",
): AgentGatewayTargetOptionRule {
  return { key, valueType, allowedValues, allowedValuesSource };
}

function reasoningEffortOptionConfig(
  allowedValues: ReadonlyArray<string>,
): ProviderTargetOptionConfig {
  return {
    primaryOptionKey: "reasoningEffort",
    options: [providerOptionRule("reasoningEffort", "string", allowedValues)],
  };
}

function dynamicVariantOptionConfig(): ProviderTargetOptionConfig {
  return {
    primaryOptionKey: "variant",
    options: [
      providerOptionRule("variant", "string", [], "model-discovery"),
      providerOptionRule("agent", "string", [], "model-discovery"),
    ],
  };
}

const PROVIDER_TARGET_OPTION_CONFIG = {
  codex: reasoningEffortOptionConfig(CODEX_REASONING_EFFORT_OPTIONS),
  cursor: reasoningEffortOptionConfig(CODEX_REASONING_EFFORT_OPTIONS),
  grok: reasoningEffortOptionConfig(GROK_REASONING_EFFORT_OPTIONS),
  droid: reasoningEffortOptionConfig(DROID_REASONING_EFFORT_OPTIONS),
  claudeAgent: {
    primaryOptionKey: "effort",
    options: [providerOptionRule("effort", "string", CLAUDE_CODE_EFFORT_OPTIONS)],
  },
  pi: {
    primaryOptionKey: "thinkingLevel",
    options: [providerOptionRule("thinkingLevel", "string", PI_THINKING_LEVEL_OPTIONS)],
  },
  antigravity: {
    primaryOptionKey: "reasoningEffort",
    options: [providerOptionRule("reasoningEffort", "string", [], "model-discovery")],
  },
  kilo: dynamicVariantOptionConfig(),
  opencode: dynamicVariantOptionConfig(),
} as const satisfies Record<ProviderKind, ProviderTargetOptionConfig>;

function providerDefaultModel(provider: ProviderKind): string | null {
  return provider === "pi" ? null : DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function loadAgentGatewayProviderCatalog(input: {
  readonly provider: ProviderKind;
  readonly discovery: ProviderDiscoveryServiceShape;
  readonly availability?: AgentGatewayProviderAvailability;
  readonly cwd?: string;
}): Effect.Effect<AgentGatewayProviderCatalog> {
  const defaultModel = providerDefaultModel(input.provider);
  const availability = input.availability ?? { enabled: true };
  const unavailableReason =
    availability.enabled === false
      ? `Provider "${input.provider}" is disabled in Synara settings.`
      : availability.available === false
        ? (availability.message ?? `Provider "${input.provider}" is not available.`)
        : availability.authStatus === "unauthenticated"
          ? (availability.message ?? `Provider "${input.provider}" is not authenticated.`)
          : null;
  if (unavailableReason !== null) {
    return Effect.succeed({
      provider: input.provider,
      defaultModel,
      models: [],
      enabled: availability.enabled,
      available: false,
      ...(availability.authStatus ? { authStatus: availability.authStatus } : {}),
      error: unavailableReason,
    });
  }
  return input.discovery
    .listModels({ provider: input.provider, ...(input.cwd ? { cwd: input.cwd } : {}) })
    .pipe(
      Effect.map((result: ProviderListModelsResult) => ({
        provider: input.provider,
        defaultModel,
        models: result.models,
        enabled: true,
        available: result.models.length > 0 || defaultModel !== null,
        ...(availability.authStatus ? { authStatus: availability.authStatus } : {}),
        ...(result.source ? { source: result.source } : {}),
      })),
      Effect.catch((error) =>
        Effect.succeed({
          provider: input.provider,
          defaultModel,
          models: [],
          enabled: true,
          available: defaultModel !== null,
          ...(availability.authStatus ? { authStatus: availability.authStatus } : {}),
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
}

function selectedReasoningEffort(target: ModelSelection): string | undefined {
  const config = PROVIDER_TARGET_OPTION_CONFIG[target.provider];
  const optionKeys = [config.primaryOptionKey];
  const rawOptions = target.options as Record<string, unknown> | undefined;
  for (const optionKey of optionKeys) {
    const value = rawOptions?.[optionKey];
    if (typeof value === "number") return String(value);
    if (typeof value === "string") return value;
  }
  return undefined;
}

function staticEffortsForProvider(provider: ProviderKind): ReadonlyArray<string> {
  const config = PROVIDER_TARGET_OPTION_CONFIG[provider];
  return config.options.flatMap((option) => option.allowedValues.map(String));
}

function providerTargetOptionRules(
  provider: ProviderKind,
): ReadonlyArray<AgentGatewayTargetOptionRule> {
  return PROVIDER_TARGET_OPTION_CONFIG[provider].options;
}

function providerPrimaryOptionKey(provider: ProviderKind): string {
  return PROVIDER_TARGET_OPTION_CONFIG[provider].primaryOptionKey;
}

function convertDiscoveredOptionValue(
  value: string,
  valueType: AgentGatewayTargetOptionRule["valueType"],
): AgentGatewayTargetOptionValue | null {
  if (valueType === "string") return value;
  if (valueType === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function modelTargetOptionRules(
  provider: ProviderKind,
  model: ProviderModelDescriptor,
): ReadonlyArray<AgentGatewayTargetOptionRule> {
  const rules = providerTargetOptionRules(provider).map((rule) => ({ ...rule }));
  const replaceAllowedValues = (
    key: string,
    values: ReadonlyArray<AgentGatewayTargetOptionValue>,
    allowEmpty = false,
  ) => {
    if (values.length === 0 && !allowEmpty) return;
    const index = rules.findIndex((rule) => rule.key === key);
    if (index < 0) return;
    rules[index] = {
      ...rules[index]!,
      allowedValues: values,
      allowedValuesSource: "model-discovery",
    };
  };

  const discoveredEfforts = model.supportedReasoningEfforts?.map((entry) => entry.value) ?? [];
  replaceAllowedValues(providerPrimaryOptionKey(provider), discoveredEfforts);

  for (const descriptor of model.optionDescriptors ?? []) {
    const rule = rules.find((candidate) => candidate.key === descriptor.id);
    if (!rule) continue;
    if (descriptor.type === "select") {
      replaceAllowedValues(
        descriptor.id,
        descriptor.options
          .map((option) => convertDiscoveredOptionValue(option.id, rule.valueType))
          .filter((value): value is AgentGatewayTargetOptionValue => value !== null),
        true,
      );
    } else if (descriptor.type === "boolean") {
      replaceAllowedValues(descriptor.id, [true, false]);
    }
  }
  return rules;
}

function preferredExampleOptionValue(
  rule: AgentGatewayTargetOptionRule,
): AgentGatewayTargetOptionValue | null {
  const preferences: ReadonlyArray<AgentGatewayTargetOptionValue> =
    rule.key === "reasoningEffort"
      ? ["medium", "low"]
      : rule.key === "thinkingLevel"
        ? ["LOW", "low"]
        : ["low"];
  return (
    preferences.find((value) => rule.allowedValues.includes(value)) ?? rule.allowedValues[0] ?? null
  );
}

function exampleOptionsForRules(
  primaryOptionKey: string,
  rules: ReadonlyArray<AgentGatewayTargetOptionRule>,
): Readonly<Record<string, AgentGatewayTargetOptionValue>> {
  const primaryRule = rules.find((rule) => rule.key === primaryOptionKey);
  const exampleRule =
    primaryRule && primaryRule.allowedValues.length > 0
      ? primaryRule
      : rules.find((rule) => rule.allowedValues.length > 0);
  if (!exampleRule) return {};
  const value = preferredExampleOptionValue(exampleRule);
  return value === null ? {} : { [exampleRule.key]: value };
}

/** Compact, typed construction guidance returned before the full model catalog. */
export function agentGatewayTargetOptionGuidance(
  catalog: AgentGatewayProviderCatalog,
): AgentGatewayTargetOptionGuidance {
  const primaryOptionKey = providerPrimaryOptionKey(catalog.provider);
  const providerOptions = providerTargetOptionRules(catalog.provider);
  const optionsByModel = Object.fromEntries(
    catalog.models.map((model) => [model.slug, modelTargetOptionRules(catalog.provider, model)]),
  );
  const exampleModel = catalog.models[0]?.slug ?? catalog.defaultModel;
  const exampleRules = exampleModel
    ? (optionsByModel[exampleModel] ?? providerOptions)
    : providerOptions;
  return {
    primaryOptionKey,
    alternativeOptionKeys: providerOptions
      .map((rule) => rule.key)
      .filter((key) => key !== primaryOptionKey),
    optionSelectionRule:
      "Use optionsByModel[model] when present. Its keys, valueType, and allowedValues are authoritative; otherwise use providerOptions.",
    providerOptions,
    optionsByModel,
    exampleTarget:
      catalog.available && exampleModel
        ? {
            provider: catalog.provider,
            model: exampleModel,
            options: exampleOptionsForRules(primaryOptionKey, exampleRules),
          }
        : null,
  };
}

function failUnavailableOption(
  target: ModelSelection,
  option: string,
  available?: ReadonlyArray<string>,
): never {
  throw new AgentGatewayTargetError(
    "model_option_unavailable",
    `Option "${option}" is not available for ${target.provider}/${target.model}.${
      available && available.length > 0 ? ` Available values: ${available.join(", ")}.` : ""
    }`,
    { provider: target.provider, model: target.model, option, available: available ?? [] },
  );
}

function validateOptionsWithoutCatalog(target: ModelSelection): void {
  const effort = selectedReasoningEffort(target);
  if (effort !== undefined) {
    const available = staticEffortsForProvider(target.provider);
    if (!available.includes(effort)) {
      failUnavailableOption(target, effort, available);
    }
  }
  if (
    (target.provider === "codex" ||
      target.provider === "cursor" ||
      target.provider === "claudeAgent") &&
    target.options?.fastMode === true
  ) {
    failUnavailableOption(target, "fastMode");
  }
  if (
    (target.provider === "cursor" || target.provider === "claudeAgent") &&
    target.options?.thinking === true
  ) {
    failUnavailableOption(target, "thinking");
  }
  if (
    (target.provider === "kilo" || target.provider === "opencode") &&
    target.options !== undefined &&
    (target.options.variant !== undefined || target.options.agent !== undefined)
  ) {
    failUnavailableOption(target, target.options.variant ?? target.options.agent ?? "options");
  }
  const rawOptions = target.options as Record<string, unknown> | undefined;
  for (const optionId of ["contextWindow", "autoCompactWindow"]) {
    if (rawOptions?.[optionId] !== undefined) {
      failUnavailableOption(target, optionId);
    }
  }
}

function validateAdvertisedOption(
  target: ModelSelection,
  descriptor: ProviderModelDescriptor,
): void {
  const effort = selectedReasoningEffort(target);

  const requestedFastMode =
    target.provider === "codex" || target.provider === "cursor" || target.provider === "claudeAgent"
      ? target.options?.fastMode
      : undefined;
  if (requestedFastMode === true && descriptor.supportsFastMode !== true) {
    throw new AgentGatewayTargetError(
      "model_option_unavailable",
      `Fast mode is not available for ${target.provider}/${target.model}.`,
      { provider: target.provider, model: target.model, option: "fastMode" },
    );
  }
  if (
    (target.provider === "cursor" || target.provider === "claudeAgent") &&
    target.options?.thinking === true &&
    descriptor.supportsThinkingToggle !== true
  ) {
    throw new AgentGatewayTargetError(
      "model_option_unavailable",
      `The thinking toggle is not available for ${target.provider}/${target.model}.`,
      { provider: target.provider, model: target.model, option: "thinking" },
    );
  }
  const rawOptions = target.options as Record<string, unknown> | undefined;
  for (const [optionId, value] of Object.entries(rawOptions ?? {})) {
    if (value === undefined) continue;
    if (
      optionId === "reasoningEffort" ||
      optionId === "effort" ||
      optionId === "thinkingLevel" ||
      optionId === "thinkingBudget" ||
      optionId === "variant" ||
      optionId === "fastMode" ||
      optionId === "thinking"
    ) {
      continue;
    }
    if (optionId === "contextWindow" || optionId === "autoCompactWindow") {
      const available = descriptor.contextWindowOptions?.map((entry) => entry.value) ?? [];
      if (available.includes(String(value))) continue;
    }
    const advertised = descriptor.optionDescriptors?.find((option) => option.id === optionId);
    if (advertised?.type === "select") {
      const available = advertised.options.map((entry) => entry.id);
      if (available.includes(String(value))) continue;
      failUnavailableOption(target, String(value), available);
    }
    if (advertised?.type === "boolean" && typeof value === "boolean") continue;
    failUnavailableOption(target, optionId);
  }
  if (effort === undefined) return;

  const advertisedEfforts = descriptor.supportedReasoningEfforts?.map((entry) => entry.value);
  if (advertisedEfforts && advertisedEfforts.length > 0 && !advertisedEfforts.includes(effort)) {
    throw new AgentGatewayTargetError(
      "model_option_unavailable",
      `Option "${effort}" is not available for ${target.provider}/${target.model}. Available values: ${advertisedEfforts.join(", ")}.`,
      {
        provider: target.provider,
        model: target.model,
        option: effort,
        available: advertisedEfforts,
      },
    );
  }

  for (const option of descriptor.optionDescriptors ?? []) {
    if (option.type !== "select") continue;
    const optionMatches =
      option.id === "reasoningEffort" ||
      option.id === "effort" ||
      option.id === "thinkingLevel" ||
      option.id === "thinkingBudget" ||
      option.id === "variant";
    if (!optionMatches) continue;
    const available = option.options.map((entry) => entry.id);
    if (!available.includes(effort)) {
      throw new AgentGatewayTargetError(
        "model_option_unavailable",
        `Option "${effort}" is not available for ${target.provider}/${target.model}. Available values: ${available.join(", ")}.`,
        { provider: target.provider, model: target.model, option: effort, available },
      );
    }
  }
  const hasAdvertisedEffort =
    (advertisedEfforts?.length ?? 0) > 0 ||
    (descriptor.optionDescriptors ?? []).some(
      (option) =>
        option.type === "select" &&
        (option.id === "reasoningEffort" ||
          option.id === "effort" ||
          option.id === "thinkingLevel" ||
          option.id === "thinkingBudget" ||
          option.id === "variant"),
    );
  if (!hasAdvertisedEffort) {
    const available = staticEffortsForProvider(target.provider);
    if (!available.includes(effort)) {
      failUnavailableOption(target, effort, available);
    }
  }
}

/** Resolve an exact advertised target before any git/orchestration side effect. */
export function resolveAgentGatewayTarget(input: {
  readonly target: ModelSelection;
  readonly discovery: ProviderDiscoveryServiceShape;
  readonly availability?: AgentGatewayProviderAvailability;
  readonly cwd?: string;
}): Effect.Effect<ModelSelection, AgentGatewayTargetError> {
  return Effect.gen(function* () {
    const catalog = yield* loadAgentGatewayProviderCatalog({
      provider: input.target.provider,
      discovery: input.discovery,
      ...(input.availability ? { availability: input.availability } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    });
    if (!catalog.available) {
      return yield* Effect.fail(
        new AgentGatewayTargetError(
          "provider_unavailable",
          catalog.error ?? `Provider "${input.target.provider}" is unavailable.`,
          {
            provider: input.target.provider,
            enabled: catalog.enabled,
            authStatus: catalog.authStatus,
          },
        ),
      );
    }
    const descriptor = catalog.models.find((model) => model.slug === input.target.model);

    if (catalog.models.length > 0 && descriptor === undefined) {
      return yield* Effect.fail(
        new AgentGatewayTargetError(
          "model_unavailable",
          `Model "${input.target.model}" is not available for ${input.target.provider}. Use an exact slug from synara_capabilities.`,
          {
            provider: input.target.provider,
            requestedModel: input.target.model,
            availableModels: catalog.models.map((model) => model.slug),
          },
        ),
      );
    }

    if (catalog.models.length === 0) {
      if (catalog.defaultModel === null) {
        return yield* Effect.fail(
          new AgentGatewayTargetError(
            "provider_unavailable",
            `Provider "${input.target.provider}" has no available model catalog or configured default.`,
            { provider: input.target.provider, discoveryError: catalog.error },
          ),
        );
      }
      if (input.target.model !== catalog.defaultModel) {
        return yield* Effect.fail(
          new AgentGatewayTargetError(
            "model_unavailable",
            `The ${input.target.provider} model catalog is unavailable. Only its configured default "${catalog.defaultModel}" can be used safely; custom model "${input.target.model}" was not verified.`,
            { provider: input.target.provider, requestedModel: input.target.model },
          ),
        );
      }
      try {
        validateOptionsWithoutCatalog(input.target);
      } catch (error) {
        if (error instanceof AgentGatewayTargetError) return yield* Effect.fail(error);
        throw error;
      }
      return input.target;
    }

    try {
      validateAdvertisedOption(input.target, descriptor!);
    } catch (error) {
      if (error instanceof AgentGatewayTargetError) return yield* Effect.fail(error);
      throw error;
    }
    return input.target;
  });
}
