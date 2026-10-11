import { describe, expect, it } from "vitest";

import {
  normalizeStarredModels,
  starredModelKey,
  toggleStarredModel,
  unstarModel,
  type StarredModel,
} from "~/lib/starredModels";
import {
  buildProviderTabRows,
  buildStarredModelOptionsPatch,
  buildStarredTabRows,
  modelPickerShortcutRowIndex,
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

describe("OMP picker rows", () => {
  it("does not reinterpret another provider's opaque role: model id", () => {
    const customOption = { slug: "role:custom", name: "Private Model", isCustom: true };
    expect(
      buildProviderTabRows({
        provider: "pi",
        instanceId: "pi_work",
        options: [customOption],
        query: "",
        selectedModel: "role:custom",
      })[0],
    ).toMatchObject({
      provider: "pi",
      instanceId: "pi_work",
      model: "role:custom",
      selectableModel: "role:custom",
      selected: true,
    });
  });

  it("selects the concrete catalog model on its own account without carrying role metadata", () => {
    const legacyOption = {
      slug: "upstream/catalog-model",
      name: "Catalog Model",
      upstreamProviderId: "upstream",
      upstreamProviderName: "Upstream",
      role: { name: "smol", model: "different/model", thinkingLevel: "high" },
    };
    expect(
      buildProviderTabRows({
        provider: "omp",
        instanceId: "omp_work",
        options: [legacyOption],
        query: "",
        selectedModel: "role:smol",
      }),
    ).toEqual([
      {
        key: "omp_work:upstream/catalog-model",
        provider: "omp",
        instanceId: "omp_work",
        model: "upstream/catalog-model",
        selectableModel: "upstream/catalog-model",
        name: "Catalog Model",
        detail: null,
        selected: false,
        groupLabel: "Upstream",
        preset: null,
      },
    ]);
  });

  it("marks stale starred role keys unavailable rather than ranking a replacement", () => {
    const role = {
      ...CODEX_HIGH_FAST,
      provider: "omp" as const,
      model: "role:smol",
      instanceId: "omp_work",
    };
    const customPlaceholder = { slug: "role:smol", name: "Role Smol", isCustom: true };
    const rows = buildStarredTabRows({
      starredModels: [role],
      modelOptionsFor: () => [
        customPlaceholder,
        { slug: "upstream/catalog-model", name: "Catalog Model" },
      ],
      query: "",
      current: { ...role, instanceId: "omp_work" },
      effortLevelsFor: () => [],
    });
    expect(rows[0]).toMatchObject({
      provider: "omp",
      instanceId: "omp_work",
      model: "role:smol",
      selectableModel: null,
      detail: "Unavailable",
      selected: false,
    });
    expect(
      buildProviderTabRows({
        provider: "omp",
        options: [customPlaceholder],
        query: "",
        selectedModel: "role:smol",
      })[0]?.selectableModel,
    ).toBeNull();
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
