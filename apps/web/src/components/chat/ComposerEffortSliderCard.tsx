// FILE: ComposerEffortSliderCard.tsx
// Purpose: Slider-style effort control for the composer model picker's footer (fast toggle,
//   effort label, reset, and a stepped slider).
// Layer: Chat composer presentation
// Depends on: shared trait resolution + effort-change planning, the trait commit hook,
<<<<<<< HEAD
//   and the shared Slider primitive.
||||||| parent of b5bf3af71 (feat(web): add composer model presets)
//   the shared Slider primitive, and menu submenu primitives for the model list.
=======
//   the shared Slider primitive, and the parent picker's model catalog navigation.
>>>>>>> b5bf3af71 (feat(web): add composer model presets)

<<<<<<< HEAD
import type {
  ProviderInstanceId,
  ProviderKind,
  ProviderModelDescriptor,
  ThreadId,
} from "@synara/contracts";
||||||| parent of b5bf3af71 (feat(web): add composer model presets)
import type { ProviderKind, ProviderModelDescriptor, ThreadId } from "@synara/contracts";
import { type ReactNode, useState } from "react";
=======
import type { ProviderKind, ProviderModelDescriptor, ThreadId } from "@synara/contracts";
>>>>>>> b5bf3af71 (feat(web): add composer model presets)

import { ResetIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { ProviderOptions } from "../../providerModelOptions";
<<<<<<< HEAD
||||||| parent of b5bf3af71 (feat(web): add composer model presets)
import { MenuSub, MenuSubTriggerBase } from "../ui/menu";
=======
import { MenuItem } from "../ui/menu";
>>>>>>> b5bf3af71 (feat(web): add composer model presets)
import { Slider } from "../ui/slider";
import type { FastModeNotice } from "~/lib/fastModeState";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getComposerTraitSelection,
  planComposerEffortChange,
  resolveComposerEffortLadderIndex,
  resolveComposerTraitStatusLabel,
  supportsComposerFastModeControl,
} from "./composerTraits";
import { FastModeToggle } from "./TraitsPicker";
import { useComposerTraitCommit } from "./useComposerTraitCommit";
import { useTranslation } from "~/i18n";

type ComposerEffortSliderCardProps = {
  provider: ProviderKind;
  providerInstanceId?: ProviderInstanceId | null | undefined;
  threadId: ThreadId;
  model: string | null | undefined;
  runtimeModel?: ProviderModelDescriptor | undefined;
  modelOptions: ProviderOptions | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
<<<<<<< HEAD
  fastModeNotice?: FastModeNotice | null | undefined;
||||||| parent of b5bf3af71 (feat(web): add composer model presets)
  // Renders the model-list submenu popup inside this card's MenuSub so the stacked
  // "effort / model" label is its trigger. A committed selection closes only the
  // model list, keeping the card open so the new model's effort can be set at once.
  renderModelSubmenuPopup: (onAfterSelection: () => void) => ReactNode;
=======
  onBrowseModels: () => void;
>>>>>>> b5bf3af71 (feat(web): add composer model presets)
};

const CARD_ICON_BUTTON_CLASS_NAME =
  "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--color-border-focus)]/60 disabled:pointer-events-none disabled:opacity-35";

// Effort ladder as a stepped slider. Every level the model exposes is one stop
// (including prompt-injected ones such as Ultrathink), so the ladder matches the
// radio menu exactly; changes commit immediately and keep the menu open so the label
// and thumb update in place.
export function ComposerEffortSliderCard(props: ComposerEffortSliderCardProps) {
  const { t } = useTranslation();

  const { provider, threadId, model, modelOptions, prompt, onPromptChange } = props;
  const selection = getComposerTraitSelection(
    provider,
    model,
    prompt,
    modelOptions,
    props.runtimeModel,
    t,
  );
  const { effortLevels, defaultEffort, effort, fastModeEnabled, ultrathinkPromptControlled } =
    selection;
  const supportsFastMode = supportsComposerFastModeControl(selection);
  const commitTrait = useComposerTraitCommit({
    threadId,
    provider,
    providerInstanceId: props.providerInstanceId,
    model,
    modelOptions,
  });

  const ladderIndex = resolveComposerEffortLadderIndex(selection);
  const activeLevel = effortLevels[ladderIndex];
  const statusLabel =
    resolveComposerTraitStatusLabel(selection, t) ??
    activeLevel?.label ??
    t("chat:traitsPicker_effort");
  const effortIsDefault = ultrathinkPromptControlled || effort === defaultEffort;
  const canReset = fastModeEnabled || !effortIsDefault;

  const lastIndex = Math.max(effortLevels.length - 1, 0);

  const handleSliderChange = (nextIndex: number) => {
    if (nextIndex === ladderIndex) return;
    const nextLevel = effortLevels[nextIndex];
    if (!nextLevel) return;
    const plan = planComposerEffortChange({ provider, selection, prompt, value: nextLevel.value });
    if (!plan) return;
    if (plan.kind === "prompt") {
      onPromptChange(plan.prompt);
      return;
    }
    commitTrait(plan.patch);
  };

  const handleReset = () => {
    const effortPlan =
      defaultEffort && !effortIsDefault
        ? planComposerEffortChange({ provider, selection, prompt, value: defaultEffort })
        : null;
    commitTrait({
      ...(effortPlan?.kind === "options" ? effortPlan.patch : {}),
      ...(fastModeEnabled ? { fastMode: false } : {}),
    });
  };

  return (
    <div className="px-1 pt-0.5 pb-1" data-slot="effort-slider-card">
      <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_1.5rem] items-center gap-1">
        {supportsFastMode ? (
          <FastModeToggle
            tone="accent"
            enabled={fastModeEnabled}
            notice={props.fastModeNotice}
            onToggle={() => commitTrait({ fastMode: !fastModeEnabled })}
          />
        ) : (
          <span aria-hidden="true" className="size-6" />
        )}
<<<<<<< HEAD
        <span className="truncate text-center font-medium text-ui text-[var(--color-text-accent)]">
          {statusLabel}
        </span>
||||||| parent of b5bf3af71 (feat(web): add composer model presets)
        <MenuSub open={modelListOpen} onOpenChange={setModelListOpen}>
          <MenuSubTriggerBase
            openOnHover={false}
            className="flex min-w-0 cursor-default select-none flex-col items-center justify-center rounded-lg px-2 py-0.5 text-center leading-snug outline-none transition-colors data-highlighted:bg-[var(--color-background-button-secondary-hover)] data-popup-open:bg-[var(--color-background-button-secondary-hover)]"
          >
            {/* The chevron hangs off the label's right edge so the effort text itself is
                centered over the model name instead of being pushed left by the glyph. */}
            <span className="relative inline-block whitespace-nowrap font-medium text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-accent)]">
              {statusLabel}
              <ChevronRightIcon
                aria-hidden="true"
                className="absolute top-1/2 left-full ml-0.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
            </span>
            <span className="max-w-full truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
              {props.modelLabel}
            </span>
          </MenuSubTriggerBase>
          {props.renderModelSubmenuPopup(() => setModelListOpen(false))}
        </MenuSub>
=======
        <MenuItem
          data-model-catalog-trigger=""
          closeOnClick={false}
          onClick={props.onBrowseModels}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              event.stopPropagation();
              props.onBrowseModels();
            }
          }}
          className="flex min-w-0 cursor-default select-none flex-col items-center justify-center gap-0 rounded-lg px-2 py-0.5 text-center leading-snug outline-none transition-colors hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:bg-[var(--color-background-button-secondary-hover)] data-highlighted:bg-transparent"
        >
          {/* The chevron hangs off the label's right edge so the effort text itself is
                centered over the model name instead of being pushed left by the glyph. */}
          <span className="relative inline-block whitespace-nowrap font-medium text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-accent)]">
            {statusLabel}
            <ChevronRightIcon
              aria-hidden="true"
              className="absolute top-1/2 left-full ml-0.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
          </span>
          <span className="max-w-full truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
            {props.modelLabel}
          </span>
        </MenuItem>
>>>>>>> b5bf3af71 (feat(web): add composer model presets)
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={t("chat:resetEffortAndSpeed")}
                disabled={!canReset}
                className={cn(
                  CARD_ICON_BUTTON_CLASS_NAME,
                  "text-muted-foreground/70 hover:text-[var(--color-text-foreground)]",
                )}
                onClick={handleReset}
              />
            }
          >
            <ResetIcon aria-hidden="true" className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top" variant="picker">
            {t("chat:resetToDefaults")}
          </TooltipPopup>
        </Tooltip>
      </div>
      <div className="mt-1.5 px-1">
        <Slider
          value={ladderIndex}
          min={0}
          max={lastIndex}
          step={1}
          size="large"
          showStepMarks
          magnetic
          disabled={ultrathinkPromptControlled}
          aria-label={t("chat:reasoningEffort")}
          getAriaValueText={(index) => effortLevels[index]?.label ?? String(index)}
          onValueChange={handleSliderChange}
        />
      </div>
      {ultrathinkPromptControlled ? (
        <div className="px-1 pt-1 text-muted-foreground/80 text-ui leading-snug">
          {t("chat:traitsPicker_removeUltrathink")}
        </div>
      ) : null}
    </div>
  );
}
