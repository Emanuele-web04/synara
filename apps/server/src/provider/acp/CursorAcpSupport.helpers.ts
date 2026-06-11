/**
 * CursorAcpSupport.helpers - config-option and model-descriptor logic.
 *
 * Purpose: flatten ACP session config options into Cursor model choices,
 * build provider model descriptors, and resolve the ACP model value/config
 * updates for a requested model + options. No Effect/IO; pure transforms over
 * ACP schema objects.
 * Layer: pure functions over EffectAcpSchema.SessionConfigOption[] and
 *   CursorAcpModelChoice[], built on CursorAcpSupport.parsing.
 * Exports: choice flatteners, descriptor builders, config-value mapping,
 *   parameter resolution, and resolveCursorAcpModelValue /
 *   collectCursorAcpConfigUpdates / normalizeCursorAcpRuntimeOptions.
 *
 * @module CursorAcpSupport.helpers
 */
import { type CursorModelOptions, type ProviderModelDescriptor } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { CursorAcpModelChoice, CursorAcpSelectOption } from "./CursorAcpSupport.types.ts";
import {
  buildCursorParameterizedModelSlug,
  cursorAcpParameterKeyForModel,
  cursorContextLabel,
  cursorModelChoiceSupportsRequestedParameters,
  cursorModelOptionsFromCliModelId,
  cursorModelParametersEqualExceptFast,
  cursorModelParametersToObject,
  cursorReasoningLabel,
  cursorReasoningParameterValue,
  inferCursorUpstreamProvider,
  normalizeCursorAcpModelName,
  normalizeCursorCliBaseModelId,
  normalizeCursorReasoningValue,
  normalizedText,
  parseCursorModelParameters,
  resolveCursorAcpBaseModelId,
  stripCursorParameterizedSuffix,
} from "./CursorAcpSupport.parsing.ts";

function flattenSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<CursorAcpSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value.trim(), name: entry.name.trim() }]
      : entry.options.map((option) => ({
          value: option.value.trim(),
          name: option.name.trim(),
          ...("group" in entry && typeof entry.group === "string" && entry.group.trim().length > 0
            ? { groupId: entry.group.trim() }
            : {}),
          ...("name" in entry && typeof entry.name === "string" && entry.name.trim().length > 0
            ? { groupName: entry.name.trim() }
            : {}),
        })),
  );
}

function findCursorModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find((option) => option.category === "model");
}

function findConfigOption(
  options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  aliases: ReadonlyArray<string>,
): EffectAcpSchema.SessionConfigOption | undefined {
  const normalizedAliases = aliases.map(normalizedText);
  return options.find((option) => {
    const haystack = normalizedText(`${option.id} ${option.name} ${option.category ?? ""}`);
    return normalizedAliases.some((alias) => haystack.includes(alias));
  });
}

export function flattenCursorAcpModelChoices(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<CursorAcpModelChoice> {
  const seen = new Set<string>();
  const choices: Array<CursorAcpModelChoice> = [];
  for (const choice of flattenSessionConfigSelectOptions(
    findCursorModelConfigOption(configOptions),
  )) {
    if (!choice.value || seen.has(choice.value)) {
      continue;
    }
    seen.add(choice.value);
    const upstreamProvider = inferCursorUpstreamProvider(choice);
    choices.push({
      slug: choice.value,
      name: normalizeCursorAcpModelName(choice),
      ...upstreamProvider,
    });
  }
  return choices;
}

export function parseCursorCliModelList(stdout: string): ReadonlyArray<ProviderModelDescriptor> {
  const seen = new Set<string>();
  const models: Array<ProviderModelDescriptor> = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "Available models" || trimmed.startsWith("Tip:")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(" - ");
    if (separatorIndex <= 0) {
      continue;
    }
    const slug = trimmed.slice(0, separatorIndex).trim();
    const rawName = trimmed.slice(separatorIndex + 3).trim();
    if (!slug || !rawName || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const name = rawName.replace(/\s+\((?:default|current)\)$/iu, "").trim() || rawName;
    const upstreamProvider = inferCursorUpstreamProvider({ value: slug, name });
    const options = cursorModelOptionsFromCliModelId(slug);
    models.push({
      slug,
      name,
      ...upstreamProvider,
      ...(options.fastMode === true ? { supportsFastMode: true } : {}),
      ...(options.thinking === true ? { supportsThinkingToggle: true } : {}),
      ...(options.reasoningEffort
        ? {
            supportedReasoningEfforts: [
              {
                value: options.reasoningEffort,
                label: cursorReasoningLabel(options.reasoningEffort),
              },
            ],
            defaultReasoningEffort: options.reasoningEffort,
          }
        : {}),
      ...(options.contextWindow
        ? {
            contextWindowOptions: [
              {
                value: options.contextWindow,
                label: options.contextWindow === "1m" ? "1M" : options.contextWindow.toUpperCase(),
                isDefault: true as const,
              },
            ],
            defaultContextWindow: options.contextWindow,
          }
        : {}),
    });
  }
  return models;
}

function buildCursorParameterizedModelFromCliModelId(input: {
  readonly acpModelValue: string;
  readonly cliModel: string;
  readonly choices: ReadonlyArray<CursorAcpModelChoice>;
}): string | undefined {
  if (!input.acpModelValue.includes("[")) {
    return undefined;
  }
  const cliOptions = cursorModelOptionsFromCliModelId(input.cliModel);
  if (Object.keys(cliOptions).length === 0) {
    return undefined;
  }

  const baseModel = stripCursorParameterizedSuffix(input.acpModelValue);
  const params = cursorModelParametersToObject(input.acpModelValue);
  if (cliOptions.reasoningEffort) {
    const parameterKey = cursorAcpParameterKeyForModel(baseModel, cliOptions);
    params[parameterKey] =
      resolveCursorChoiceParameterValue({
        choices: input.choices,
        baseModel,
        key: parameterKey,
        requestedValue: cliOptions.reasoningEffort,
      }) ?? cursorReasoningParameterValue(cliOptions.reasoningEffort);
  }
  if (cliOptions.contextWindow) {
    params.context = cliOptions.contextWindow;
  }
  if (cliOptions.fastMode !== undefined) {
    params.fast = String(cliOptions.fastMode);
  }
  if (cliOptions.thinking !== undefined) {
    params.thinking = String(cliOptions.thinking);
  }
  return buildCursorParameterizedModelSlug(baseModel, params);
}

function buildCursorParameterizedModelFromOptions(input: {
  readonly acpModelValue: string;
  readonly options: CursorModelOptions | null | undefined;
  readonly choices: ReadonlyArray<CursorAcpModelChoice>;
}): string | undefined {
  if (!input.acpModelValue.includes("[")) {
    return undefined;
  }
  if (!input.options || Object.keys(input.options).length === 0) {
    return undefined;
  }

  const baseModel = stripCursorParameterizedSuffix(input.acpModelValue);
  const params = cursorModelParametersToObject(input.acpModelValue);
  if (input.options.reasoningEffort) {
    const parameterKey = cursorAcpParameterKeyForModel(baseModel, input.options);
    params[parameterKey] =
      resolveCursorChoiceParameterValue({
        choices: input.choices,
        baseModel,
        key: parameterKey,
        requestedValue: input.options.reasoningEffort,
      }) ?? cursorReasoningParameterValue(input.options.reasoningEffort);
  }
  if (input.options.contextWindow) {
    params.context = input.options.contextWindow;
  }
  if (input.options.fastMode !== undefined) {
    params.fast = String(input.options.fastMode);
  }
  if (input.options.thinking !== undefined) {
    params.thinking = String(input.options.thinking);
  }
  return buildCursorParameterizedModelSlug(baseModel, params);
}

function isCursorEffortConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return (
    id === "effort" ||
    id === "reasoning" ||
    name === "effort" ||
    name === "reasoning" ||
    name.includes("effort") ||
    name.includes("reasoning")
  );
}

function findCursorEffortConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  const candidates = configOptions.filter(
    (option) => option.type === "select" && isCursorEffortConfigOption(option),
  );
  return (
    candidates.find((option) => option.category === "model_option") ??
    candidates.find((option) => option.id.trim().toLowerCase() === "effort") ??
    candidates.find((option) => option.category === "thought_level") ??
    candidates[0]
  );
}

function isCursorContextConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "context" || id === "context_size" || name.includes("context");
}

function withCursorVariantName(
  baseName: string,
  effort: string | undefined,
  defaultEffort: string | undefined,
  contextWindow: string | undefined,
  defaultContextWindow: string | undefined,
  contextWindowOptions: NonNullable<ProviderModelDescriptor["contextWindowOptions"]>,
  fastMode: boolean | undefined,
): string {
  const suffixes: Array<string> = [];
  if (effort && effort !== defaultEffort) {
    suffixes.push(cursorReasoningLabel(effort));
  }
  if (contextWindow && contextWindow !== defaultContextWindow) {
    suffixes.push(cursorContextLabel(contextWindow, contextWindowOptions));
  }
  if (fastMode) {
    suffixes.push("Fast");
  }
  return suffixes.length === 0 ? baseName : `${baseName} ${suffixes.join(" ")}`;
}

function buildCursorAcpModelDescriptor(input: {
  readonly choice: CursorAcpModelChoice;
  readonly slug: string;
  readonly name: string;
  readonly supportedReasoningEfforts: NonNullable<
    ProviderModelDescriptor["supportedReasoningEfforts"]
  >;
  readonly defaultReasoningEffort?: string;
  readonly contextWindowOptions: NonNullable<ProviderModelDescriptor["contextWindowOptions"]>;
  readonly defaultContextWindow?: string;
}): ProviderModelDescriptor {
  return {
    slug: input.slug,
    name: input.name,
    ...(input.choice.upstreamProviderId
      ? { upstreamProviderId: input.choice.upstreamProviderId }
      : {}),
    ...(input.choice.upstreamProviderName
      ? { upstreamProviderName: input.choice.upstreamProviderName }
      : {}),
    ...(input.supportedReasoningEfforts.length > 0 && input.defaultReasoningEffort
      ? {
          supportedReasoningEfforts: input.supportedReasoningEfforts,
          defaultReasoningEffort: input.defaultReasoningEffort,
        }
      : {}),
    ...(input.contextWindowOptions.length > 0 && input.defaultContextWindow
      ? {
          contextWindowOptions: input.contextWindowOptions.map((option) => ({
            value: option.value,
            label: option.label,
            ...(option.value === input.defaultContextWindow ? { isDefault: true as const } : {}),
          })),
          defaultContextWindow: input.defaultContextWindow,
        }
      : {}),
  };
}

function expandCursorParameterizedModelDescriptors(input: {
  readonly choice: CursorAcpModelChoice;
  readonly supportedReasoningEfforts: NonNullable<
    ProviderModelDescriptor["supportedReasoningEfforts"]
  >;
  readonly defaultReasoningEffort?: string;
  readonly contextWindowOptions: NonNullable<ProviderModelDescriptor["contextWindowOptions"]>;
  readonly defaultContextWindow?: string;
}): ReadonlyArray<ProviderModelDescriptor> {
  const params = cursorModelParametersToObject(input.choice.slug);
  const reasoningKey =
    params.reasoning !== undefined ? "reasoning" : params.effort !== undefined ? "effort" : null;
  const parameterReasoningEffort = normalizeCursorReasoningValue(
    reasoningKey ? params[reasoningKey] : undefined,
  );
  const parameterContextWindow = params.context;
  const hasFastParameter = params.fast !== undefined;
  const canExpandReasoning = Boolean(reasoningKey && input.supportedReasoningEfforts.length > 0);
  const canExpandContext = Boolean(parameterContextWindow && input.contextWindowOptions.length > 1);
  const canExpandFast = hasFastParameter;

  if (!canExpandReasoning && !canExpandContext && !canExpandFast) {
    return [
      buildCursorAcpModelDescriptor({
        choice: input.choice,
        slug: input.choice.slug,
        name: input.choice.name,
        supportedReasoningEfforts: input.supportedReasoningEfforts,
        ...(parameterReasoningEffort ? { defaultReasoningEffort: parameterReasoningEffort } : {}),
        contextWindowOptions: input.contextWindowOptions,
        ...(parameterContextWindow ? { defaultContextWindow: parameterContextWindow } : {}),
      }),
    ];
  }

  const baseModel = stripCursorParameterizedSuffix(input.choice.slug);
  const reasoningValues = canExpandReasoning
    ? input.supportedReasoningEfforts.map((effort) => effort.value)
    : [parameterReasoningEffort].filter((value): value is string => Boolean(value));
  const contextValues = canExpandContext
    ? input.contextWindowOptions.map((contextWindow) => contextWindow.value)
    : [parameterContextWindow].filter((value): value is string => Boolean(value));
  const fastValues = canExpandFast ? [false, true] : [undefined];
  const variantDefaultEffort = parameterReasoningEffort ?? input.defaultReasoningEffort;
  const variantDefaultContextWindow = parameterContextWindow ?? input.defaultContextWindow;
  const descriptors: Array<ProviderModelDescriptor> = [];
  const seen = new Set<string>();

  for (const effort of reasoningValues.length > 0 ? reasoningValues : [undefined]) {
    for (const contextWindow of contextValues.length > 0 ? contextValues : [undefined]) {
      for (const fastMode of fastValues) {
        const variantParams = { ...params };
        if (reasoningKey && effort) {
          variantParams[reasoningKey] = cursorReasoningParameterValue(effort);
        }
        if (contextWindow) {
          variantParams.context = contextWindow;
        }
        if (fastMode !== undefined) {
          variantParams.fast = String(fastMode);
        }
        const slug = buildCursorParameterizedModelSlug(baseModel, variantParams);
        if (seen.has(slug)) {
          continue;
        }
        seen.add(slug);
        descriptors.push(
          buildCursorAcpModelDescriptor({
            choice: input.choice,
            slug,
            name: withCursorVariantName(
              input.choice.name,
              effort,
              variantDefaultEffort,
              contextWindow,
              variantDefaultContextWindow,
              input.contextWindowOptions,
              fastMode,
            ),
            supportedReasoningEfforts: [],
            contextWindowOptions: [],
          }),
        );
      }
    }
  }

  return descriptors;
}

export function buildCursorAcpModelDescriptors(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<ProviderModelDescriptor> {
  const choices = flattenCursorAcpModelChoices(configOptions);
  if (choices.length === 0) {
    return [];
  }

  const effortOption = findCursorEffortConfigOption(configOptions);
  const supportedReasoningEfforts =
    effortOption?.type === "select"
      ? flattenSessionConfigSelectOptions(effortOption).flatMap((entry) => {
          const value = normalizeCursorReasoningValue(entry.value);
          if (!value) {
            return [];
          }
          return [
            {
              value,
              label: entry.name || value,
            },
          ];
        })
      : [];
  const defaultReasoningEffort =
    effortOption?.type === "select"
      ? normalizeCursorReasoningValue(effortOption.currentValue)
      : undefined;
  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorContextConfigOption(option),
  );
  const contextWindowOptions =
    contextOption?.type === "select"
      ? flattenSessionConfigSelectOptions(contextOption).map((entry) => ({
          value: entry.value,
          label: entry.name || entry.value,
          ...(contextOption.currentValue === entry.value ? { isDefault: true as const } : {}),
        }))
      : [];
  const defaultContextWindow = contextWindowOptions.find((option) => option.isDefault)?.value;

  const descriptors = choices.flatMap((choice) =>
    expandCursorParameterizedModelDescriptors({
      choice,
      supportedReasoningEfforts,
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      contextWindowOptions,
      ...(defaultContextWindow ? { defaultContextWindow } : {}),
    }),
  );
  const seen = new Set<string>();
  return descriptors.filter((descriptor) => {
    if (seen.has(descriptor.slug)) {
      return false;
    }
    seen.add(descriptor.slug);
    return true;
  });
}

function toConfigValue(
  option: EffectAcpSchema.SessionConfigOption,
  value: string | boolean,
): string | boolean | undefined {
  if (option.type === "boolean") {
    return typeof value === "boolean" ? value : value.toLowerCase() === "true";
  }
  if (option.type !== "select") {
    return undefined;
  }
  const stringValue = String(value).trim();
  if (!stringValue) return undefined;
  const normalized = normalizedText(stringValue);
  const normalizedAliases =
    normalized === "xhigh" || normalized === "extra high"
      ? new Set([normalized, "xhigh", "extra high"])
      : new Set([normalized]);
  for (const entry of option.options) {
    const candidates =
      "value" in entry
        ? [{ value: entry.value, name: entry.name }]
        : entry.options.map((nested) => ({ value: nested.value, name: nested.name }));
    for (const candidate of candidates) {
      if (
        normalizedAliases.has(normalizedText(candidate.value)) ||
        normalizedAliases.has(normalizedText(candidate.name))
      ) {
        return candidate.value;
      }
    }
  }
  return undefined;
}

function cursorChoiceMatchesBase(choice: CursorAcpModelChoice, baseModel: string): boolean {
  const choiceBase = resolveCursorAcpBaseModelId(choice.slug);
  const cliBaseModel = normalizeCursorCliBaseModelId(baseModel);
  return choiceBase === baseModel || choiceBase === cliBaseModel;
}

function cursorParameterValuesMatch(key: string, left: string, right: string): boolean {
  if (key === "reasoning" || key === "effort") {
    return normalizeCursorReasoningValue(left) === normalizeCursorReasoningValue(right);
  }
  return normalizedText(left) === normalizedText(right);
}

function resolveCursorChoiceParameterValue(input: {
  readonly choices: ReadonlyArray<CursorAcpModelChoice>;
  readonly baseModel: string;
  readonly key: string;
  readonly requestedValue: string;
}): string | undefined {
  // Match ACP's own parameter spelling so xhigh/extra-high variants remain valid.
  let sawParameterizedChoice = false;
  for (const choice of input.choices) {
    if (!cursorChoiceMatchesBase(choice, input.baseModel)) {
      continue;
    }
    const value = parseCursorModelParameters(choice.slug).get(input.key);
    if (!value) {
      continue;
    }
    sawParameterizedChoice = true;
    if (cursorParameterValuesMatch(input.key, value, input.requestedValue)) {
      return value;
    }
  }
  return sawParameterizedChoice ? undefined : input.requestedValue;
}

function cursorModelOptionValueSupported(input: {
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly choices: ReadonlyArray<CursorAcpModelChoice>;
  readonly baseModel: string;
  readonly aliases: ReadonlyArray<string>;
  readonly parameterKey: string;
  readonly value: string | boolean;
}): boolean {
  const option = findConfigOption(input.configOptions, input.aliases);
  if (option) {
    return toConfigValue(option, input.value) !== undefined;
  }
  if (typeof input.value === "boolean") {
    if (
      input.value === false &&
      (input.parameterKey === "fast" || input.parameterKey === "thinking")
    ) {
      return true;
    }
    return (
      resolveCursorChoiceParameterValue({
        choices: input.choices,
        baseModel: input.baseModel,
        key: input.parameterKey,
        requestedValue: String(input.value),
      }) !== undefined
    );
  }
  return (
    resolveCursorChoiceParameterValue({
      choices: input.choices,
      baseModel: input.baseModel,
      key: input.parameterKey,
      requestedValue: input.value,
    }) !== undefined
  );
}

export function normalizeCursorAcpRuntimeOptions(input: {
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly choices: ReadonlyArray<CursorAcpModelChoice>;
  readonly baseModel: string;
  readonly options: CursorModelOptions | null | undefined;
}): CursorModelOptions | undefined {
  // Runtime choices are authoritative; persisted traits can outlive Cursor's model matrix.
  if (!input.options) {
    return undefined;
  }

  const nextOptions: {
    reasoningEffort?: string;
    contextWindow?: string;
    fastMode?: boolean;
    thinking?: boolean;
  } = {};
  if (input.options.reasoningEffort) {
    const parameterKey = cursorAcpParameterKeyForModel(input.baseModel, input.options);
    if (
      cursorModelOptionValueSupported({
        configOptions: input.configOptions,
        choices: input.choices,
        baseModel: input.baseModel,
        aliases: ["effort", "reasoning", "thought level"],
        parameterKey,
        value: input.options.reasoningEffort,
      })
    ) {
      nextOptions.reasoningEffort = input.options.reasoningEffort;
    }
  }
  if (
    input.options.contextWindow &&
    cursorModelOptionValueSupported({
      configOptions: input.configOptions,
      choices: input.choices,
      baseModel: input.baseModel,
      aliases: ["context", "context size", "context window"],
      parameterKey: "context",
      value: input.options.contextWindow,
    })
  ) {
    nextOptions.contextWindow = input.options.contextWindow;
  }
  if (
    input.options.fastMode !== undefined &&
    cursorModelOptionValueSupported({
      configOptions: input.configOptions,
      choices: input.choices,
      baseModel: input.baseModel,
      aliases: ["fast", "fast mode"],
      parameterKey: "fast",
      value: input.options.fastMode,
    })
  ) {
    nextOptions.fastMode = input.options.fastMode;
  }
  if (
    input.options.thinking !== undefined &&
    cursorModelOptionValueSupported({
      configOptions: input.configOptions,
      choices: input.choices,
      baseModel: input.baseModel,
      aliases: ["thinking"],
      parameterKey: "thinking",
      value: input.options.thinking,
    })
  ) {
    nextOptions.thinking = input.options.thinking;
  }

  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function collectCursorAcpConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  options: CursorModelOptions | null | undefined,
): ReadonlyArray<{ readonly configId: string; readonly value: string | boolean }> {
  if (!options) return [];
  const updates: Array<{ readonly configId: string; readonly value: string | boolean }> = [];
  const pushUpdate = (
    aliases: ReadonlyArray<string>,
    value: string | boolean | undefined,
  ): void => {
    if (value === undefined) return;
    const option = findConfigOption(configOptions, aliases);
    if (!option) return;
    const configValue = toConfigValue(option, value);
    if (configValue === undefined) return;
    updates.push({ configId: option.id, value: configValue });
  };

  pushUpdate(["effort", "reasoning", "thought level"], options.reasoningEffort);
  pushUpdate(["context", "context size", "context window"], options.contextWindow);
  pushUpdate(["fast", "fast mode"], options.fastMode);
  pushUpdate(["thinking"], options.thinking);
  return updates;
}

function findCursorModelChoiceIgnoringFast(
  choices: ReadonlyArray<CursorAcpModelChoice>,
  model: string,
): string | undefined {
  const requestedParams = parseCursorModelParameters(model);
  if (requestedParams.get("fast") !== "true") {
    return undefined;
  }

  const baseModel = stripCursorParameterizedSuffix(model);
  return choices.find(
    (choice) =>
      stripCursorParameterizedSuffix(choice.slug) === baseModel &&
      parseCursorModelParameters(choice.slug).has("fast") &&
      cursorModelParametersEqualExceptFast(choice.slug, model),
  )?.slug;
}

function findCursorModelChoiceWithSupportedParameters(
  choices: ReadonlyArray<CursorAcpModelChoice>,
  model: string,
): string | undefined {
  return choices.find((choice) => cursorModelChoiceSupportsRequestedParameters(choice.slug, model))
    ?.slug;
}

function resolveCursorAutoModelValue(
  choices: ReadonlyArray<CursorAcpModelChoice>,
): string | undefined {
  return (
    choices.find((choice) => choice.slug.trim().toLowerCase() === "auto")?.slug ??
    choices.find((choice) => normalizedText(choice.name) === "auto")?.slug
  );
}

export function resolveCursorAcpModelValue(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  model: string | null | undefined,
  options: CursorModelOptions | null | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) {
    return undefined;
  }

  const choices = flattenCursorAcpModelChoices(configOptions);
  if (trimmed === "auto") {
    return resolveCursorAutoModelValue(choices);
  }

  const exactChoice = choices.find((choice) => choice.slug === trimmed);
  if (exactChoice) {
    return exactChoice.slug;
  }

  const baseModel = resolveCursorAcpBaseModelId(trimmed);
  if (baseModel === "auto") {
    return undefined;
  }
  const cliBaseModel = normalizeCursorCliBaseModelId(baseModel);

  const acpModelValue =
    choices.find((choice) => choice.slug === baseModel)?.slug ??
    choices.find((choice) => resolveCursorAcpBaseModelId(choice.slug) === baseModel)?.slug ??
    choices.find((choice) => resolveCursorAcpBaseModelId(choice.slug) === cliBaseModel)?.slug ??
    baseModel;
  const inferredModel =
    buildCursorParameterizedModelFromCliModelId({
      acpModelValue,
      cliModel: trimmed,
      choices,
    }) ?? acpModelValue;
  const resolvedModel =
    buildCursorParameterizedModelFromOptions({
      acpModelValue: inferredModel,
      options,
      choices,
    }) ?? inferredModel;
  if (choices.some((choice) => choice.slug === resolvedModel)) {
    return resolvedModel;
  }
  return (
    findCursorModelChoiceIgnoringFast(choices, resolvedModel) ??
    findCursorModelChoiceWithSupportedParameters(choices, resolvedModel) ??
    resolvedModel
  );
}
