// FILE: composerTraits.ts
// Purpose: Centralizes composer trait resolution so menu surfaces read the same model capability state.
// Layer: Chat composer state helpers
// Depends on: shared model capability helpers and provider model option types.

import {
  type ProviderOptionDescriptor,
  type ProviderKind,
  type ProviderModelDescriptor,
} from "@synara/contracts";
import {
  applyClaudePromptEffortPrefix,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
  trimOrNull,
} from "@synara/shared/model";

import { buildProviderOptionPatch, type ProviderOptions } from "../../providerModelOptions";
import { getRuntimeAwareModelCapabilities } from "./runtimeModelCapabilities";
import { t } from "~/i18n";

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

function getCursorBooleanModelParameter(
  model: string | null | undefined,
  key: "fast" | "thinking",
): boolean | null {
  const slug = typeof model === "string" ? model.trim().toLowerCase() : "";
  const match = typeof model === "string" ? model.match(/\[([^\]]*)\]$/u) : null;
  if (!match?.[1]) {
    if (key === "fast" && slug.endsWith("-fast")) {
      return true;
    }
    if (key === "thinking" && slug.includes("-thinking")) {
      return true;
    }
    return null;
  }
  for (const part of match[1].split(",")) {
    const [rawKey, rawValue] = part.split("=");
    if (rawKey?.trim() !== key) {
      continue;
    }
    const value = rawValue?.trim().toLowerCase();
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
  }
  return null;
}

function asSelectDescriptor(
  descriptor: ProviderOptionDescriptor | undefined,
): Extract<ProviderOptionDescriptor, { type: "select" }> | null {
  return descriptor?.type === "select" ? descriptor : null;
}

function asBooleanDescriptor(
  descriptor: ProviderOptionDescriptor | undefined,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> | null {
  return descriptor?.type === "boolean" ? descriptor : null;
}

function primaryTraitSelectDescriptor(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): Extract<ProviderOptionDescriptor, { type: "select" }> | null {
  const descriptor = descriptors.find(
    (candidate): candidate is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      candidate.type === "select" &&
      candidate.id !== "contextWindow" &&
      candidate.id !== "autoCompactWindow",
  );
  return descriptor && descriptor.options.length > 1 ? descriptor : null;
}

function selectOptions(descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null) {
  return (
    descriptor?.options.map((option) => ({
      value: option.id,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      ...(option.isDefault ? { isDefault: true as const } : {}),
    })) ?? []
  );
}

// Merges legacy capability flags with descriptor-specific prompt injection hints.
function promptInjectedValuesForDescriptor(
  capsPromptInjectedValues: ReadonlyArray<string>,
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null,
) {
  return Array.from(
    new Set([...capsPromptInjectedValues, ...(descriptor?.promptInjectedValues ?? [])]),
  );
}

const EFFORT_LABEL_KEYS: Readonly<Record<string, string>> = {
  none: "chat:none",
  off: "automation:traitsPicker_off",
  minimal: "chat:effortMinimal",
  low: "chat:effortLow",
  medium: "chat:effortMedium",
  high: "chat:effortHigh",
  xhigh: "chat:effortExtraHigh",
  max: "chat:effortMax",
  ultra: "chat:effortUltra",
};

const TRAIT_LABEL_KEYS: Readonly<Record<string, string>> = {
  reasoningEffort: "chat:sessionStatus_reasoning",
  thinkingLevel: "chat:sessionStatus_reasoning",
  effort: "chat:sessionStatus_reasoning",
  variant: "chat:traitsPicker_variant",
  contextWindow: "chat:contextWindow",
  autoCompactWindow: "chat:traitAutoCompact",
  thinking: "chat:timeline_thinking",
  fastMode: "chat:fastMode",
};

// These adapters construct canonical effort labels from IDs, rather than forwarding
// arbitrary provider labels: ClaudeAdapter, CursorAcpSupport, PiAdapter,
// OmpAcpSupport, DevinAdapter, GrokAdapter, and AntigravityAdapter.
const GENERATED_EFFORT_LABEL_PROVIDERS = new Set<ProviderKind>([
  "claudeAgent",
  "cursor",
  "pi",
  "omp",
  "devin",
  "grok",
  "antigravity",
]);
const SOURCE_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};
const SOURCE_TRAIT_LABELS: Readonly<Record<string, string>> = {
  reasoningEffort: "Reasoning",
  thinkingLevel: "Reasoning",
  effort: "Reasoning",
  variant: "Variant",
  contextWindow: "Context Window",
  autoCompactWindow: "Auto-compact",
  thinking: "Thinking",
  fastMode: "Fast Mode",
};

// Localize Synara's standard presentation, including canonical labels built by
// its adapters. Explicit labels from other providers and custom overrides stay data.
function presentTraitDescriptor(
  descriptor: ProviderOptionDescriptor,
  provider: ProviderKind,
  runtimeModel: ProviderModelDescriptor | undefined,
  translate: typeof t,
): ProviderOptionDescriptor {
  const generatedDescriptor =
    (provider === "claudeAgent" || provider === "devin") &&
    SOURCE_TRAIT_LABELS[descriptor.id] === descriptor.label;
  if (runtimeModel?.optionDescriptors && !generatedDescriptor) return descriptor;
  const labelKey = TRAIT_LABEL_KEYS[descriptor.id];
  const label = labelKey ? translate(labelKey) : descriptor.label;
  if (descriptor.type !== "select") return { ...descriptor, label };
  const isContext = descriptor.id === "contextWindow" || descriptor.id === "autoCompactWindow";
  return {
    ...descriptor,
    label,
    options: descriptor.options.map((option) => {
      if (isContext) {
        if (descriptor.id === "contextWindow" && runtimeModel?.contextWindowOptions) return option;
        return option.id === "auto"
          ? { ...option, label: translate("chat:traitAutoClaudeCode") }
          : option;
      }
      const discovered = runtimeModel?.supportedReasoningEfforts?.find(
        (effort) => effort.value === option.id,
      );
      const explicitLabel =
        trimOrNull(discovered?.label) ?? (runtimeModel?.optionDescriptors ? option.label : null);
      const generatedLabel =
        GENERATED_EFFORT_LABEL_PROVIDERS.has(provider) &&
        (explicitLabel === SOURCE_EFFORT_LABELS[option.id] ||
          (option.id === "max" && explicitLabel === "Maximum"));
      const optionLabelKey =
        explicitLabel && !generatedLabel
          ? undefined
          : option.id === "max" && option.label === "Maximum"
            ? "chat:effortMaximum"
            : EFFORT_LABEL_KEYS[option.id];
      return {
        ...option,
        ...(optionLabelKey ? { label: translate(optionLabelKey) } : {}),
        ...(option.id === "ultracode" && option.description && !discovered?.description
          ? { description: translate("chat:effortUltracodeDescription") }
          : {}),
      };
    }),
  };
}

// Resolve the currently selected composer traits from capabilities plus draft overrides.
export function getComposerTraitSelection(
  provider: ProviderKind,
  model: string | null | undefined,
  prompt: string,
  modelOptions: ProviderOptions | null | undefined,
  runtimeModel?: ProviderModelDescriptor,
  translate: typeof t = t,
) {
  const caps = getRuntimeAwareModelCapabilities({ provider, model, runtimeModel });
  const descriptors = getProviderOptionDescriptors({
    provider,
    caps,
    selections: modelOptions as Record<string, unknown> | undefined,
  }).map((descriptor) => presentTraitDescriptor(descriptor, provider, runtimeModel, translate));
  const primarySelectDescriptor = primaryTraitSelectDescriptor(descriptors);
  const contextWindowDescriptor = asSelectDescriptor(
    descriptors.find((descriptor) => descriptor.id === "autoCompactWindow") ??
      descriptors.find((descriptor) => descriptor.id === "contextWindow"),
  );
  const fastModeDescriptor = asBooleanDescriptor(
    descriptors.find((descriptor) => descriptor.id === "fastMode"),
  );
  const thinkingDescriptor = asBooleanDescriptor(
    descriptors.find((descriptor) => descriptor.id === "thinking"),
  );
  const effortLevels = selectOptions(primarySelectDescriptor);
  const contextWindowOptions = selectOptions(contextWindowDescriptor);
  const defaultEffort =
    primarySelectDescriptor?.options.find((option) => option.isDefault)?.id ??
    primarySelectDescriptor?.options[0]?.id ??
    null;
  const defaultContextWindow =
    contextWindowDescriptor?.options.find((option) => option.isDefault)?.id ??
    contextWindowDescriptor?.options[0]?.id ??
    null;
  const resolvedEffort = trimOrNull(
    getProviderOptionCurrentValue(primarySelectDescriptor) as string | undefined,
  );
  const resolvedContextWindow = trimOrNull(
    getProviderOptionCurrentValue(contextWindowDescriptor) as string | undefined,
  );
  const promptInjectedValues = promptInjectedValuesForDescriptor(
    caps.promptInjectedEffortLevels,
    primarySelectDescriptor,
  );
  const isPromptInjected = resolvedEffort ? promptInjectedValues.includes(resolvedEffort) : false;
  const effort = resolvedEffort && !isPromptInjected ? resolvedEffort : defaultEffort;

  const thinkingEnabled = thinkingDescriptor
    ? provider === "cursor"
      ? (thinkingDescriptor.currentValue ??
        getCursorBooleanModelParameter(model, "thinking") ??
        true)
      : (thinkingDescriptor.currentValue ?? true)
    : null;

  const fastModeEnabled =
    Boolean(fastModeDescriptor) &&
    (fastModeDescriptor?.currentValue ??
      (provider === "cursor" ? getCursorBooleanModelParameter(model, "fast") : false)) === true;

  const contextWindow = resolvedContextWindow ?? defaultContextWindow;

  const ultrathinkPromptControlled =
    promptInjectedValues.length > 0 && isClaudeUltrathinkPrompt(prompt);

  return {
    caps,
    descriptors,
    primarySelectDescriptor,
    fastModeDescriptor,
    thinkingDescriptor,
    contextWindowDescriptor,
    promptInjectedValues,
    defaultEffort,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
  };
}

/** Resolved composer trait state; the single shape every trait surface reads. */
export type ComposerTraitSelection = ReturnType<typeof getComposerTraitSelection>;

// Human label for the currently selected reasoning/thinking trait, shared by the
// composer trigger and any surface that summarizes a thread's model selection.
export function resolveComposerTraitStatusLabel(
  selection: Pick<
    ReturnType<typeof getComposerTraitSelection>,
    "effort" | "effortLevels" | "thinkingEnabled" | "ultrathinkPromptControlled"
  >,
  translate: typeof t = t,
): string | null {
  if (selection.ultrathinkPromptControlled) {
    return "Ultrathink";
  }
  const effortLabel = selection.effort
    ? (selection.effortLevels.find((level) => level.value === selection.effort)?.label ??
      selection.effort)
    : null;
  if (effortLabel) {
    return effortLabel;
  }
  return selection.thinkingEnabled !== null
    ? translate(selection.thinkingEnabled ? "chat:thinkingEnabled" : "chat:thinkingDisabled")
    : null;
}

// A model exposes a speed control either through an explicit descriptor or the
// legacy capability flag; every surface must agree on that test.
export function supportsComposerFastModeControl(
  selection: Pick<ReturnType<typeof getComposerTraitSelection>, "caps" | "fastModeDescriptor">,
): boolean {
  return selection.fastModeDescriptor !== null || selection.caps.supportsFastMode;
}

// Fast mode is only worth surfacing when the model exposes the control and it is on.
export function showsComposerFastModeBadge(
  selection: Pick<
    ReturnType<typeof getComposerTraitSelection>,
    "caps" | "fastModeDescriptor" | "fastModeEnabled"
  >,
): boolean {
  return supportsComposerFastModeControl(selection) && selection.fastModeEnabled;
}

export function hasVisibleComposerTraitControls(
  selection: Pick<
    ReturnType<typeof getComposerTraitSelection>,
    "caps" | "effortLevels" | "thinkingEnabled" | "contextWindowOptions" | "fastModeDescriptor"
  >,
  options?: {
    includeFastMode?: boolean;
    // Off when another surface (the effort slider card) already owns the effort ladder.
    includeEffort?: boolean;
  },
): boolean {
  return (
    ((options?.includeEffort ?? true) && selection.effortLevels.length > 0) ||
    selection.thinkingEnabled !== null ||
    selection.contextWindowOptions.length > 1 ||
    ((options?.includeFastMode ?? true) && supportsComposerFastModeControl(selection))
  );
}

// Persisted option key for the primary effort ladder when the descriptor is missing.
function fallbackEffortOptionId(provider: ProviderKind): string {
  if (provider === "opencode") return "variant";
  if (provider === "pi" || provider === "omp") return "thinkingLevel";
  if (provider === "claudeAgent") return "effort";
  return "reasoningEffort";
}

export type ComposerEffortChangePlan =
  // Prompt-injected levels (Claude Ultrathink) rewrite the prompt instead of the options.
  | { readonly kind: "prompt"; readonly prompt: string }
  | { readonly kind: "options"; readonly patch: Record<string, unknown> };

// Single decision point for "the user picked effort X": every effort surface
// (radio menu, slider) turns its choice into the same prompt rewrite or option
// patch here, so ultrathink handling and option ids can never drift apart.
// Returns null when the change must be ignored (locked by the prompt, unknown value).
export function planComposerEffortChange(input: {
  provider: ProviderKind;
  selection: Pick<
    ReturnType<typeof getComposerTraitSelection>,
    | "effortLevels"
    | "promptInjectedValues"
    | "primarySelectDescriptor"
    | "ultrathinkPromptControlled"
  >;
  prompt: string;
  value: string;
}): ComposerEffortChangePlan | null {
  const { provider, selection, prompt, value } = input;
  if (selection.ultrathinkPromptControlled) return null;
  if (!value) return null;
  const nextOption = selection.effortLevels.find((option) => option.value === value);
  if (!nextOption) return null;
  if (selection.promptInjectedValues.includes(nextOption.value)) {
    return {
      kind: "prompt",
      prompt:
        prompt.trim().length === 0
          ? ULTRATHINK_PROMPT_PREFIX
          : applyClaudePromptEffortPrefix(prompt, "ultrathink"),
    };
  }
  const optionId = selection.primarySelectDescriptor?.id ?? fallbackEffortOptionId(provider);
  return { kind: "options", patch: buildProviderOptionPatch(provider, optionId, nextOption.value) };
}

// Keyboard cycling changes persisted effort only. Prompt-injected levels belong
// to explicit prompt edits, and an existing Ultrathink prefix keeps its lock.
export function planComposerEffortCycle(input: {
  provider: ProviderKind;
  selection: ComposerTraitSelection;
  prompt: string;
}): ComposerEffortChangePlan | null {
  const { selection } = input;
  if (selection.ultrathinkPromptControlled) return null;
  const levels = selection.effortLevels.filter(
    (level) => !selection.promptInjectedValues.includes(level.value),
  );
  if (levels.length < 2) return null;
  const currentIndex = levels.findIndex((level) => level.value === selection.effort);
  const nextLevel = levels[(currentIndex + 1) % levels.length];
  return nextLevel ? planComposerEffortChange({ ...input, value: nextLevel.value }) : null;
}

// Index of the effort the slider thumb should rest on. While Ultrathink is
// pinned by the prompt the resolved `effort` falls back to the default, so the
// thumb follows the prompt-injected level instead when the ladder exposes it.
export function resolveComposerEffortLadderIndex(
  selection: Pick<
    ReturnType<typeof getComposerTraitSelection>,
    "effort" | "effortLevels" | "promptInjectedValues" | "ultrathinkPromptControlled"
  >,
): number {
  if (selection.ultrathinkPromptControlled) {
    const injectedIndex = selection.effortLevels.findIndex((level) =>
      selection.promptInjectedValues.includes(level.value),
    );
    if (injectedIndex >= 0) return injectedIndex;
  }
  const index = selection.effortLevels.findIndex((level) => level.value === selection.effort);
  return index >= 0 ? index : 0;
}
