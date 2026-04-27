// FILE: composerTraits.ts
// Purpose: Centralizes composer trait resolution so menu surfaces read the same model capability state.
// Layer: Chat composer state helpers
// Depends on: shared model capability helpers and provider model option types.

import {
  type ClaudeModelOptions,
  type CodexModelOptions,
  type CursorModelOptions,
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
  if (provider === "cursor") {
    return trimOrNull((modelOptions as CursorModelOptions | undefined)?.reasoningEffort);
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
  if (provider !== "claudeAgent" && provider !== "cursor") {
    return null;
  }
  return provider === "claudeAgent"
    ? trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.contextWindow)
    : trimOrNull((modelOptions as CursorModelOptions | undefined)?.contextWindow);
}

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
    ? provider === "cursor"
      ? ((modelOptions as CursorModelOptions | undefined)?.thinking ??
        getCursorBooleanModelParameter(model, "thinking") ??
        true)
      : ((modelOptions as ClaudeModelOptions | undefined)?.thinking ?? true)
    : null;

  const fastModeEnabled =
    caps.supportsFastMode &&
    ((modelOptions as { fastMode?: boolean } | undefined)?.fastMode ??
      (provider === "cursor" ? getCursorBooleanModelParameter(model, "fast") : false)) === true;

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
