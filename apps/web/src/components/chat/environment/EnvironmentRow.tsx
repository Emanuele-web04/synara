// FILE: EnvironmentRow.tsx
// Purpose: Shared full-width menu-style row for the Environment panel — one leading
//          glyph, a truncating label, and an optional right-aligned trailing slot
//          (diff stats, a picker caret, or a value). Every panel entry and every
//          relocated picker trigger reuses this skin so the rows line up on one grid.
// Layer: Environment panel UI primitive

import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { ChevronDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import {
  ENVIRONMENT_PANEL_SECTION_LABEL_CLASS_NAME,
  ENVIRONMENT_PANEL_TITLE_CLASS_NAME,
} from "./environmentPanelStyles";

/**
 * Interactive full-width row skin shared by every Environment panel entry and by the
 * relocated env/branch/git pickers when they render their trigger as a panel row.
 * Passed straight to Base UI trigger `className` (Combobox/Popover/Menu) so a picker
 * trigger and a plain button row are visually identical.
 */
export const ENVIRONMENT_ROW_CLASS_NAME = cn(
  "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left",
  "text-[length:var(--app-font-size-ui,12px)] font-normal text-[var(--color-text-foreground)]",
  "outline-none transition-colors",
  "hover:bg-[var(--color-background-elevated-secondary)]",
  "focus-visible:bg-[var(--color-background-elevated-secondary)]",
  "disabled:pointer-events-none disabled:opacity-50",
);

/** Leading glyph treatment shared by every row (muted, fixed 14px). */
export const ENVIRONMENT_ROW_ICON_CLASS_NAME =
  "size-3.5 shrink-0 text-[var(--color-text-foreground-secondary)]";

/** Right-aligned caret for rows that open a picker or menu. */
export function EnvironmentRowChevron({ className }: { className?: string }) {
  return <ChevronDownIcon aria-hidden className={cn("size-3 shrink-0 opacity-60", className)} />;
}

/** Top-of-card title (e.g. "Environment"). */
export function EnvironmentPanelTitle({ children }: { children: ReactNode }) {
  return <p className={ENVIRONMENT_PANEL_TITLE_CLASS_NAME}>{children}</p>;
}

/** Small muted label that introduces a group of rows (e.g. "Editor", "Recap"). */
export function EnvironmentSectionLabel({ children }: { children: ReactNode }) {
  return <p className={ENVIRONMENT_PANEL_SECTION_LABEL_CLASS_NAME}>{children}</p>;
}

/**
 * Inner row layout: `[icon] [label …grows] [trailing]`. Rendered directly inside Base UI
 * triggers that own their element + className, and by {@link EnvironmentRow} for the
 * standalone button case. The 16px icon gutter matches the menu-item icon column.
 */
export function EnvironmentRowBody({
  icon,
  label,
  trailing,
}: {
  icon: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing ? (
        <span className="flex shrink-0 items-center gap-1 tabular-nums">{trailing}</span>
      ) : null}
    </>
  );
}

type EnvironmentRowProps = Omit<ComponentPropsWithoutRef<"button">, "children"> & {
  icon: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
};

/**
 * Standalone Environment panel row rendered as a `<button>`. Pickers that need their own
 * trigger element compose {@link ENVIRONMENT_ROW_CLASS_NAME} + {@link EnvironmentRowBody}
 * instead of nesting a button inside their trigger.
 */
export function EnvironmentRow({
  icon,
  label,
  trailing,
  className,
  type,
  ...props
}: EnvironmentRowProps) {
  return (
    <button
      type={type ?? "button"}
      className={cn(ENVIRONMENT_ROW_CLASS_NAME, className)}
      {...props}
    >
      <EnvironmentRowBody icon={icon} label={label} trailing={trailing} />
    </button>
  );
}
