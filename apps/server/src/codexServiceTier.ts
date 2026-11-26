import type { ModelSelection } from "@synara/contracts";

export function resolveCodexServiceTier(
  modelSelection: ModelSelection | undefined,
): "ultrafast" | "fast" | "default" | undefined {
  if (modelSelection?.provider !== "codex") return undefined;
  const { serviceTier, fastMode } = modelSelection.options ?? {};
  if (serviceTier === "ultrafast") return serviceTier;

  // An omitted tier preserves the current Codex speed.
  if (fastMode === undefined) return undefined;
  return fastMode ? "fast" : "default";
}
