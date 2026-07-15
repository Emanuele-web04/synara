// FILE: ComposerChoiceRow.tsx
// Purpose: Shared list-style choice row (leading number chip + label + inline
// description + optional trailing affordance) used by both composer decision cards —
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
  selected = false,
  tone = "neutral",
  disabled = false,
  trailing,
  onSelect,
}: ComposerChoiceRowProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "group flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150",
        selected ? "bg-[var(--color-background-button-secondary)]" : ROW_TONE_CLASS_NAME[tone],
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {shortcut !== null ? (
        <span
          className={cn(
            "flex size-[18px] shrink-0 items-center justify-center rounded-full text-[11px] font-medium tabular-nums transition-colors duration-150",
            selected
              ? "bg-[var(--color-text-foreground)] text-[var(--color-background-surface)]"
              : CHIP_TONE_CLASS_NAME[tone],
          )}
        >
          {shortcut}
        </span>
      ) : null}
      <div className="min-w-0 flex-1 leading-snug">
        <span className="text-[13px] font-medium text-foreground/90">{label}</span>
        {description && description !== label ? (
          <span className="ml-1.5 text-[12px] text-muted-foreground/55">{description}</span>
        ) : null}
      </div>
      {trailing}
    </button>
  );
}
