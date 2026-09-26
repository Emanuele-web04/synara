// FILE: ComposerModelPicker.logic.ts
// Purpose: Pure helpers turning composer trait state into starred presets and back.
// Layer: Chat composer state helpers
// Depends on: composer trait resolution and the starred model storage shape.

import type { ModelSlug, ProviderKind } from "@synara/contracts";
import { resolveSelectableModel } from "@synara/shared/model";

import { type StarredModel, starredModelKey } from "~/lib/starredModels";
import {
  formatProviderModelOptionName,
  groupProviderModelOptions,
  type ProviderModelOption,
} from "../../providerModelOptions";
import {
  type getComposerTraitSelection,
  planComposerEffortChange,
  supportsComposerFastModeControl,
} from "./composerTraits";

type ComposerTraitSelection = ReturnType<typeof getComposerTraitSelection>;

/** Tab id of the starred presets list; every other tab id is a provider kind. */
export const STARRED_TAB = "starred";
export type ComposerModelPickerTab = typeof STARRED_TAB | ProviderKind;

/** Marks the open picker so global mod+digit handlers (thread jump) yield to its rows. */
export const MODEL_PICKER_POPUP_ATTRIBUTE = "data-model-picker-popup";

export function isModelPickerShortcutScopeActive(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector(`[${MODEL_PICKER_POPUP_ATTRIBUTE}]`) !== null
  );
}

/** Rows beyond this index get no ⌘N hint. */
export const MODEL_PICKER_SHORTCUT_ROW_LIMIT = 9;

// Snapshot the traits a star should restore. Controls the model does not expose stay
// `null` so applying the preset never invents an option the provider would reject.
export function resolveStarredTraits(
  selection: Pick<
    ComposerTraitSelection,
    | "caps"
    | "effort"
    | "effortLevels"
    | "fastModeDescriptor"
    | "fastModeEnabled"
    | "thinkingEnabled"
  >,
): Pick<StarredModel, "effort" | "fastMode" | "thinking"> {
  return {
    effort: selection.effortLevels.length > 0 ? selection.effort : null,
    fastMode: supportsComposerFastModeControl(selection) ? selection.fastModeEnabled : null,
    thinking: selection.thinkingEnabled,
  };
}

// Option patch that restores a preset's traits on its model. `selection` must be the
// target model's trait selection so option ids and supported levels come from it.
export function buildStarredModelOptionsPatch(input: {
  provider: ProviderKind;
  selection: ComposerTraitSelection;
  starred: Pick<StarredModel, "effort" | "fastMode" | "thinking">;
}): Record<string, unknown> {
  const { provider, selection, starred } = input;
  const patch: Record<string, unknown> = {};
  if (starred.effort !== null) {
    const plan = planComposerEffortChange({
      provider,
      // A preset is applied independently of the prompt's Ultrathink lock.
      selection: { ...selection, ultrathinkPromptControlled: false },
      prompt: "",
      value: starred.effort,
    });
    if (plan?.kind === "options") {
      Object.assign(patch, plan.patch);
    }
  }
  if (starred.fastMode !== null && supportsComposerFastModeControl(selection)) {
    patch.fastMode = starred.fastMode;
  }
  if (starred.thinking !== null && selection.thinkingEnabled !== null) {
    patch.thinking = starred.thinking;
  }
  return patch;
}

// "High · Fast" style summary of a preset, labelled through the target model's ladder.
export function formatStarredTraitsLabel(
  starred: Pick<StarredModel, "effort" | "fastMode" | "thinking">,
  effortLevels: ComposerTraitSelection["effortLevels"],
): string {
  const effortLabel =
    starred.effort !== null
      ? (effortLevels.find((level) => level.value === starred.effort)?.label ?? starred.effort)
      : null;
  return [
    effortLabel,
    effortLabel === null && starred.thinking !== null
      ? `Thinking ${starred.thinking ? "On" : "Off"}`
      : null,
    starred.fastMode ? "Fast" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

// A preset counts as "current" when every trait it pins matches the composer's.
export function starredTraitsMatch(
  starred: Pick<StarredModel, "effort" | "fastMode" | "thinking">,
  current: Pick<StarredModel, "effort" | "fastMode" | "thinking">,
): boolean {
  return (
    (starred.effort === null || starred.effort === current.effort) &&
    (starred.fastMode === null || starred.fastMode === current.fastMode) &&
    (starred.thinking === null || starred.thinking === current.thinking)
  );
}

// One row of the picker list, already resolved to what selecting it commits.
export type ComposerModelPickerRow = {
  key: string;
  provider: ProviderKind;
  model: string;
  selectableModel: ModelSlug | null;
  name: string;
  /** Muted text after the name: the trait summary of a starred preset. */
  detail: string | null;
  selected: boolean;
  groupLabel: string | null;
  /** Present on starred rows: the preset to restore and to un-star. */
  preset: StarredModel | null;
};

export function buildProviderTabRows(input: {
  provider: ProviderKind;
  options: ReadonlyArray<ProviderModelOption>;
  query: string;
  selectedModel: string | null;
}): ComposerModelPickerRow[] {
  const { provider, query } = input;
  const filteredOptions =
    query.length > 0
      ? input.options.filter((option) =>
          // Descriptions are not shown, so they must not produce invisible matches.
          [option.name, option.slug, option.upstreamProviderName, option.upstreamProviderId]
            .join(" ")
            .toLowerCase()
            .includes(query),
        )
      : input.options;
  return groupProviderModelOptions(filteredOptions).flatMap((group) =>
    group.options.map((option) => ({
      key: `${provider}:${option.slug}`,
      provider,
      model: option.slug,
      selectableModel: option.slug,
      name: option.name,
      detail: null,
      selected: option.slug === input.selectedModel,
      groupLabel: group.label,
      preset: null,
    })),
  );
}

export function buildStarredTabRows(input: {
  starredModels: ReadonlyArray<StarredModel>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  query: string;
  current: { provider: ProviderKind; model: string } & Pick<
    StarredModel,
    "effort" | "fastMode" | "thinking"
  >;
  effortLevelsFor: (
    provider: ProviderKind,
    model: string,
  ) => ComposerTraitSelection["effortLevels"];
}): ComposerModelPickerRow[] {
  return input.starredModels.flatMap((entry) => {
    const options = input.modelOptionsByProvider[entry.provider];
    const selectableModel = resolveSelectableModel(entry.provider, entry.model, options);
    const name =
      options.find((option) => option.slug === selectableModel)?.name ??
      formatProviderModelOptionName({ provider: entry.provider, slug: entry.model });
    if (
      input.query.length > 0 &&
      !`${name} ${entry.model} ${entry.provider}`.toLowerCase().includes(input.query)
    ) {
      return [];
    }
    const traitsLabel = formatStarredTraitsLabel(
      entry,
      input.effortLevelsFor(entry.provider, entry.model),
    );
    return [
      {
        key: starredModelKey(entry),
        provider: entry.provider,
        model: entry.model,
        selectableModel,
        name,
        detail: selectableModel === null ? "Unavailable" : traitsLabel || null,
        selected:
          selectableModel !== null &&
          entry.provider === input.current.provider &&
          selectableModel === input.current.model &&
          starredTraitsMatch(entry, input.current),
        groupLabel: null,
        preset: entry,
      },
    ];
  });
}

// Index (0-based) of the picker row a mod+digit chord addresses, or null.
export function modelPickerShortcutRowIndex(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): number | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null;
  if (!/^[1-9]$/u.test(event.key)) return null;
  return Number(event.key) - 1;
}
