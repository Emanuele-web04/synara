// FILE: composerTraits.ts
// Purpose: Centralizes composer trait resolution so menu surfaces read the same model capability state.
// Layer: Chat composer state helpers
// Depends on: shared model capability helpers and provider model option types.

import {
  type ClaudeModelOptions,
  type CodexModelOptions,
  type ProviderKind,
} from "@t3tools/contracts";
import {
  getDefaultEffort,
  getDefaultContextWindow,
  getModelCapabilities,
  hasEffortLevel,
  hasContextWindowOption,
  isClaudeUltrathinkPrompt,
  trimOrNull,
} from "@t3tools/shared/model";

import type { ProviderOptions } from "../../providerModelOptions";

function getRawEffort(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  if (provider === "codex") {
    return trimOrNull((modelOptions as CodexModelOptions | undefined)?.reasoningEffort);
  }
  return trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.effort);
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
) {
  const caps = getModelCapabilities(provider, model);
  const effortLevels = caps.reasoningEffortLevels;
  const defaultEffort = getDefaultEffort(caps);
  const defaultContextWindow = getDefaultContextWindow(caps);
  const resolvedEffort = getRawEffort(provider, modelOptions);
  const resolvedContextWindow = getRawContextWindow(provider, modelOptions);
  const isPromptInjected = resolvedEffort
    ? caps.promptInjectedEffortLevels.includes(resolvedEffort)
    : false;
  const effort =
    resolvedEffort && !isPromptInjected && hasEffortLevel(caps, resolvedEffort)
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
