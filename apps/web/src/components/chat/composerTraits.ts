// FILE: composerTraits.ts
// Purpose: Centralizes composer trait resolution so menu surfaces read the same model capability state.
// Layer: Chat composer state helpers
// Depends on: shared model capability helpers and provider model option types.

import {
  type ClaudeModelOptions,
  type CodexModelOptions,
  type GeminiModelOptions,
  type OpenCodeModelOptions,
  type ProviderKind,
  type ProviderModelDescriptor,
} from "@t3tools/contracts";
import {
  getDefaultEffort,
  getDefaultContextWindow,
  getGeminiThinkingSelectionValue,
  getModelCapabilities,
  hasEffortLevel,
  hasContextWindowOption,
  isClaudeUltrathinkPrompt,
  resolveLabeledOptionValue,
  trimOrNull,
} from "@t3tools/shared/model";

import type { ProviderOptions } from "../../providerModelOptions";
import { getRuntimeAwareModelCapabilities } from "./runtimeModelCapabilities";

function getRawEffort(
  provider: ProviderKind,
  model: string | null | undefined,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  if (provider === "codex") {
    return trimOrNull((modelOptions as CodexModelOptions | undefined)?.reasoningEffort);
  }
  if (provider === "claudeAgent") {
    return trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.effort);
  }
  if (provider === "opencode") {
    return trimOrNull((modelOptions as OpenCodeModelOptions | undefined)?.variant);
  }
  const caps = getModelCapabilities(provider, model);
  return getGeminiThinkingSelectionValue(caps, modelOptions as GeminiModelOptions | undefined);
}

function getRawContextWindow(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  if (provider !== "claudeAgent") {
    return null;
  }
  return trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.contextWindow);
}

// Resolve the currently selected composer traits from capabilities plus draft overrides.
export function getComposerTraitSelection(
  provider: ProviderKind,
  model: string | null | undefined,
  prompt: string,
  modelOptions: ProviderOptions | null | undefined,
  runtimeModel?: ProviderModelDescriptor,
) {
  const caps = getRuntimeAwareModelCapabilities({ provider, model, runtimeModel });
  const effortLevels =
    provider === "opencode" ? (caps.variantOptions ?? []) : caps.reasoningEffortLevels;
  const defaultEffort =
    provider === "opencode"
      ? resolveLabeledOptionValue(caps.variantOptions, null)
      : getDefaultEffort(caps);
  const defaultContextWindow = getDefaultContextWindow(caps);
  const resolvedContextWindow = getRawContextWindow(provider, modelOptions);
  const resolvedEffort = getRawEffort(provider, model, modelOptions);
  const isPromptInjected = resolvedEffort
    ? caps.promptInjectedEffortLevels.includes(resolvedEffort)
    : false;
  const effort =
    provider === "opencode"
      ? resolveLabeledOptionValue(caps.variantOptions, resolvedEffort)
      : resolvedEffort && !isPromptInjected && hasEffortLevel(caps, resolvedEffort)
        ? resolvedEffort
        : defaultEffort && hasEffortLevel(caps, defaultEffort)
          ? defaultEffort
          : null;

  const thinkingEnabled = caps.supportsThinkingToggle
    ? ((modelOptions as ClaudeModelOptions | undefined)?.thinking ?? true)
    : null;

  const fastModeEnabled =
    caps.supportsFastMode &&
    (modelOptions as { fastMode?: boolean } | undefined)?.fastMode === true;

  const contextWindowOptions = caps.contextWindowOptions;
  const contextWindow =
    resolvedContextWindow && hasContextWindowOption(caps, resolvedContextWindow)
      ? resolvedContextWindow
      : defaultContextWindow;

  const ultrathinkPromptControlled =
    caps.promptInjectedEffortLevels.length > 0 && isClaudeUltrathinkPrompt(prompt);

  return {
    caps,
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

export function hasVisibleComposerTraitControls(
  selection: Pick<
    ReturnType<typeof getComposerTraitSelection>,
    "caps" | "effortLevels" | "thinkingEnabled" | "contextWindowOptions"
  >,
  options?: {
    includeFastMode?: boolean;
  },
): boolean {
  return (
    selection.effortLevels.length > 0 ||
    selection.thinkingEnabled !== null ||
    selection.contextWindowOptions.length > 1 ||
    ((options?.includeFastMode ?? true) && selection.caps.supportsFastMode)
  );
}
