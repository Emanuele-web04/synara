// FILE: composerPromptEnhance.ts
// Purpose: Resolve model + call server.enhancePrompt for composer draft rewriting.
// Layer: Web composer orchestration helper

import type {
  ModelSelection,
  ProviderStartOptions,
  ServerEnhancePromptInput,
  ServerEnhancePromptResult,
} from "@t3tools/contracts";

type EnhancePrompt = (input: ServerEnhancePromptInput) => Promise<ServerEnhancePromptResult>;

const TEXT_GENERATION_PROVIDERS = new Set(["codex", "cursor", "kilo", "opencode"]);

export function resolvePromptEnhanceModelSelection(input: {
  readonly composerModelSelection: ModelSelection;
  readonly fallbackModelSelection: ModelSelection;
}): ModelSelection {
  if (TEXT_GENERATION_PROVIDERS.has(input.composerModelSelection.provider)) {
    return input.composerModelSelection;
  }
  return input.fallbackModelSelection;
}

export async function enhanceComposerPrompt(input: {
  readonly cwd: string;
  readonly prompt: string;
  readonly enhancePrompt: EnhancePrompt;
  readonly composerModelSelection: ModelSelection;
  readonly fallbackModelSelection: ModelSelection;
  readonly providerOptions?: ProviderStartOptions;
  readonly systemPrompt?: string;
}): Promise<string> {
  const textGenerationModelSelection = resolvePromptEnhanceModelSelection({
    composerModelSelection: input.composerModelSelection,
    fallbackModelSelection: input.fallbackModelSelection,
  });

  const result = await input.enhancePrompt({
    cwd: input.cwd,
    prompt: input.prompt,
    textGenerationModelSelection,
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
  });

  return result.enhancedPrompt.trim();
}
