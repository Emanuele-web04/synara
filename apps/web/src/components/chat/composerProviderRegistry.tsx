import {
  type ModelSlug,
  type ProviderKind,
  type ProviderModelOptions,
  type ThreadId,
} from "@t3tools/contracts";
import {
  getModelCapabilities,
  isClaudeUltrathinkPrompt,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  trimOrNull,
  getDefaultEffort,
  hasEffortLevel,
} from "@t3tools/shared/model";
import type { ReactNode } from "react";
import { TraitsMenuContent, TraitsPicker } from "./TraitsPicker";

export type ComposerProviderStateInput = {
  provider: ProviderKind;
  model: ModelSlug;
  prompt: string;
  modelOptions: ProviderModelOptions | null | undefined;
};

export type ComposerProviderState = {
  provider: ProviderKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ProviderModelOptions[ProviderKind] | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type ProviderRegistryEntry = {
  getState: (input: ComposerProviderStateInput) => ComposerProviderState;
  renderTraitsMenuContent: (input: {
    threadId: ThreadId;
    model: ModelSlug;
    modelOptions: ProviderModelOptions[ProviderKind] | undefined;
    prompt: string;
    includeFastMode?: boolean;
    onPromptChange: (prompt: string) => void;
  }) => ReactNode;
  renderTraitsPicker: (input: {
    threadId: ThreadId;
    model: ModelSlug;
    modelOptions: ProviderModelOptions[ProviderKind] | undefined;
    prompt: string;
    includeFastMode?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    shortcutLabel?: string | null;
    onPromptChange: (prompt: string) => void;
  }) => ReactNode;
};

function getProviderStateFromCapabilities(
  input: ComposerProviderStateInput,
): ComposerProviderState {
  const { provider, model, prompt, modelOptions } = input;
  const caps = getModelCapabilities(provider, model);
  const providerOptions = modelOptions?.[provider];

  // Resolve effort
  const rawEffort = providerOptions
    ? "effort" in providerOptions
      ? providerOptions.effort
      : "reasoningEffort" in providerOptions
        ? providerOptions.reasoningEffort
        : null
    : null;

  const draftEffort = trimOrNull(rawEffort);
  const defaultEffort = getDefaultEffort(caps);
  const isPromptInjected = draftEffort
    ? caps.promptInjectedEffortLevels.includes(draftEffort)
    : false;
  const promptEffort =
    draftEffort && !isPromptInjected && hasEffortLevel(caps, draftEffort)
      ? draftEffort
      : defaultEffort && hasEffortLevel(caps, defaultEffort)
        ? defaultEffort
        : null;

  // Normalize options for dispatch
  const normalizedOptions =
    provider === "codex"
      ? normalizeCodexModelOptions(model, providerOptions)
      : normalizeClaudeModelOptions(model, providerOptions);

  // Ultrathink styling (driven by capabilities data, not provider identity)
  const ultrathinkActive =
    caps.promptInjectedEffortLevels.length > 0 && isClaudeUltrathinkPrompt(prompt);

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: normalizedOptions,
    ...(ultrathinkActive ? { composerFrameClassName: "ultrathink-frame" } : {}),
    ...(ultrathinkActive
      ? { composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset]" }
      : {}),
    ...(ultrathinkActive ? { modelPickerIconClassName: "ultrathink-chroma" } : {}),
  };
}

const composerProviderRegistry: Record<ProviderKind, ProviderRegistryEntry> = {
  codex: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({
      threadId,
      model,
      modelOptions,
      prompt,
      includeFastMode,
      onPromptChange,
    }) => (
      <TraitsMenuContent
        provider="codex"
        threadId={threadId}
        model={model}
        modelOptions={modelOptions}
        prompt={prompt}
        {...(includeFastMode === undefined ? {} : { includeFastMode })}
        onPromptChange={onPromptChange}
      />
    ),
    renderTraitsPicker: ({
      threadId,
      model,
      modelOptions,
      prompt,
      includeFastMode,
      open,
      onOpenChange,
      shortcutLabel,
      onPromptChange,
    }) => (
      <TraitsPicker
        provider="codex"
        threadId={threadId}
        model={model}
        modelOptions={modelOptions}
        prompt={prompt}
        {...(open !== undefined ? { open } : {})}
        {...(onOpenChange ? { onOpenChange } : {})}
        {...(shortcutLabel !== undefined ? { shortcutLabel } : {})}
        {...(includeFastMode === undefined ? {} : { includeFastMode })}
        onPromptChange={onPromptChange}
      />
    ),
  },
  claudeAgent: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({
      threadId,
      model,
      modelOptions,
      prompt,
      includeFastMode,
      onPromptChange,
    }) => (
      <TraitsMenuContent
        provider="claudeAgent"
        threadId={threadId}
        model={model}
        modelOptions={modelOptions}
        prompt={prompt}
        {...(includeFastMode === undefined ? {} : { includeFastMode })}
        onPromptChange={onPromptChange}
      />
    ),
    renderTraitsPicker: ({
      threadId,
      model,
      modelOptions,
      prompt,
      includeFastMode,
      open,
      onOpenChange,
      shortcutLabel,
      onPromptChange,
    }) => (
      <TraitsPicker
        provider="claudeAgent"
        threadId={threadId}
        model={model}
        modelOptions={modelOptions}
        prompt={prompt}
        {...(open !== undefined ? { open } : {})}
        {...(onOpenChange ? { onOpenChange } : {})}
        {...(shortcutLabel !== undefined ? { shortcutLabel } : {})}
        {...(includeFastMode === undefined ? {} : { includeFastMode })}
        onPromptChange={onPromptChange}
      />
    ),
  },
};

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  return composerProviderRegistry[input.provider].getState(input);
}

export function renderProviderTraitsMenuContent(input: {
  provider: ProviderKind;
  threadId: ThreadId;
  model: ModelSlug;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  includeFastMode?: boolean;
  onPromptChange: (prompt: string) => void;
}): ReactNode {
  return composerProviderRegistry[input.provider].renderTraitsMenuContent(
    input.includeFastMode === undefined
      ? {
          threadId: input.threadId,
          model: input.model,
          modelOptions: input.modelOptions,
          prompt: input.prompt,
          onPromptChange: input.onPromptChange,
        }
      : {
          threadId: input.threadId,
          model: input.model,
          modelOptions: input.modelOptions,
          prompt: input.prompt,
          includeFastMode: input.includeFastMode,
          onPromptChange: input.onPromptChange,
        },
  );
}

export function renderProviderTraitsPicker(input: {
  provider: ProviderKind;
  threadId: ThreadId;
  model: ModelSlug;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  includeFastMode?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  shortcutLabel?: string | null;
  onPromptChange: (prompt: string) => void;
}): ReactNode {
  return composerProviderRegistry[input.provider].renderTraitsPicker(
    input.includeFastMode === undefined
      ? {
          threadId: input.threadId,
          model: input.model,
          modelOptions: input.modelOptions,
          prompt: input.prompt,
          ...(input.open !== undefined ? { open: input.open } : {}),
          ...(input.onOpenChange ? { onOpenChange: input.onOpenChange } : {}),
          ...(input.shortcutLabel !== undefined ? { shortcutLabel: input.shortcutLabel } : {}),
          onPromptChange: input.onPromptChange,
        }
      : {
          threadId: input.threadId,
          model: input.model,
          modelOptions: input.modelOptions,
          prompt: input.prompt,
          includeFastMode: input.includeFastMode,
          ...(input.open !== undefined ? { open: input.open } : {}),
          ...(input.onOpenChange ? { onOpenChange: input.onOpenChange } : {}),
          ...(input.shortcutLabel !== undefined ? { shortcutLabel: input.shortcutLabel } : {}),
          onPromptChange: input.onPromptChange,
        },
  );
}
