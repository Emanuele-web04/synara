import type { ProviderKind, ProviderModelDescriptor } from "@synara/contracts";
import { getModelCapabilities, hasEffortLevel, trimOrNull } from "@synara/shared/model";

export type CodexReasoningEffortSupport = "supported" | "unsupported" | "unknown";

// runtime discovery is authoritative when present; before it arrives known static models validate built-in efforts and unknown models stay open to forward-compatible values
export function classifyProviderReasoningEffortSupport(input: {
  provider: ProviderKind;
  model: string | null | undefined;
  effort: string | null | undefined;
  runtimeModel?: ProviderModelDescriptor | undefined;
}): CodexReasoningEffortSupport {
  const effort = trimOrNull(input.effort);
  if (!effort) {
    return "unsupported";
  }

  const runtimeEfforts = input.runtimeModel?.supportedReasoningEfforts;
  if (runtimeEfforts && runtimeEfforts.length > 0) {
    return runtimeEfforts.some((candidate) => candidate.value === effort)
      ? "supported"
      : "unsupported";
  }

  const staticCapabilities = getModelCapabilities(input.provider, input.model);
  if (staticCapabilities.reasoningEffortLevels.length === 0) {
    return "unknown";
  }
  return hasEffortLevel(staticCapabilities, effort) ? "supported" : "unsupported";
}

export function classifyCodexReasoningEffortSupport(
  input: Omit<Parameters<typeof classifyProviderReasoningEffortSupport>[0], "provider">,
): CodexReasoningEffortSupport {
  return classifyProviderReasoningEffortSupport({ ...input, provider: "codex" });
}
