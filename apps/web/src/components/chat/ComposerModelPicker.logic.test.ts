import { describe, expect, it } from "vitest";

import {
  normalizeStarredModels,
  starredModelKey,
  toggleStarredModel,
  unstarModel,
  type StarredModel,
} from "~/lib/starredModels";
import {
  buildStarredModelOptionsPatch,
  buildStarredTabRows,
  modelPickerShortcutRowIndex,
  resolveStarredTraits,
  starredTraitsMatch,
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

  it("keeps one star per model + traits combination", () => {
    const lowEffort = { ...CODEX_HIGH_FAST, effort: "low" };
    const both = toggleStarredModel(toggleStarredModel([], CODEX_HIGH_FAST), lowEffort);
    expect(both.map(starredModelKey)).toEqual([
      starredModelKey(CODEX_HIGH_FAST),
      starredModelKey(lowEffort),
    ]);
    expect(toggleStarredModel(both, CODEX_HIGH_FAST)).toEqual([lowEffort]);
  });

  it("unstars every preset of a model and keeps the provider's other models", () => {
    const lowEffort = { ...CODEX_HIGH_FAST, effort: "low" };
    const otherModel = { ...CODEX_HIGH_FAST, model: "gpt-5.4" };
    expect(unstarModel([CODEX_HIGH_FAST, otherModel, lowEffort], CODEX_HIGH_FAST)).toEqual([
      otherModel,
    ]);
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

describe("account-scoped starred presets", () => {
  const WORK_HIGH_FAST: StarredModel = { ...CODEX_HIGH_FAST, instanceId: "codex_work" };

  it("stars the same model and traits separately per account", () => {
    const both = toggleStarredModel(toggleStarredModel([], CODEX_HIGH_FAST), WORK_HIGH_FAST);
    expect(both).toEqual([CODEX_HIGH_FAST, WORK_HIGH_FAST]);
    expect(unstarModel(both, WORK_HIGH_FAST)).toEqual([CODEX_HIGH_FAST]);
  });

  it("stores the default account implicitly so older presets keep their meaning", () => {
    expect(normalizeStarredModels([{ ...CODEX_HIGH_FAST, instanceId: "codex" }])).toEqual([
      CODEX_HIGH_FAST,
    ]);
    expect(starredModelKey({ ...CODEX_HIGH_FAST, instanceId: "codex" })).toBe(
      starredModelKey(CODEX_HIGH_FAST),
    );
  });

  it("builds starred rows from each account's catalog and labels non-default accounts", () => {
    const rows = buildStarredTabRows({
      starredModels: [CODEX_HIGH_FAST, WORK_HIGH_FAST],
      modelOptionsFor: (_provider, instanceId) =>
        instanceId === "codex_work"
          ? [{ slug: "gpt-5.5", name: "GPT-5.5 (work)" }]
          : [{ slug: "gpt-5.5", name: "GPT-5.5" }],
      accountLabelFor: (instanceId) => (instanceId === "codex_work" ? "Work" : undefined),
      query: "",
      current: {
        provider: "codex",
        instanceId: "codex_work",
        model: "gpt-5.5",
        effort: "high",
        fastMode: true,
        thinking: null,
      },
      effortLevelsFor: () => [],
    });

    expect(rows.map((row) => [row.instanceId, row.name, row.selected])).toEqual([
      [undefined, "GPT-5.5", false],
      ["codex_work", "GPT-5.5 (work)", true],
    ]);
    expect(rows[1]?.detail?.startsWith("Work")).toBe(true);
  });
});

describe("starred Devin Fusion presets", () => {
  const FUSION_RUNTIME_MODEL = {
    slug: "fusion",
    name: "Fusion",
    modelVariants: [
      {
        model: "fusion-claude-fable-5-1-high-sidekick-swe-2-medium",
        label: "Fusion (Claude Fable 5.1 High + SWE-2 Medium)",
      },
      {
        model: "fusion-gpt-6-sol-xhigh-sidekick-glm-5-2",
        label: "Fusion (GPT-6 Sol Extra High Thinking + GLM-5.2)",
      },
    ],
  };
  const FUSION_PRESET: StarredModel = {
    provider: "devin",
    model: "fusion",
    effort: null,
    fastMode: null,
    thinking: null,
    modelVariant: "fusion-gpt-6-sol-xhigh-sidekick-glm-5-2",
    variantLabel: "GPT-6 Sol Extra High Thinking + GLM-5.2",
  };

  it("pins the concrete pairing UID instead of generic traits", () => {
    const selection = getComposerTraitSelection(
      "devin",
      "fusion",
      "",
      { modelVariant: "fusion-gpt-6-sol-xhigh-sidekick-glm-5-2" },
      FUSION_RUNTIME_MODEL,
    );
    expect(resolveStarredTraits(selection)).toEqual({
      effort: null,
      fastMode: null,
      thinking: null,
      modelVariant: "fusion-gpt-6-sol-xhigh-sidekick-glm-5-2",
      variantLabel: "GPT-6 Sol Extra High Thinking + GLM-5.2",
    });
  });

  it("keys presets by variant so different pairings stay distinct", () => {
    const otherPairing: StarredModel = {
      ...FUSION_PRESET,
      modelVariant: "fusion-claude-fable-5-1-high-sidekick-swe-2-medium",
      variantLabel: "Claude Fable 5.1 High + SWE-2 Medium",
    };
    const both = toggleStarredModel(toggleStarredModel([], FUSION_PRESET), otherPairing);
    expect(both).toHaveLength(2);
    expect(toggleStarredModel(both, FUSION_PRESET)).toEqual([otherPairing]);
  });

  it("restores the pairing through modelVariant and clears competing traits", () => {
    const selection = getComposerTraitSelection(
      "devin",
      "fusion",
      "",
      undefined,
      FUSION_RUNTIME_MODEL,
    );
    expect(
      buildStarredModelOptionsPatch({
        provider: "devin",
        selection,
        starred: FUSION_PRESET,
      }),
    ).toEqual({
      modelVariant: "fusion-gpt-6-sol-xhigh-sidekick-glm-5-2",
      reasoningEffort: undefined,
      fastMode: undefined,
      thinking: undefined,
      contextWindow: undefined,
    });
  });

  it("does not count a preset as current while a different pairing is pinned", () => {
    expect(
      starredTraitsMatch(FUSION_PRESET, {
        effort: null,
        fastMode: null,
        thinking: null,
        modelVariant: "fusion-claude-fable-5-1-high-sidekick-swe-2-medium",
      }),
    ).toBe(false);
    expect(
      starredTraitsMatch(FUSION_PRESET, {
        effort: null,
        fastMode: null,
        thinking: null,
        modelVariant: "fusion-gpt-6-sol-xhigh-sidekick-glm-5-2",
      }),
    ).toBe(true);
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
