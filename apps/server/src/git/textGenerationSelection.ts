import type { ModelSelection, ProviderKind, ProviderStartOptions } from "@t3tools/contracts";

export interface TextGenerationProviderInput {
  readonly modelSelection: ModelSelection;
  readonly providerOptions?: ProviderStartOptions;
  readonly codexHomePath?: string;
}

export function hasDedicatedTextGenerationProvider(provider: ProviderKind | undefined): boolean {
  return (
    provider === "codex" || provider === "cursor" || provider === "kilo" || provider === "opencode"
  );
}

export function resolveTextGenerationInputForSelection(
  modelSelection: ModelSelection | undefined,
  providerOptions: ProviderStartOptions | undefined,
): TextGenerationProviderInput | null {
  if (!modelSelection || !hasDedicatedTextGenerationProvider(modelSelection.provider)) {
    return null;
  }

  if (modelSelection.provider === "codex") {
    return {
      modelSelection,
      ...(providerOptions ? { providerOptions } : {}),
      ...(providerOptions?.codex?.homePath ? { codexHomePath: providerOptions.codex.homePath } : {}),
    };
  }

  return {
    modelSelection,
    ...(providerOptions ? { providerOptions } : {}),
  };
}
