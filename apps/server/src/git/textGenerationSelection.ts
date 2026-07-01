import type { ModelSelection, ProviderKind, ProviderStartOptions } from "@t3tools/contracts";

export interface TextGenerationProviderInput {
  readonly modelSelection: ModelSelection;
  readonly providerOptions?: ProviderStartOptions;
  readonly codexHomePath?: string;
}

export function hasDedicatedTextGenerationProvider(provider: ProviderKind | undefined): boolean {
  return (
    provider === "claudeAgent" ||
    provider === "codex" ||
    provider === "cursor" ||
    provider === "kilo" ||
    provider === "opencode"
  );
}

function providerFromStartOptions(
  providerOptions: ProviderStartOptions | undefined,
): ProviderKind | undefined {
  if (providerOptions?.claudeAgent) return "claudeAgent";
  if (providerOptions?.codex) return "codex";
  if (providerOptions?.cursor) return "cursor";
  if (providerOptions?.kilo) return "kilo";
  if (providerOptions?.opencode) return "opencode";
  return undefined;
}

export function resolveTextGenerationInputForSelection(
  modelSelection: ModelSelection | undefined,
  providerOptions: ProviderStartOptions | undefined,
  provider?: ProviderKind | undefined,
): TextGenerationProviderInput | null {
  const resolvedProvider = provider ?? providerFromStartOptions(providerOptions);
  if (!modelSelection || !hasDedicatedTextGenerationProvider(resolvedProvider)) {
    return null;
  }

  if (resolvedProvider === "codex") {
    return {
      modelSelection,
      ...(providerOptions ? { providerOptions } : {}),
      ...(providerOptions?.codex?.homePath
        ? { codexHomePath: providerOptions.codex.homePath }
        : {}),
    };
  }

  return {
    modelSelection,
    ...(providerOptions ? { providerOptions } : {}),
  };
}
