import { ProviderKind } from "@synara/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  COMPOSER_MODEL_PRESETS_STORAGE_KEY,
  ComposerModelPresetsSchema,
  composerModelPresetKey,
  composerModelPresetReasoningLabel,
  normalizeComposerModelPresets,
  toggleComposerModelPreset,
  type ComposerModelPreset,
} from "./composerModelPresets";
import { FAVORITE_MODEL_STORAGE_KEYS } from "./modelFavorites";

const PRESET: ComposerModelPreset = {
  provider: "codex",
  model: "gpt-5.5",
  reasoning: { kind: "effort", optionId: "reasoningEffort", value: "xhigh", label: "Extra High" },
};

describe("composer model presets", () => {
  it.each(ProviderKind.literals)(
    "round trips %s without sharing its legacy favourites key",
    (provider) => {
      const presets = [{ ...PRESET, provider }];
      const codec = Schema.fromJsonString(ComposerModelPresetsSchema);
      expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(presets))).toEqual(presets);
      expect(COMPOSER_MODEL_PRESETS_STORAGE_KEY).not.toBe(FAVORITE_MODEL_STORAGE_KEYS[provider]);
    },
  );

  it("deduplicates exact configurations, not models or labels", () => {
    const high: ComposerModelPreset = {
      ...PRESET,
      reasoning: { kind: "effort", optionId: "reasoningEffort", value: "high", label: "High" },
    };
    const relabelled: ComposerModelPreset = {
      ...PRESET,
      reasoning: {
        kind: "effort",
        optionId: "reasoningEffort",
        value: "xhigh",
        label: "Very High",
      },
    };
    const otherProvider = { ...PRESET, provider: "cursor" as const };
    expect(normalizeComposerModelPresets([PRESET, high, relabelled, otherProvider])).toEqual([
      PRESET,
      high,
      otherProvider,
    ]);
    expect(composerModelPresetKey(PRESET)).toBe(composerModelPresetKey(relabelled));
    expect(toggleComposerModelPreset([PRESET, high, PRESET], PRESET)).toEqual([high]);
    expect(toggleComposerModelPreset([high], PRESET)).toEqual([high, PRESET]);
  });

  it("supports model-only and thinking presets without conflating off with absent", () => {
    const modelOnly = { ...PRESET, reasoning: null };
    const thinkingOff: ComposerModelPreset = {
      ...PRESET,
      reasoning: { kind: "thinking", value: false },
    };
    expect(composerModelPresetKey(thinkingOff)).not.toBe(composerModelPresetKey(modelOnly));
    expect(composerModelPresetReasoningLabel(modelOnly)).toBeNull();
    expect(composerModelPresetReasoningLabel(thinkingOff)).toBe("Thinking Off");
    expect(composerModelPresetReasoningLabel(PRESET)).toBe("Extra High");
  });

  it.each([
    "not json",
    "{}",
    '[{"provider":"missing","model":"x","reasoning":null}]',
    '[{"provider":"codex","model":" ","reasoning":null}]',
    '[{"provider":"codex","model":"x","reasoning":{"kind":"thinking","value":"true"}}]',
  ])("rejects malformed stored data: %s", (raw) => {
    expect(() =>
      Schema.decodeSync(Schema.fromJsonString(ComposerModelPresetsSchema))(raw),
    ).toThrow();
  });

  it("retains an explicitly empty list and works without browser storage", () => {
    expect(Schema.decodeSync(Schema.fromJsonString(ComposerModelPresetsSchema))("[]")).toEqual([]);
    expect(toggleComposerModelPreset([], PRESET)).toEqual([PRESET]);
  });
});
