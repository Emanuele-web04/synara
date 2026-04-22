// FILE: runtimeModelCapabilities.ts
// Purpose: Bridges runtime-discovered model metadata into composer capabilities without replacing static defaults wholesale.
// Layer: Chat composer helpers
// Exports: runtime model lookup and Codex capability overrides derived from provider discovery responses.

import type {
  EffortOption,
  ModelCapabilities,
  ProviderKind,
  ProviderModelDescriptor,
} from "@t3tools/contracts";
import {
  getDefaultEffort,
  getModelCapabilities,
  normalizeModelSlug,
  trimOrNull,
} from "@t3tools/shared/model";

function runtimeEffortLabel(value: string): string {
  switch (value) {
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra High";
    default:
      return value;
  }
}

// Matches the selected model to its runtime descriptor after provider-specific normalization.
export function resolveRuntimeModelDescriptor(input: {
  provider: ProviderKind;
  model: string | null | undefined;
  runtimeModels: ReadonlyArray<ProviderModelDescriptor> | null | undefined;
}): ProviderModelDescriptor | undefined {
  const { provider, model, runtimeModels } = input;
  if (!runtimeModels?.length) {
    return undefined;
  }

  const normalizedModel = normalizeModelSlug(model, provider) ?? trimOrNull(model);
  if (!normalizedModel) {
    return undefined;
  }

  return runtimeModels.find((candidate) => {
    const normalizedCandidate = normalizeModelSlug(candidate.slug, provider) ?? candidate.slug;
    return normalizedCandidate === normalizedModel;
  });
}

// Reuses static capability flags but lets Codex effort menus follow runtime-discovered support/defaults.
export function getRuntimeAwareModelCapabilities(input: {
  provider: ProviderKind;
  model: string | null | undefined;
  runtimeModel?: ProviderModelDescriptor | undefined;
}): ModelCapabilities {
  const staticCapabilities = getModelCapabilities(input.provider, input.model);
  const runtimeEfforts = input.runtimeModel?.supportedReasoningEfforts;
  if (input.provider !== "codex" || !runtimeEfforts || runtimeEfforts.length === 0) {
    return staticCapabilities;
  }

  const staticDefaultEffort = getDefaultEffort(staticCapabilities);
  const runtimeDefaultEffort =
    trimOrNull(input.runtimeModel?.defaultReasoningEffort) ??
    (staticDefaultEffort && runtimeEfforts.some((effort) => effort.value === staticDefaultEffort)
      ? staticDefaultEffort
      : null);

  const reasoningEffortLevels: EffortOption[] = runtimeEfforts.map((effort) => {
    const nextEffort = {
      value: effort.value,
      label: runtimeEffortLabel(effort.value),
    } satisfies Pick<EffortOption, "value" | "label">;
    const description = trimOrNull(effort.description ?? effort.label);
    return Object.assign(
      nextEffort,
      description ? { description } : {},
      effort.value === runtimeDefaultEffort ? ({ isDefault: true } as const) : {},
    );
  });

  return {
    ...staticCapabilities,
    reasoningEffortLevels,
  };
}
