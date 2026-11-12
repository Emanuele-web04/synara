// FILE: ComposerChoiceRow.tsx
// Purpose: Shared list-style choice row (leading number chip + label + description, inline
// or stacked under the label, + optional trailing affordance) used by both composer decision cards —
// the pending-approval card and the AskUserQuestion card — so approvals and questions
// read as one coherent set of Codex-style list controls instead of drifting apart.
// Layer: Chat composer UI
// Exports: ComposerChoiceRow, ComposerChoiceTone

import { type ReactNode } from "react";
import { cn } from "~/lib/utils";

/** Semantic accent for a choice row. `neutral` reads like a plain list control;
 *  `primary` nudges the recommended action; `destructive` marks a rejecting action. */
export type ComposerChoiceTone = "neutral" | "primary" | "destructive";

interface ComposerChoiceRowProps {
  /** 1-based shortcut number shown in the leading chip; `null` hides the chip. */
  shortcut: number | null;
  label: string;
  description?: string | null;
  /** Neutral "chosen" state (single/multi select) — filled chip + persistent fill. */
  selected?: boolean;
  tone?: ComposerChoiceTone;
  disabled?: boolean;
  /** Trailing affordance, e.g. a check icon on the selected option. */
  trailing?: ReactNode;
  /** Small tag after the label, e.g. "Recommended". Rendered by the `stacked` layout. */
  badge?: ReactNode;
  /** `inline` puts the description after the label (approval cards). `stacked` drops it
   *  under the label at a smaller size, so chip, label and description wrap on one lane. */
  layout?: "inline" | "stacked";
  onSelect: () => void;
}

const ROW_TONE_CLASS_NAME: Record<ComposerChoiceTone, string> = {
  neutral: "hover:bg-[var(--color-background-button-secondary-hover)]",
  primary: "hover:bg-[var(--color-background-button-secondary-hover)]",
  destructive:
    "hover:bg-[color-mix(in_srgb,var(--destructive)_10%,var(--color-background-button-secondary-hover))]",
};

const CHIP_TONE_CLASS_NAME: Record<ComposerChoiceTone, string> = {
  neutral:
    "border border-[color:var(--color-border)] text-[var(--color-text-foreground-secondary)] group-hover:text-[var(--color-text-foreground)]",
  primary:
    "border border-[color:color-mix(in_srgb,var(--color-accent-blue)_50%,var(--color-border))] text-[var(--color-accent-blue)] group-hover:border-[color:color-mix(in_srgb,var(--color-accent-blue)_78%,var(--color-border))]",
  destructive:
    "border border-[color:color-mix(in_srgb,var(--destructive)_42%,var(--color-border))] text-destructive group-hover:border-[color:color-mix(in_srgb,var(--destructive)_68%,var(--color-border))]",
};

export function ComposerChoiceRow({
  shortcut,
  label,
  description,
  selected: selectedProp,
  tone: toneProp,
  disabled: disabledProp,
  trailing,
  badge,
  layout: layoutProp,
  onSelect,
}: ComposerChoiceRowProps) {
  const selected = selectedProp ?? false;
  const tone = toneProp ?? "neutral";
  const disabled = disabledProp ?? false;
  const stacked = layoutProp === "stacked";
  const showDescription = Boolean(description) && description !== label;
  const chip =
    shortcut !== null ? (
      <span
        className={cn(
          "flex size-[18px] shrink-0 items-center justify-center rounded-full text-ui-sm font-medium tabular-nums transition-colors duration-150",
          selected
            ? "bg-[var(--color-text-foreground)] text-[var(--color-background-surface)]"
            : CHIP_TONE_CLASS_NAME[tone],
        )}
      >
        {shortcut}
      </span>
    ) : null;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selectedProp === undefined ? undefined : selected}
      onClick={onSelect}
      className={cn(
        "group flex w-full items-start gap-2.5 rounded-lg py-1.5 text-left transition-colors duration-150",
        stacked ? "px-2.5" : "px-2",
        selected ? "bg-[var(--color-background-button-secondary)]" : ROW_TONE_CLASS_NAME[tone],
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {stacked ? (
        <>
          {/* A one-line-tall lane centers the chip on the label's first line. */}
          {chip ? <span className="flex h-5 shrink-0 items-center">{chip}</span> : null}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5">
              <span className="text-ui font-medium leading-5 text-foreground/90">{label}</span>
              {badge}
            </div>
            {showDescription ? (
              <p className="text-ui-sm leading-snug text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </>
      ) : (
        <>
          {chip}
          <div className="min-w-0 flex-1 leading-snug">
            <span className="text-ui-lg font-medium text-foreground/90">{label}</span>
            {showDescription ? (
              <span className="ml-1.5 text-ui text-muted-foreground/55">{description}</span>
            ) : null}
          </div>
        </>
      )}
      {trailing}
    </button>
  );
}
