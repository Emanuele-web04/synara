// FILE: EnvironmentRow.tsx
// Purpose: Shared full-width menu-style row for the Environment panel — one leading
//          glyph, a truncating label, and an optional right-aligned trailing slot
//          (diff stats, a picker caret, or a value). Every panel entry and every
//          relocated picker trigger reuses this skin so the rows line up on one grid.
// Layer: Environment panel UI primitive

import { useState, type ComponentPropsWithoutRef, type ReactNode } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { ChevronDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import {
  ENVIRONMENT_PANEL_SECTION_LABEL_CLASS_NAME,
  ENVIRONMENT_PANEL_SECTION_LABEL_INLINE_CLASS_NAME,
  ENVIRONMENT_PANEL_TITLE_CLASS_NAME,
} from "./environmentPanelStyles";

/**
 * Interactive full-width row skin shared by every Environment panel entry and by the
 * relocated env/branch/git pickers when they render their trigger as a panel row.
 * Passed straight to Base UI trigger `className` (Combobox/Popover/Menu) so a picker
 * trigger and a plain button row are visually identical.
 */
export const ENVIRONMENT_ROW_CLASS_NAME = cn(
  "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-left",
  "text-[length:var(--app-font-size-ui,12px)] font-normal text-[var(--color-text-foreground)]",
  "outline-none transition-colors",
  "hover:bg-[var(--color-background-elevated-secondary)]",
  "focus-visible:bg-[var(--color-background-elevated-secondary)]",
  "disabled:pointer-events-none disabled:opacity-50",
);

/** Leading glyph treatment shared by every row (matches label color, fixed 16px). */
export const ENVIRONMENT_ROW_ICON_CLASS_NAME =
  "size-4 shrink-0 text-[var(--color-text-foreground)]";

/** Right-aligned caret for rows that open a picker or menu. */
export function EnvironmentRowChevron({ className }: { className?: string }) {
  return <ChevronDownIcon aria-hidden className={cn("size-3 shrink-0 opacity-60", className)} />;
}

/** Top-of-card title (e.g. "Environment"). */
export function EnvironmentPanelTitle({ children }: { children: ReactNode }) {
  return <p className={ENVIRONMENT_PANEL_TITLE_CLASS_NAME}>{children}</p>;
}

/**
 * Hairline separator between Environment panel sections. Each optional section renders this as
 * its own leading divider only when it actually renders, so toggling sections on/off never
 * leaves a doubled or dangling rule.
 */
export function EnvironmentSectionDivider() {
  return <div className="my-1 border-t border-[color:var(--color-border-light)]" />;
}

/** Small muted label that introduces a group of rows (e.g. "Editor", "Recap"). */
export function EnvironmentSectionLabel({ children }: { children: ReactNode }) {
  return <p className={ENVIRONMENT_PANEL_SECTION_LABEL_CLASS_NAME}>{children}</p>;
}

/**
 * Collapsible section: a folder-style header (rotating chevron + section label) that shows or
 * hides its children, mirroring the sidebar's project/thread-list disclosure. Built on the shared
 * Base UI Collapsible so open/close animates its height with the app's disclosure timing curve
 * (`DISCLOSURE_COLLAPSIBLE_PANEL_CLASS`); the chevron rotation rides the same duration. Open state
 * is local UI preference, so it lives in component state and defaults to expanded.
 */
export function EnvironmentCollapsibleSection({
  label,
  defaultOpen = true,
  children,
}: {
  label: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col">
      <CollapsibleTrigger
        className={cn(
          "group/section flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-left",
          "outline-none transition-colors",
          "hover:bg-[var(--color-background-elevated-secondary)]",
          "focus-visible:bg-[var(--color-background-elevated-secondary)]",
        )}
      >
        <span className={cn(ENVIRONMENT_PANEL_SECTION_LABEL_INLINE_CLASS_NAME, "min-w-0 truncate")}>
          {label}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-[var(--color-text-foreground-secondary)] opacity-60 transition-transform duration-220 ease-out motion-reduce:transition-none",
            open ? "rotate-0" : "-rotate-90",
          )}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex flex-col pt-0.5">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
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
  compact = false,
}: {
  icon: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  /** Skip the 16px icon gutter — for cramped dock/diff header pickers. */
  compact?: boolean;
}) {
  return (
    <>
      {compact ? (
        <span className="inline-flex shrink-0 items-center justify-center">{icon}</span>
      ) : (
        <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      )}
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
