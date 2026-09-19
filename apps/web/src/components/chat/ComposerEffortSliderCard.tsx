// FILE: ComposerEffortSliderCard.tsx
// Purpose: Slider-style effort control for the composer model picker's footer (fast toggle,
//   stacked effort/model label, reset, and a stepped slider).
// Layer: Chat composer presentation
// Depends on: shared trait resolution + effort-change planning, the trait commit hook,
//   and the shared Slider primitive.

import type { ProviderKind, ProviderModelDescriptor, ThreadId } from "@synara/contracts";

import { ResetIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { ProviderOptions } from "../../providerModelOptions";
import { Slider } from "../ui/slider";
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

type ComposerEffortSliderCardProps = {
  provider: ProviderKind;
  threadId: ThreadId;
  model: string | null | undefined;
  modelLabel: string;
  runtimeModel?: ProviderModelDescriptor | undefined;
  modelOptions: ProviderOptions | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
};

const CARD_ICON_BUTTON_CLASS_NAME =
  "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--color-border-focus)]/60 disabled:pointer-events-none disabled:opacity-35";

const MAX_FULLY_LABELLED_STOPS = 5;

// Effort ladder as a stepped slider. Every level the model exposes is one stop
// (including prompt-injected ones such as Ultrathink), so the ladder matches the
// radio menu exactly; changes commit immediately and keep the menu open so the label
// and thumb update in place.
export function ComposerEffortSliderCard(props: ComposerEffortSliderCardProps) {
  const { provider, threadId, model, modelOptions, prompt, onPromptChange } = props;
  const selection = getComposerTraitSelection(
    provider,
    model,
    prompt,
    modelOptions,
    props.runtimeModel,
  );
  const { effortLevels, defaultEffort, effort, fastModeEnabled, ultrathinkPromptControlled } =
    selection;
  const supportsFastMode = supportsComposerFastModeControl(selection);
  const commitTrait = useComposerTraitCommit({ threadId, provider, model, modelOptions });

  const ladderIndex = resolveComposerEffortLadderIndex(selection);
  const activeLevel = effortLevels[ladderIndex];
  const statusLabel = resolveComposerTraitStatusLabel(selection) ?? activeLevel?.label ?? "Effort";
  const effortIsDefault = ultrathinkPromptControlled || effort === defaultEffort;
  const canReset = fastModeEnabled || !effortIsDefault;

  const lastIndex = Math.max(effortLevels.length - 1, 0);
  // Long ladders would collide; they keep only the ends and the active stop labelled.
  const showsEveryStopLabel = effortLevels.length <= MAX_FULLY_LABELLED_STOPS;

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
            onToggle={() => commitTrait({ fastMode: !fastModeEnabled })}
          />
        ) : (
          <span aria-hidden="true" className="size-6" />
        )}
        <div className="flex min-w-0 flex-col items-center justify-center px-2 py-0.5 text-center leading-snug">
          <span className="whitespace-nowrap font-medium text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-accent)]">
            {statusLabel}
          </span>
          <span className="max-w-full truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
            {props.modelLabel}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Reset effort and speed"
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
            Reset to defaults
          </TooltipPopup>
        </Tooltip>
      </div>
      <div className="mt-1 px-0.5">
        <Slider
          value={ladderIndex}
          min={0}
          max={lastIndex}
          step={1}
          size="large"
          showStepMarks
          magnetic
          disabled={ultrathinkPromptControlled}
          aria-label="Reasoning effort"
          getAriaValueText={(index) => effortLevels[index]?.label ?? String(index)}
          onValueChange={handleSliderChange}
        />
        {/* Stop labels sit in the same inset rail as the slider's step marks, so each one
            lands under its dot. The end labels hug the edges instead of overhanging. */}
        {lastIndex > 0 ? (
          <div className="relative mx-2.5 mt-1 h-3.5">
            {effortLevels.map((level, index) => {
              const active = index === ladderIndex;
              if (!showsEveryStopLabel && !active && index !== 0 && index !== lastIndex) {
                return null;
              }
              return (
                <button
                  key={level.value}
                  type="button"
                  tabIndex={-1}
                  disabled={ultrathinkPromptControlled}
                  aria-label={`Set effort to ${level.label}`}
                  className={cn(
                    "absolute top-0 cursor-pointer whitespace-nowrap text-[length:var(--app-font-size-ui-xs,10px)] leading-3.5 transition-colors disabled:pointer-events-none",
                    index === 0 ? "-left-2" : index === lastIndex ? "-right-2" : "-translate-x-1/2",
                    active
                      ? "font-medium text-[var(--color-text-accent)]"
                      : "text-muted-foreground/70 hover:text-[var(--color-text-foreground)]",
                  )}
                  style={
                    index === 0 || index === lastIndex
                      ? undefined
                      : { left: `${(index / lastIndex) * 100}%` }
                  }
                  onClick={() => handleSliderChange(index)}
                >
                  {level.label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      {ultrathinkPromptControlled ? (
        <div className="px-1 pt-1 text-muted-foreground/80 text-xs">
          Remove Ultrathink from the prompt to change effort.
        </div>
      ) : null}
    </div>
  );
}
