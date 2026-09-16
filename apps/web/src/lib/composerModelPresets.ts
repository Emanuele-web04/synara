// FILE: composerModelPresets.ts
// Purpose: Versioned, provider-scoped model + reasoning presets; never stores prompt content.
// Layer: Web preferences. Model-only favourites keep their existing keys and cycle behavior.

import { ProviderKind, TrimmedNonEmptyString } from "@synara/contracts";
import * as Schema from "effect/Schema";

export const COMPOSER_MODEL_PRESETS_STORAGE_KEY = "synara:composer-model-presets:v1";

export const ComposerModelPresetSchema = Schema.Struct({
  provider: ProviderKind,
  model: TrimmedNonEmptyString,
  reasoning: Schema.NullOr(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("effort"),
        optionId: TrimmedNonEmptyString,
        value: TrimmedNonEmptyString,
        label: TrimmedNonEmptyString,
      }),
      Schema.Struct({ kind: Schema.Literal("thinking"), value: Schema.Boolean }),
    ]),
  ),
});
export const ComposerModelPresetsSchema = Schema.Array(ComposerModelPresetSchema);
export type ComposerModelPreset = typeof ComposerModelPresetSchema.Type;
export const EMPTY_COMPOSER_MODEL_PRESETS: ReadonlyArray<ComposerModelPreset> = [];

export function composerModelPresetKey(preset: ComposerModelPreset): string {
  return JSON.stringify([
    preset.provider,
    preset.model,
    preset.reasoning?.kind ?? null,
    preset.reasoning?.kind === "effort" ? preset.reasoning.optionId : null,
    preset.reasoning?.value ?? null,
  ]);
}

export function normalizeComposerModelPresets(
  presets: ReadonlyArray<ComposerModelPreset>,
): ComposerModelPreset[] {
  const seen = new Set<string>();
  return presets.filter((preset) => {
    const key = composerModelPresetKey(preset);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function toggleComposerModelPreset(
  presets: ReadonlyArray<ComposerModelPreset>,
  preset: ComposerModelPreset,
): ComposerModelPreset[] {
  const normalized = normalizeComposerModelPresets(presets);
  const key = composerModelPresetKey(preset);
  return normalized.some((entry) => composerModelPresetKey(entry) === key)
    ? normalized.filter((entry) => composerModelPresetKey(entry) !== key)
    : [...normalized, preset];
}

export function composerModelPresetReasoningLabel(preset: ComposerModelPreset): string | null {
  if (!preset.reasoning) return null;
  return preset.reasoning.kind === "effort"
    ? preset.reasoning.label
    : `Thinking ${preset.reasoning.value ? "On" : "Off"}`;
}
