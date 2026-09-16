// FILE: composerModelPresetSelection.ts
// Purpose: Capture and validate exact reasoning presets against the live model's capabilities.
// Layer: Composer selection planning; callers commit only after runtime-mode persistence succeeds.

import type { ProviderKind, ProviderModelDescriptor } from "@synara/contracts";
import type { ComposerModelPreset } from "../../lib/composerModelPresets";
import { buildProviderOptionPatch, type ProviderModelOption } from "../../providerModelOptions";
import { getComposerTraitSelection, planComposerEffortChange } from "./composerTraits";

export function captureComposerModelPreset(input: {
  provider: ProviderKind;
  model: string;
  selection: ReturnType<typeof getComposerTraitSelection>;
}): ComposerModelPreset {
  const { provider, model, selection } = input;
  const level = selection.ultrathinkPromptControlled
    ? selection.effortLevels.find((entry) => selection.promptInjectedValues.includes(entry.value))
    : selection.effortLevels.find((entry) => entry.value === selection.effort);
  return {
    provider,
    model,
    reasoning:
      level && selection.primarySelectDescriptor
        ? {
            kind: "effort",
            optionId: selection.primarySelectDescriptor.id,
            value: level.value,
            label: level.label,
          }
        : selection.thinkingEnabled !== null
          ? { kind: "thinking", value: selection.thinkingEnabled }
          : null,
  };
}

export type ComposerModelPresetPlan =
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; patch?: Record<string, unknown>; prompt?: string };

export function planComposerModelPreset(input: {
  preset: ComposerModelPreset;
  lockedProvider: ProviderKind | null;
  availableModels: ReadonlyArray<ProviderModelOption>;
  providerAvailable: boolean;
  loading?: boolean;
  runtimeModel?: ProviderModelDescriptor | undefined;
  prompt: string;
}): ComposerModelPresetPlan {
  const { preset } = input;
  if (input.lockedProvider !== null && input.lockedProvider !== preset.provider) {
    return { kind: "unavailable", reason: "This chat uses a different provider." };
  }
  if (!input.providerAvailable) {
    return { kind: "unavailable", reason: "Provider unavailable." };
  }
  if (input.loading) {
    return { kind: "unavailable", reason: "Checking available models…" };
  }
  // An absent preset stays saved, but must never fall back to another model.
  if (!input.availableModels.some((option) => option.slug === preset.model)) {
    return { kind: "unavailable", reason: "Model no longer available." };
  }
  if (!preset.reasoning) return { kind: "ready" };
  const selection = getComposerTraitSelection(
    preset.provider,
    preset.model,
    input.prompt,
    undefined,
    input.runtimeModel,
  );
  if (preset.reasoning.kind === "thinking") {
    return selection.thinkingDescriptor
      ? {
          kind: "ready",
          patch: buildProviderOptionPatch(preset.provider, "thinking", preset.reasoning.value),
        }
      : { kind: "unavailable", reason: "Thinking is no longer supported." };
  }
  if (
    selection.primarySelectDescriptor?.id !== preset.reasoning.optionId ||
    !selection.effortLevels.some((level) => level.value === preset.reasoning?.value)
  ) {
    return { kind: "unavailable", reason: "Saved effort is no longer supported." };
  }
  if (selection.ultrathinkPromptControlled) {
    return selection.promptInjectedValues.includes(preset.reasoning.value)
      ? { kind: "ready" }
      : { kind: "unavailable", reason: "Remove Ultrathink from the prompt to change effort." };
  }
  const effortPlan = planComposerEffortChange({
    provider: preset.provider,
    selection,
    prompt: input.prompt,
    value: preset.reasoning.value,
  });
  if (!effortPlan) {
    return { kind: "unavailable", reason: "Saved effort is no longer supported." };
  }
  return effortPlan.kind === "prompt"
    ? { kind: "ready", prompt: effortPlan.prompt }
    : { kind: "ready", patch: effortPlan.patch };
}
