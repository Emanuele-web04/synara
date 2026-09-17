import { describe, expect, it } from "vitest";

import {
  normalizeStarredModels,
  starredModelKey,
  toggleStarredModel,
  type StarredModel,
} from "~/lib/starredModels";
import {
  buildStarredModelOptionsPatch,
  formatStarredTraitsLabel,
  modelPickerShortcutRowIndex,
  resolveStarredTraits,
} from "./ComposerModelPicker.logic";
import { getComposerTraitSelection } from "./composerTraits";

const CODEX_HIGH_FAST: StarredModel = {
  provider: "codex",
  model: "gpt-5.5",
  effort: "high",
  fastMode: true,
  thinking: null,
};

describe("starred model presets", () => {
  it("snapshots the traits currently resolved for a model", () => {
    const selection = getComposerTraitSelection("codex", "gpt-5.5", "", {
      reasoningEffort: "high",
      fastMode: true,
    });
    expect(resolveStarredTraits(selection)).toEqual({
      effort: "high",
      fastMode: true,
      thinking: null,
    });
  });

  it("round-trips a preset back into a provider option patch", () => {
    const selection = getComposerTraitSelection("codex", "gpt-5.5", "", undefined);
    expect(
      buildStarredModelOptionsPatch({ provider: "codex", selection, starred: CODEX_HIGH_FAST }),
    ).toEqual({ reasoningEffort: "high", fastMode: true });
  });

  it("skips traits the target model does not expose", () => {
    const selection = getComposerTraitSelection("codex", "gpt-5.5", "", undefined);
    expect(
      buildStarredModelOptionsPatch({
        provider: "codex",
        selection,
        starred: { effort: "not-a-level", fastMode: null, thinking: false },
      }),
    ).toEqual({});
  });

  it("labels a preset through the model's effort ladder", () => {
    const { effortLevels } = getComposerTraitSelection("codex", "gpt-5.5", "", undefined);
    expect(formatStarredTraitsLabel(CODEX_HIGH_FAST, effortLevels)).toBe("High · Fast");
    expect(
      formatStarredTraitsLabel({ effort: null, fastMode: null, thinking: null }, effortLevels),
    ).toBe("");
  });

  it("keeps one star per model + traits combination", () => {
    const lowEffort = { ...CODEX_HIGH_FAST, effort: "low" };
    const both = toggleStarredModel(toggleStarredModel([], CODEX_HIGH_FAST), lowEffort);
    expect(both.map(starredModelKey)).toEqual([
      starredModelKey(CODEX_HIGH_FAST),
      starredModelKey(lowEffort),
    ]);
    expect(toggleStarredModel(both, CODEX_HIGH_FAST)).toEqual([lowEffort]);
  });

  it("drops stored entries for unknown providers and duplicates", () => {
    expect(
      normalizeStarredModels([
        CODEX_HIGH_FAST,
        CODEX_HIGH_FAST,
        { ...CODEX_HIGH_FAST, provider: "retired-provider" },
      ]),
    ).toEqual([CODEX_HIGH_FAST]);
  });
});

describe("modelPickerShortcutRowIndex", () => {
  const base = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

  it("maps mod+digit to a zero-based row", () => {
    expect(modelPickerShortcutRowIndex({ ...base, key: "1", metaKey: true })).toBe(0);
    expect(modelPickerShortcutRowIndex({ ...base, key: "9", ctrlKey: true })).toBe(8);
  });

  it("ignores bare digits and other chords", () => {
    expect(modelPickerShortcutRowIndex({ ...base, key: "1" })).toBeNull();
    expect(modelPickerShortcutRowIndex({ ...base, key: "0", metaKey: true })).toBeNull();
    expect(
      modelPickerShortcutRowIndex({ ...base, key: "2", metaKey: true, altKey: true }),
    ).toBeNull();
  });
});
