import { type CursorModelOptions, type ProviderModelDescriptor } from "@t3tools/contracts";
import { formatModelDisplayName } from "@t3tools/shared/model";
import { Effect, Layer, Scope, ServiceMap } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

export interface CursorAcpRuntimeCursorSettings {
  readonly apiEndpoint?: string;
  readonly binaryPath?: string;
}

export const CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES = {
  _meta: {
    parameterizedModelPicker: true,
  },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

export interface CursorAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined;
}

export interface CursorAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

export interface CursorAcpModelChoice {
  readonly slug: string;
  readonly name: string;
  readonly upstreamProviderId?: string;
  readonly upstreamProviderName?: string;
}

interface CursorAcpSelectOption {
  readonly value: string;
  readonly name: string;
  readonly groupId?: string;
  readonly groupName?: string;
}

export function buildCursorAcpSpawnInput(
  cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  return {
    command: cursorSettings?.binaryPath || "agent",
    args: [
      ...(cursorSettings?.apiEndpoint ? (["-e", cursorSettings.apiEndpoint] as const) : []),
      "acp",
    ],
    cwd,
  };
}

export const makeCursorAcpRuntime = (
  input: CursorAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCursorAcpSpawnInput(input.cursorSettings, input.cwd),
        authMethodId: "cursor_login",
        clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });

interface CursorAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntimeShape["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function resolveCursorAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === "auto") return "auto";
  const parameterStart = trimmed.indexOf("[");
  return parameterStart === -1 ? trimmed : trimmed.slice(0, parameterStart).trim() || "auto";
}

function normalizedText(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

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

function stripCursorParameterizedSuffix(value: string): string {
  const trimmed = value.trim();
  const suffixStart = trimmed.indexOf("[");
  return suffixStart >= 0 ? trimmed.slice(0, suffixStart).trim() : trimmed;
}

function parseCursorModelParameters(value: string): ReadonlyMap<string, string> {
  const match = value.match(/\[([^\]]*)\]$/u);
  if (!match?.[1]) {
    return new Map();
  }
  const params = new Map<string, string>();
  for (const part of match[1].split(",")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = part.slice(0, separatorIndex).trim();
    const paramValue = part.slice(separatorIndex + 1).trim();
    if (key && paramValue) {
      params.set(key, paramValue);
    }
  }
  return params;
}

function cursorModelParametersToObject(value: string): Record<string, string> {
  return Object.fromEntries(parseCursorModelParameters(value).entries());
}

function buildCursorParameterizedModelSlug(baseModel: string, params: Record<string, string>): string {
  const entries = Object.entries(params).filter(([, value]) => value.trim().length > 0);
  if (entries.length === 0) {
    return baseModel;
  }
  return `${baseModel}[${entries.map(([key, value]) => `${key}=${value}`).join(",")}]`;
}

function humanizeCursorModelName(value: string): string {
  const base = stripCursorParameterizedSuffix(value);
  if (base.length === 0) {
    return value;
  }
  const sharedDisplayName = formatModelDisplayName(base);
  if (sharedDisplayName) {
    return sharedDisplayName;
  }
  return base
    .split(/[-_/]+/u)
    .filter((part) => part.length > 0)
    .map((part) => {
      const lower = part.toLowerCase();
      if (/^gpt$/u.test(lower)) return "GPT";
      if (/^ai$/u.test(lower)) return "AI";
      if (/^codex$/u.test(lower)) return "Codex";
      if (/^claude$/u.test(lower)) return "Claude";
      if (/^opus$/u.test(lower)) return "Opus";
      if (/^sonnet$/u.test(lower)) return "Sonnet";
      if (/^haiku$/u.test(lower)) return "Haiku";
      if (/^gemini$/u.test(lower)) return "Gemini";
      if (/^grok$/u.test(lower)) return "Grok";
      if (/^kimi$/u.test(lower)) return "Kimi";
      if (/^llama$/u.test(lower)) return "Llama";
      if (/^qwen$/u.test(lower)) return "Qwen";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function normalizeCursorAcpModelName(choice: CursorAcpSelectOption): string {
  const rawName = choice.name.trim();
  const rawBase = stripCursorParameterizedSuffix(choice.value);
  if (
    rawName.length > 0 &&
    rawName.toLowerCase() !== choice.value.trim().toLowerCase() &&
    rawName.toLowerCase() !== rawBase.toLowerCase()
  ) {
    return rawName;
  }
  return humanizeCursorModelName(choice.value);
}

function inferCursorUpstreamProvider(choice: CursorAcpSelectOption): {
  readonly upstreamProviderId: string;
  readonly upstreamProviderName: string;
} {
  const groupId = choice.groupId?.trim();
  const groupName = choice.groupName?.trim();
  if (groupId || groupName) {
    return {
      upstreamProviderId: (groupId || groupName || "cursor").toLowerCase().replace(/\s+/gu, "-"),
      upstreamProviderName: groupName || groupId || "Cursor",
    };
  }

  const token = stripCursorParameterizedSuffix(`${choice.value} ${choice.name}`)
    .trim()
    .toLowerCase();
  if (token.includes("claude")) {
    return { upstreamProviderId: "anthropic", upstreamProviderName: "Anthropic" };
  }
  if (token.includes("gemini")) {
    return { upstreamProviderId: "google", upstreamProviderName: "Google" };
  }
  if (token.includes("grok")) {
    return { upstreamProviderId: "xai", upstreamProviderName: "xAI" };
  }
  if (token.includes("kimi")) {
    return { upstreamProviderId: "moonshot", upstreamProviderName: "Moonshot AI" };
  }
  if (token.includes("deepseek")) {
    return { upstreamProviderId: "deepseek", upstreamProviderName: "DeepSeek" };
  }
  if (token.includes("qwen")) {
    return { upstreamProviderId: "alibaba", upstreamProviderName: "Alibaba" };
  }
  if (token.includes("llama")) {
    return { upstreamProviderId: "meta", upstreamProviderName: "Meta" };
  }
  if (token.includes("mistral")) {
    return { upstreamProviderId: "mistral", upstreamProviderName: "Mistral" };
  }
  if (token.includes("nemotron")) {
    return { upstreamProviderId: "nvidia", upstreamProviderName: "NVIDIA" };
  }
  if (
    token.includes("gpt") ||
    token.includes("codex") ||
    token.includes("o1") ||
    token.includes("o3") ||
    token.includes("o4")
  ) {
    return { upstreamProviderId: "openai", upstreamProviderName: "OpenAI" };
  }
  return { upstreamProviderId: "cursor", upstreamProviderName: "Cursor" };
}

export function flattenCursorAcpModelChoices(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<CursorAcpModelChoice> {
  const seen = new Set<string>();
  const choices: Array<CursorAcpModelChoice> = [];
  for (const choice of flattenSessionConfigSelectOptions(findCursorModelConfigOption(configOptions))) {
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

function normalizeCursorCliBaseModelId(model: string): string {
  const trimmed = model.trim();
  const withoutVariantSuffixes = trimmed
    .replace(/-fast$/u, "")
    .replace(/-(?:extra-high|none|low|medium|high|xhigh)$/u, "")
    .replace(/-thinking$/u, "")
    .replace(/-fast$/u, "")
    .replace(/-(?:extra-high|none|low|medium|high|xhigh)$/u, "")
    .replace(/^claude-(\d+(?:\.\d+)?)-([a-z]+)-max$/u, "claude-$1-$2")
    .replace(/-preview$/u, "");

  const claudeReordered = withoutVariantSuffixes.match(/^claude-(\d+(?:\.\d+)?)-([a-z]+)$/u);
  if (claudeReordered) {
    const version = claudeReordered[1];
    const family = claudeReordered[2];
    if (!version || !family) {
      return withoutVariantSuffixes;
    }
    return `claude-${family}-${version.replace(".", "-")}`;
  }
  return withoutVariantSuffixes;
}

function parseCursorCliReasoningEffort(model: string): string | undefined {
  const tokens = model.trim().toLowerCase().split("-");
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token === "xhigh") {
      return "xhigh";
    }
    if (token === "high" && tokens[index - 1] === "extra") {
      return "xhigh";
    }
    if (token === "none" || token === "low" || token === "medium" || token === "high") {
      return token;
    }
  }
  return undefined;
}

function isCursorCliOneMillionContextModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("gpt-5.5-")) {
    return true;
  }
  if (/^gpt-5\.4-(?:low|medium|high|xhigh|extra-high)$/u.test(normalized)) {
    return true;
  }
  if (/^claude-opus-4-7(?:-|$)/u.test(normalized)) {
    return true;
  }
  if (/^claude-4\.6-(?:opus|sonnet)(?:-|$)/u.test(normalized)) {
    return true;
  }
  return false;
}

function cursorModelOptionsFromCliModelId(model: string | null | undefined): CursorModelOptions {
  const trimmed = model?.trim();
  if (!trimmed || trimmed.includes("[")) {
    return {};
  }

  const lower = trimmed.toLowerCase();
  const reasoningEffort = parseCursorCliReasoningEffort(lower);
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(lower.endsWith("-fast") ? { fastMode: true } : {}),
    ...(lower.includes("-thinking") ? { thinking: true } : {}),
    ...(isCursorCliOneMillionContextModel(lower) ? { contextWindow: "1m" } : {}),
  };
}

function cursorAcpParameterKeyForModel(baseModel: string, options: CursorModelOptions): string {
  if (options.reasoningEffort && baseModel.includes("claude")) {
    return "effort";
  }
  return "reasoning";
}

function buildCursorParameterizedModelFromCliModelId(input: {
  readonly acpModelValue: string;
  readonly cliModel: string;
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
    params[cursorAcpParameterKeyForModel(baseModel, cliOptions)] = cursorReasoningParameterValue(
      cliOptions.reasoningEffort,
    );
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
    params[cursorAcpParameterKeyForModel(baseModel, input.options)] = cursorReasoningParameterValue(
      input.options.reasoningEffort,
    );
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

function normalizeCursorReasoningValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "xhigh":
    case "extra-high":
    case "extra high":
      return "xhigh";
    default:
      return undefined;
  }
}

function cursorReasoningParameterValue(value: string): string {
  return value === "xhigh" ? "extra-high" : value;
}

function cursorReasoningLabel(value: string): string {
  switch (value) {
    case "xhigh":
      return "Extra High";
    case "max":
      return "Max";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}

function cursorContextLabel(
  value: string,
  contextWindowOptions: NonNullable<ProviderModelDescriptor["contextWindowOptions"]>,
): string {
  return contextWindowOptions.find((option) => option.value === value)?.label ?? value.toUpperCase();
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
  readonly supportedReasoningEfforts: NonNullable<ProviderModelDescriptor["supportedReasoningEfforts"]>;
  readonly defaultReasoningEffort?: string;
  readonly contextWindowOptions: NonNullable<ProviderModelDescriptor["contextWindowOptions"]>;
  readonly defaultContextWindow?: string;
}): ProviderModelDescriptor {
  return {
    slug: input.slug,
    name: input.name,
    ...(input.choice.upstreamProviderId ? { upstreamProviderId: input.choice.upstreamProviderId } : {}),
    ...(input.choice.upstreamProviderName ? { upstreamProviderName: input.choice.upstreamProviderName } : {}),
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
  readonly supportedReasoningEfforts: NonNullable<ProviderModelDescriptor["supportedReasoningEfforts"]>;
  readonly defaultReasoningEffort?: string;
  readonly contextWindowOptions: NonNullable<ProviderModelDescriptor["contextWindowOptions"]>;
  readonly defaultContextWindow?: string;
}): ReadonlyArray<ProviderModelDescriptor> {
  const params = cursorModelParametersToObject(input.choice.slug);
  const reasoningKey = params.reasoning !== undefined ? "reasoning" : params.effort !== undefined ? "effort" : null;
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
      ? new Set([normalized, "extra high", "extra high"])
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
  return stringValue;
}

function collectCursorAcpConfigUpdates(
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

function cursorModelOptionsFromModelParameters(model: string | null | undefined): CursorModelOptions | undefined {
  if (!model) {
    return undefined;
  }
  const params = parseCursorModelParameters(model);
  const reasoningEffort = normalizeCursorReasoningValue(params.get("reasoning") ?? params.get("effort"));
  const contextWindow = params.get("context")?.trim();
  const fastModeParam = params.get("fast")?.trim().toLowerCase();
  const thinkingParam = params.get("thinking")?.trim().toLowerCase();
  const fastMode = fastModeParam === "true" ? true : fastModeParam === "false" ? false : undefined;
  const thinking = thinkingParam === "true" ? true : thinkingParam === "false" ? false : undefined;
  const options: CursorModelOptions = {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

function mergeCursorModelOptions(
  base: CursorModelOptions | undefined,
  override: CursorModelOptions | null | undefined,
): CursorModelOptions | undefined {
  const merged: CursorModelOptions = {
    ...(base ?? {}),
    ...(override ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function cursorModelParametersEqualExceptFast(left: string, right: string): boolean {
  const leftParams = cursorModelParametersToObject(left);
  const rightParams = cursorModelParametersToObject(right);
  delete leftParams.fast;
  delete rightParams.fast;
  return JSON.stringify(leftParams) === JSON.stringify(rightParams);
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

function cursorModelChoiceSupportsRequestedParameters(
  choice: string,
  requested: string,
): boolean {
  if (stripCursorParameterizedSuffix(choice) !== stripCursorParameterizedSuffix(requested)) {
    return false;
  }

  const choiceParams = parseCursorModelParameters(choice);
  const requestedParams = parseCursorModelParameters(requested);
  for (const [key, requestedValue] of requestedParams) {
    const choiceValue = choiceParams.get(key);
    if (choiceValue === requestedValue) {
      continue;
    }
    if ((key === "fast" || key === "thinking") && requestedValue === "false") {
      continue;
    }
    return false;
  }
  return true;
}

function findCursorModelChoiceWithSupportedParameters(
  choices: ReadonlyArray<CursorAcpModelChoice>,
  model: string,
): string | undefined {
  return choices.find((choice) => cursorModelChoiceSupportsRequestedParameters(choice.slug, model))?.slug;
}

function resolveCursorAutoModelValue(
  choices: ReadonlyArray<CursorAcpModelChoice>,
): string | undefined {
  return (
    choices.find((choice) => choice.slug.trim().toLowerCase() === "auto")?.slug ??
    choices.find((choice) => normalizedText(choice.name) === "auto")?.slug
  );
}

function resolveCursorAcpModelValue(
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
    }) ?? acpModelValue;
  const resolvedModel =
    buildCursorParameterizedModelFromOptions({
      acpModelValue: inferredModel,
      options,
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

export function applyCursorAcpModelSelection<E>(input: {
  readonly runtime: CursorAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly options: CursorModelOptions | null | undefined;
  readonly mapError: (context: CursorAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const initialConfigOptions = yield* input.runtime.getConfigOptions;
    const mergedOptions = mergeCursorModelOptions(
      mergeCursorModelOptions(
        cursorModelOptionsFromCliModelId(input.model),
        cursorModelOptionsFromModelParameters(input.model),
      ),
      input.options,
    );
    const modelValue = resolveCursorAcpModelValue(initialConfigOptions, input.model, mergedOptions);
    if (modelValue) {
      yield* input.runtime.setModel(modelValue).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-model",
          }),
        ),
      );
    }

    const configUpdates = collectCursorAcpConfigUpdates(
      yield* input.runtime.getConfigOptions,
      mergedOptions,
    );
    for (const update of configUpdates) {
      yield* input.runtime.setConfigOption(update.configId, update.value).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-config-option",
            configId: update.configId,
          }),
        ),
      );
    }
  });
}
