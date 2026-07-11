// FILE: textGenerationCapabilities.ts
// Purpose: Keeps auxiliary text-generation routing aligned with the server's implemented drivers.
// Layer: Web provider capability helper

import type { ModelSelection, ProviderKind } from "@synara/contracts";

const TEXT_GENERATION_PROVIDERS = new Set<ProviderKind>([
  "codex",
  "claudeAgent",
  "cursor",
  "kilo",
  "opencode",
]);

export function supportsTextGeneration(provider: ProviderKind): boolean {
  return TEXT_GENERATION_PROVIDERS.has(provider);
}

// Recaps and automation-intent extraction should follow the active account when its
// driver supports one-shot generation. Unsupported chat drivers deliberately omit
// the override so the server can use the configured text-generation fallback.
export function resolveAuxiliaryTextGenerationSelection(input: {
  readonly provider: ProviderKind;
  readonly modelSelection: ModelSelection;
}): ModelSelection | null {
  return supportsTextGeneration(input.provider) ? input.modelSelection : null;
}
