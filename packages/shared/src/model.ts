import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_CAPABILITIES_INDEX,
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ClaudeModelOptions,
  type ClaudeCodeEffort,
  type CodexModelOptions,
  type CursorModelOptions,
  type GeminiModelOptions,
  type GeminiThinkingBudget,
  type GeminiThinkingLevel,
  type DroidModelOptions,
  type DroidReasoningEffort,
  type GrokModelOptions,
  type GrokReasoningEffort,
  type ModelCapabilities,
  type ModelSelection,
  type ModelSlug,
  type OpenCodeModelOptions,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type PiModelOptions,
  type PiThinkingLevel,
  type ProviderKind,
  type ProviderWithDefaultModel,
  CodexReasoningEffort,
} from "@t3tools/contracts";

const MODEL_SLUG_SET_BY_PROVIDER: Record<ProviderKind, ReadonlySet<ModelSlug>> = {
  claudeAgent: new Set(MODEL_OPTIONS_BY_PROVIDER.claudeAgent.map((option) => option.slug)),
  codex: new Set(MODEL_OPTIONS_BY_PROVIDER.codex.map((option) => option.slug)),
  cursor: new Set(MODEL_OPTIONS_BY_PROVIDER.cursor.map((option) => option.slug)),
  gemini: new Set(MODEL_OPTIONS_BY_PROVIDER.gemini.map((option) => option.slug)),
  grok: new Set(MODEL_OPTIONS_BY_PROVIDER.grok.map((option) => option.slug)),
  droid: new Set(MODEL_OPTIONS_BY_PROVIDER.droid.map((option) => option.slug)),
  kilo: new Set(MODEL_OPTIONS_BY_PROVIDER.kilo.map((option) => option.slug)),
  opencode: new Set(MODEL_OPTIONS_BY_PROVIDER.opencode.map((option) => option.slug)),
  pi: new Set<ModelSlug>(),
};

export interface SelectableModelOption {
  slug: string;
  name: string;
}

export type GeminiThinkingConfigKind = "budget" | "level";

const GEMINI_3_MODEL_PATTERN = /^(?:auto-)?gemini-3(?:[.-]|$)/i;
const GEMINI_2_5_MODEL_PATTERN = /^(?:auto-)?gemini-2\.5(?:[.-]|$)/i;
const GEMINI_THINKING_LEVEL_SET = new Set<GeminiThinkingLevel>(["LOW", "HIGH"]);
const PI_THINKING_LEVEL_SET = new Set<PiThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const GEMINI_THINKING_BUDGET_MAP = new Map<string, GeminiThinkingBudget>([
  ["-1", -1],
  ["0", 0],
  ["512", 512],
]);

export const EMPTY_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: [],
  contextWindowOptions: [],
};
export const DEFAULT_GEMINI_MODEL_CAPABILITIES = EMPTY_MODEL_CAPABILITIES;

export const GEMINI_3_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "HIGH", label: "High", isDefault: true },
    { value: "LOW", label: "Low" },
  ],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: [],
  contextWindowOptions: [],
};

export const GEMINI_2_5_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "-1", label: "Dynamic", isDefault: true },
    { value: "512", label: "512 Tokens" },
  ],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: [],
  contextWindowOptions: [],
};

function isGeminiThinkingLevel(value: string): value is GeminiThinkingLevel {
  return GEMINI_THINKING_LEVEL_SET.has(value as GeminiThinkingLevel);
}

function isGeminiThinkingBudget(value: string): value is `${GeminiThinkingBudget}` {
  return GEMINI_THINKING_BUDGET_MAP.has(value);
}

function sanitizeGeminiAliasSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "model";
}

export function getModelOptions(provider: ProviderKind = "codex") {
  return MODEL_OPTIONS_BY_PROVIDER[provider];
}

function hasDefaultModel(provider: ProviderKind): provider is ProviderWithDefaultModel {
  return provider !== "pi";
}

export function getDefaultModel(provider: "pi"): null;
export function getDefaultModel(provider?: ProviderWithDefaultModel): ModelSlug;
export function getDefaultModel(provider: ProviderKind): ModelSlug | null;
export function getDefaultModel(provider: ProviderKind = "codex"): ModelSlug | null {
  return hasDefaultModel(provider) ? DEFAULT_MODEL_BY_PROVIDER[provider] : null;
}

export function getGeminiThinkingConfigKind(
  model: string | null | undefined,
): GeminiThinkingConfigKind | null {
  const trimmed = trimOrNull(model);
  if (!trimmed) {
    return null;
  }
  if (GEMINI_3_MODEL_PATTERN.test(trimmed)) {
    return "level";
  }
  if (GEMINI_2_5_MODEL_PATTERN.test(trimmed)) {
    return "budget";
  }
  return null;
}

export function geminiCapabilitiesForModel(
  modelId: string | null | undefined,
  fallbackCapabilities: ModelCapabilities = EMPTY_MODEL_CAPABILITIES,
): ModelCapabilities {
  const trimmed = trimOrNull(modelId)?.toLowerCase();
  switch (getGeminiThinkingConfigKind(modelId)) {
    case "level":
      return GEMINI_3_MODEL_CAPABILITIES;
    case "budget":
      if (!trimmed) {
        return fallbackCapabilities;
      }
      return GEMINI_2_5_MODEL_CAPABILITIES;
    default:
      return fallbackCapabilities;
  }
}

const MODEL_NAME_BY_SLUG = new Map(
  Object.values(MODEL_OPTIONS_BY_PROVIDER)
    .flat()
    .map((option) => [option.slug.toLowerCase(), option.name] as const),
);

// Turns a raw model slug into a readable label when no built-in name exists.
// GPT slugs keep their canonical "GPT-x" casing; provider-scoped custom ids
// ("vendor/model") stay verbatim; everything else is title-cased on -/_ .
export function humanizeModelSlug(slug: string): string {
  if (slug.toLowerCase().startsWith("gpt-")) {
    const [, version, ...rest] = slug.split("-");
    if (rest.length === 0) return `GPT-${version}`;
    return `GPT-${version} ${rest.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ")}`;
  }
  if (slug.includes("/")) {
    return slug;
  }
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatModelDisplayName(model: string | null | undefined): string | undefined {
  const normalized = trimOrNull(model);
  if (!normalized) {
    return undefined;
  }

  return MODEL_NAME_BY_SLUG.get(normalized.toLowerCase()) ?? humanizeModelSlug(normalized);
}

export function getGeminiThinkingSelectionValue(
  caps: ModelCapabilities,
  modelOptions: GeminiModelOptions | null | undefined,
): string | null {
  const candidates = [
    trimOrNull(modelOptions?.thinkingLevel),
    modelOptions?.thinkingBudget !== undefined ? String(modelOptions.thinkingBudget) : null,
  ];

  return (
    candidates.find(
      (candidate): candidate is string => !!candidate && hasEffortLevel(caps, candidate),
    ) ??
    candidates.find((candidate): candidate is string => !!candidate) ??
    null
  );
}

export function geminiModelOptionsFromEffortValue(
  value: string | null | undefined,
): GeminiModelOptions | undefined {
  const trimmed = trimOrNull(value);
  if (!trimmed) {
    return undefined;
  }
  if (isGeminiThinkingLevel(trimmed)) {
    return { thinkingLevel: trimmed };
  }
  if (isGeminiThinkingBudget(trimmed)) {
    return {
      thinkingBudget: GEMINI_THINKING_BUDGET_MAP.get(trimmed) as GeminiThinkingBudget,
    };
  }
  return undefined;
}

export function getGeminiThinkingModelAlias(
  model: string,
  modelOptions: GeminiModelOptions | null | undefined,
): string | null {
  const kind = getGeminiThinkingConfigKind(model);
  if (!kind || !modelOptions) {
    return null;
  }

  const caps = getModelCapabilities("gemini", model);
  const effort = getGeminiThinkingSelectionValue(caps, modelOptions);
  if (!effort || !hasEffortLevel(caps, effort)) {
    return null;
  }
  const nextOptions = geminiModelOptionsFromEffortValue(effort);
  if (!nextOptions) {
    return null;
  }

  const base = sanitizeGeminiAliasSegment(model);
  if (kind === "level" && nextOptions.thinkingLevel) {
    return `synara-gemini-${base}-thinking-level-${nextOptions.thinkingLevel.toLowerCase()}`;
  }
  if (kind === "budget" && nextOptions.thinkingBudget !== undefined) {
    const budget =
      nextOptions.thinkingBudget === -1 ? "dynamic" : String(nextOptions.thinkingBudget);
    return `synara-gemini-${base}-thinking-budget-${budget}`;
  }
  return null;
}

export function resolveGeminiApiModelId(
  model: string,
  modelOptions: GeminiModelOptions | null | undefined,
): string {
  return getGeminiThinkingModelAlias(model, modelOptions) ?? model;
}

// ── Effort helpers ────────────────────────────────────────────────────

/** Check whether a capabilities object includes a given effort value. */
export function hasEffortLevel(caps: ModelCapabilities, value: string): boolean {
  return caps.reasoningEffortLevels.some((l) => l.value === value);
}

/** Return the default effort value for a capabilities object, or null if none. */
export function getDefaultEffort(caps: ModelCapabilities): string | null {
  return caps.reasoningEffortLevels.find((l) => l.isDefault)?.value ?? null;
}

/** Check whether a capabilities object includes a given context window value. */
export function hasContextWindowOption(caps: ModelCapabilities, value: string): boolean {
  return caps.contextWindowOptions.some((option) => option.value === value);
}

/** Return the default context window value for a capabilities object, or null if none. */
export function getDefaultContextWindow(caps: ModelCapabilities): string | null {
  return caps.contextWindowOptions.find((option) => option.isDefault)?.value ?? null;
}

export function resolveLabeledOptionValue(
  options: ReadonlyArray<{ value: string; isDefault?: boolean | undefined }> | undefined,
  rawValue: string | null | undefined,
): string | null {
  const trimmedValue = trimOrNull(rawValue);
  if (!options || options.length === 0) {
    return trimmedValue;
  }
  if (trimmedValue && options.some((option) => option.value === trimmedValue)) {
    return trimmedValue;
  }
  return options.find((option) => option.isDefault)?.value ?? options[0]?.value ?? null;
}

type ProviderOptionSelectionsInput =
  | ReadonlyArray<ProviderOptionSelection>
  | Record<string, unknown>
  | null
  | undefined;

function cloneProviderOptionDescriptor(
  descriptor: ProviderOptionDescriptor,
): ProviderOptionDescriptor {
  if (descriptor.type === "select") {
    return {
      ...descriptor,
      options: descriptor.options.map((option) => ({ ...option })),
      ...(descriptor.promptInjectedValues
        ? { promptInjectedValues: [...descriptor.promptInjectedValues] }
        : {}),
    };
  }
  return { ...descriptor };
}

function providerOptionSelectionValue(
  selections: ProviderOptionSelectionsInput,
  id: string,
): string | boolean | undefined {
  if (!selections) {
    return undefined;
  }
  if (Array.isArray(selections)) {
    return selections.find((selection) => selection.id === id)?.value;
  }
  const selectionRecord = selections as Record<string, unknown>;
  const value = selectionRecord[id];
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" || typeof value === "boolean" ? value : undefined;
}

export function getProviderOptionSelectionValue(
  selections: ProviderOptionSelectionsInput,
  id: string,
): string | boolean | undefined {
  return providerOptionSelectionValue(selections, id);
}

export function getProviderOptionStringSelectionValue(
  selections: ProviderOptionSelectionsInput,
  id: string,
): string | undefined {
  const value = getProviderOptionSelectionValue(selections, id);
  return typeof value === "string" ? value : undefined;
}

export function getProviderOptionBooleanSelectionValue(
  selections: ProviderOptionSelectionsInput,
  id: string,
): boolean | undefined {
  const value = getProviderOptionSelectionValue(selections, id);
  return typeof value === "boolean" ? value : undefined;
}

export function getModelSelectionOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): string | boolean | undefined {
  return getProviderOptionSelectionValue(
    modelSelection?.options as ProviderOptionSelectionsInput,
    id,
  );
}

export function getModelSelectionStringOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): string | undefined {
  return getProviderOptionStringSelectionValue(
    modelSelection?.options as ProviderOptionSelectionsInput,
    id,
  );
}

export function getModelSelectionBooleanOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): boolean | undefined {
  return getProviderOptionBooleanSelectionValue(
    modelSelection?.options as ProviderOptionSelectionsInput,
    id,
  );
}

function resolveDescriptorChoiceValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  rawValue: string | null | undefined,
): string | undefined {
  const trimmed = trimOrNull(rawValue);
  if (trimmed && descriptor.options.some((option) => option.id === trimmed)) {
    return trimmed;
  }
  return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
}

function withProviderOptionCurrentValue(
  descriptor: ProviderOptionDescriptor,
  rawValue: string | boolean | undefined,
): ProviderOptionDescriptor {
  if (descriptor.type === "boolean") {
    return typeof rawValue === "boolean" ? { ...descriptor, currentValue: rawValue } : descriptor;
  }
  const currentValue =
    typeof rawValue === "string"
      ? resolveDescriptorChoiceValue(descriptor, rawValue)
      : resolveDescriptorChoiceValue(descriptor, descriptor.currentValue);
  if (!currentValue) {
    const { currentValue: _currentValue, ...rest } = descriptor;
    return rest;
  }
  return { ...descriptor, currentValue };
}

function reasoningDescriptorId(provider: ProviderKind, caps: ModelCapabilities): string {
  if (provider === "claudeAgent") {
    return "effort";
  }
  if (provider === "kilo" || provider === "opencode") {
    return "variant";
  }
  if (provider === "gemini") {
    const values = caps.reasoningEffortLevels.map((option) => option.value);
    return values.length > 0 && values.every((value) => /^-?\d+$/u.test(value))
      ? "thinkingBudget"
      : "thinkingLevel";
  }
  if (provider === "pi") {
    return "thinkingLevel";
  }
  return "reasoningEffort";
}

function legacyCapabilityDescriptors(
  provider: ProviderKind,
  caps: ModelCapabilities,
): ProviderOptionDescriptor[] {
  const primaryOptions =
    provider === "kilo" || provider === "opencode"
      ? (caps.variantOptions ?? [])
      : caps.reasoningEffortLevels;
  const descriptors: ProviderOptionDescriptor[] = [];
  if (primaryOptions.length > 0) {
    const defaultPrimaryOption = primaryOptions.find((option) => option.isDefault);
    descriptors.push({
      id: reasoningDescriptorId(provider, caps),
      label: provider === "kilo" || provider === "opencode" ? "Variant" : "Reasoning",
      type: "select",
      options: primaryOptions.map((option) => ({
        id: option.value,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
        ...(option.isDefault ? { isDefault: true as const } : {}),
      })),
      ...(defaultPrimaryOption ? { currentValue: defaultPrimaryOption.value } : {}),
      ...(caps.promptInjectedEffortLevels.length > 0
        ? { promptInjectedValues: [...caps.promptInjectedEffortLevels] }
        : {}),
    });
  }
  if (caps.contextWindowOptions.length > 0) {
    const defaultContextWindowOption = caps.contextWindowOptions.find((option) => option.isDefault);
    descriptors.push({
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: caps.contextWindowOptions.map((option) => ({
        id: option.value,
        label: option.label,
        ...(option.isDefault ? { isDefault: true as const } : {}),
      })),
      ...(defaultContextWindowOption ? { currentValue: defaultContextWindowOption.value } : {}),
    });
  }
  if (caps.supportsFastMode) {
    descriptors.push({ id: "fastMode", label: "Fast Mode", type: "boolean" });
  }
  if (caps.supportsThinkingToggle) {
    descriptors.push({ id: "thinking", label: "Thinking", type: "boolean", currentValue: true });
  }
  return descriptors;
}

export function getProviderOptionDescriptors(input: {
  provider: ProviderKind;
  caps: ModelCapabilities;
  selections?: ProviderOptionSelectionsInput;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const descriptors =
    input.caps.optionDescriptors?.map(cloneProviderOptionDescriptor) ??
    legacyCapabilityDescriptors(input.provider, input.caps);
  return descriptors.map((descriptor) =>
    withProviderOptionCurrentValue(
      descriptor,
      getProviderOptionSelectionValue(input.selections, descriptor.id),
    ),
  );
}

export function getProviderOptionCurrentValue(
  descriptor: ProviderOptionDescriptor | null | undefined,
): string | boolean | undefined {
  if (!descriptor) {
    return undefined;
  }
  if (descriptor.type === "boolean") {
    return descriptor.currentValue;
  }
  return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
}

export function getProviderOptionCurrentLabel(
  descriptor: ProviderOptionDescriptor | null | undefined,
): string | undefined {
  const value = getProviderOptionCurrentValue(descriptor);
  if (!descriptor) {
    return undefined;
  }
  if (descriptor.type === "boolean") {
    return typeof value === "boolean" ? (value ? "On" : "Off") : undefined;
  }
  return typeof value === "string"
    ? descriptor.options.find((option) => option.id === value)?.label
    : undefined;
}

export function buildProviderOptionSelectionsFromDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined,
): ProviderOptionSelection[] | undefined {
  if (!descriptors || descriptors.length === 0) {
    return undefined;
  }
  const selections = descriptors.flatMap((descriptor) => {
    const value = getProviderOptionCurrentValue(descriptor);
    return typeof value === "string" || typeof value === "boolean"
      ? [{ id: descriptor.id, value }]
      : [];
  });
  return selections.length > 0 ? selections : undefined;
}

// ── Data-driven capability resolver ───────────────────────────────────

export function getModelCapabilities(
  provider: ProviderKind,
  model: string | null | undefined,
): ModelCapabilities {
  const slug = normalizeModelSlug(model, provider);
  if (slug && MODEL_CAPABILITIES_INDEX[provider]?.[slug]) {
    return MODEL_CAPABILITIES_INDEX[provider][slug];
  }
  if (provider === "gemini") {
    return geminiCapabilitiesForModel(slug ?? model, EMPTY_MODEL_CAPABILITIES);
  }
  return EMPTY_MODEL_CAPABILITIES;
}

export function isClaudeUltrathinkPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bultrathink\b/i.test(text);
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const providerScopedModel =
    provider === "claudeAgent" ? trimmed.replace(/\[[^\]]+\]$/u, "") : trimmed;
  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, ModelSlug>;
  const aliased = Object.prototype.hasOwnProperty.call(aliases, providerScopedModel)
    ? aliases[providerScopedModel]
    : undefined;
  return typeof aliased === "string" ? aliased : (providerScopedModel as ModelSlug);
}

export function resolveSelectableModel(
  provider: ProviderKind,
  value: string | null | undefined,
  options: ReadonlyArray<SelectableModelOption>,
): ModelSlug | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = options.find((option) => option.slug === trimmed);
  if (direct) {
    return direct.slug;
  }

  const byName = options.find((option) => option.name.toLowerCase() === trimmed.toLowerCase());
  if (byName) {
    return byName.slug;
  }

  const normalized = normalizeModelSlug(trimmed, provider);
  if (!normalized) {
    return null;
  }

  const resolved = options.find((option) => option.slug === normalized);
  return resolved ? resolved.slug : null;
}

export function resolveModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug | null {
  const normalized = normalizeModelSlug(model, provider);
  if (provider === "pi") {
    return normalized;
  }
  if (!normalized) {
    return DEFAULT_MODEL_BY_PROVIDER[provider];
  }

  return MODEL_SLUG_SET_BY_PROVIDER[provider].has(normalized)
    ? normalized
    : DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): ModelSlug | null {
  return resolveModelSlug(model, provider);
}

/** Trim a string, returning null for empty/missing values. */
export function trimOrNull<T extends string>(value: T | null | undefined): T | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim() as T;
  return trimmed || null;
}

export function normalizeCodexModelOptions(
  model: string | null | undefined,
  modelOptions: CodexModelOptions | null | undefined,
): CodexModelOptions | undefined {
  const caps = getModelCapabilities("codex", model);
  const defaultReasoningEffort = getDefaultEffort(caps) as CodexReasoningEffort;
  const reasoningEffort = trimOrNull(modelOptions?.reasoningEffort) ?? defaultReasoningEffort;
  const fastModeEnabled = modelOptions?.fastMode === true;
  const nextOptions: CodexModelOptions = {
    ...(reasoningEffort !== defaultReasoningEffort ? { reasoningEffort } : {}),
    ...(fastModeEnabled ? { fastMode: true } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeClaudeModelOptions(
  model: string | null | undefined,
  modelOptions: ClaudeModelOptions | null | undefined,
): ClaudeModelOptions | undefined {
  const caps = getModelCapabilities("claudeAgent", model);
  const defaultReasoningEffort = getDefaultEffort(caps);
  const defaultContextWindow = getDefaultContextWindow(caps);
  const resolvedEffort = trimOrNull(modelOptions?.effort);
  const resolvedContextWindow = trimOrNull(modelOptions?.contextWindow);
  const isPromptInjected = caps.promptInjectedEffortLevels.includes(resolvedEffort ?? "");
  const effort =
    resolvedEffort &&
    !isPromptInjected &&
    hasEffortLevel(caps, resolvedEffort) &&
    resolvedEffort !== defaultReasoningEffort
      ? resolvedEffort
      : undefined;
  const contextWindow =
    resolvedContextWindow &&
    hasContextWindowOption(caps, resolvedContextWindow) &&
    resolvedContextWindow !== defaultContextWindow
      ? resolvedContextWindow
      : undefined;
  const thinking =
    caps.supportsThinkingToggle && modelOptions?.thinking === false ? false : undefined;
  const fastMode = caps.supportsFastMode && modelOptions?.fastMode === true ? true : undefined;
  const nextOptions: ClaudeModelOptions = {
    ...(thinking === false ? { thinking: false } : {}),
    ...(effort ? { effort } : {}),
    ...(fastMode ? { fastMode: true } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function resolveApiModelId(modelSelection: ModelSelection): string {
  switch (modelSelection.provider) {
    case "claudeAgent": {
      const caps = getModelCapabilities(modelSelection.provider, modelSelection.model);
      return modelSelection.options?.contextWindow === "1m" && hasContextWindowOption(caps, "1m")
        ? `${modelSelection.model}[1m]`
        : modelSelection.model;
    }
    default:
      return modelSelection.model;
  }
}

export function normalizeGeminiModelOptions(
  model: string | null | undefined,
  modelOptions: GeminiModelOptions | null | undefined,
): GeminiModelOptions | undefined {
  const caps = getModelCapabilities("gemini", model);
  const effort = getGeminiThinkingSelectionValue(caps, modelOptions);
  if (!effort || !hasEffortLevel(caps, effort)) {
    return undefined;
  }
  const defaultEffort = getDefaultEffort(caps);
  const nextOptions = geminiModelOptionsFromEffortValue(effort);
  if (!nextOptions) {
    return undefined;
  }

  const normalizedEffort =
    nextOptions.thinkingLevel !== undefined
      ? nextOptions.thinkingLevel
      : String(nextOptions.thinkingBudget);
  if (normalizedEffort === defaultEffort) {
    return undefined;
  }

  return nextOptions;
}

export function normalizeGrokModelOptions(
  model: string | null | undefined,
  modelOptions: GrokModelOptions | null | undefined,
): GrokModelOptions | undefined {
  const caps = getModelCapabilities("grok", model);
  const reasoningEffort = trimOrNull(modelOptions?.reasoningEffort);
  if (!reasoningEffort || !hasEffortLevel(caps, reasoningEffort)) {
    return undefined;
  }
  if (reasoningEffort === getDefaultEffort(caps)) {
    return undefined;
  }
  return { reasoningEffort: reasoningEffort as GrokReasoningEffort };
}

export function normalizeDroidModelOptions(
  model: string | null | undefined,
  modelOptions: DroidModelOptions | null | undefined,
): DroidModelOptions | undefined {
  const caps = getModelCapabilities("droid", model);
  const reasoningEffort = trimOrNull(modelOptions?.reasoningEffort);
  if (!reasoningEffort || !hasEffortLevel(caps, reasoningEffort)) {
    return undefined;
  }
  if (reasoningEffort === getDefaultEffort(caps)) {
    return undefined;
  }
  return { reasoningEffort: reasoningEffort as DroidReasoningEffort };
}

export function normalizePiModelOptions(
  modelOptions: PiModelOptions | null | undefined,
): PiModelOptions | undefined {
  const thinkingLevel = trimOrNull(modelOptions?.thinkingLevel);
  return thinkingLevel && PI_THINKING_LEVEL_SET.has(thinkingLevel as PiThinkingLevel)
    ? { thinkingLevel: thinkingLevel as PiThinkingLevel }
    : undefined;
}

export function normalizeOpenCodeModelOptions(
  modelOptions: OpenCodeModelOptions | null | undefined,
): OpenCodeModelOptions | undefined {
  const variant = trimOrNull(modelOptions?.variant);
  const agent = trimOrNull(modelOptions?.agent);
  const nextOptions: OpenCodeModelOptions = {
    ...(variant ? { variant } : {}),
    ...(agent ? { agent } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeCursorModelOptions(
  modelOptions: CursorModelOptions | null | undefined,
): CursorModelOptions | undefined {
  const nextOptions: CursorModelOptions = {
    ...(modelOptions?.reasoningEffort ? { reasoningEffort: modelOptions.reasoningEffort } : {}),
    ...(modelOptions?.fastMode !== undefined ? { fastMode: modelOptions.fastMode } : {}),
    ...(modelOptions?.thinking !== undefined ? { thinking: modelOptions.thinking } : {}),
    ...(modelOptions?.contextWindow ? { contextWindow: modelOptions.contextWindow } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: ClaudeCodeEffort | null | undefined,
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (effort !== "ultrathink") {
    return trimmed;
  }
  if (trimmed.startsWith("Ultrathink:")) {
    return trimmed;
  }
  return `Ultrathink:\n${trimmed}`;
}
