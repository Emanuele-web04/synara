import type { ModelSelection } from "@synara/contracts";

export function resolveCodexServiceTier(
  modelSelection: ModelSelection | undefined,
): "fast" | "default" | undefined {
  if (modelSelection?.provider !== "codex" || modelSelection.options?.fastMode === undefined) {
    return undefined;
  }

  // Omitting the tier preserves Codex's previous value, including Fast mode.
  return modelSelection.options.fastMode ? "fast" : "default";
}
