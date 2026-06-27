// FILE: fileRowStyles.ts
// Purpose: Shared visual chrome for file/entry rows (editor explorer, diff file
//          lists, review file tree) so every file row matches without each
//          surface re-declaring the same Tailwind classes and indent math.
// Layer: Chat/shared UI

import { cn } from "~/lib/utils";

// Solid "active block" = the selection background token. The selected row paints
// it directly; the keyboard-focused row re-applies the same token under
// focus-visible, so arrow-key navigation looks exactly like moving the selection
// (a solid block, not a ring). Tailwind's JIT only emits classes it can see as
// full literals, so the focus-visible variant is spelled out rather than derived.
const FILE_ROW_SELECTED_BLOCK_CLASS_NAME =
  "bg-[var(--color-background-button-secondary)] text-foreground";
const FILE_ROW_FOCUS_BLOCK_CLASS_NAME =
  "focus-visible:bg-[var(--color-background-button-secondary)] focus-visible:text-foreground";

/**
 * Base chrome shared by every file/entry row button. Height and horizontal
 * padding differ per surface, so callers append them (e.g. `"h-7 pr-2"`).
 * Keyboard focus mirrors the selected block (see the active-block note above).
 */
export const FILE_ROW_BASE_CLASS_NAME = cn(
  "flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md text-left text-[12px] transition-colors",
  "focus-visible:outline-none",
  FILE_ROW_FOCUS_BLOCK_CLASS_NAME,
);

/** Selected vs. resting/hover tone for a file row. */
export function fileRowToneClassName(selected: boolean): string {
  return selected
    ? FILE_ROW_SELECTED_BLOCK_CLASS_NAME
    : "text-foreground/78 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground";
}

/** Full file-row button className. Pass per-surface extras (height/padding) via `className`. */
export function fileRowClassName(selected: boolean, className?: string): string {
  return cn(FILE_ROW_BASE_CLASS_NAME, fileRowToneClassName(selected), className);
}

/** Depth indent matching the editor explorer (0.5rem base + 0.75rem per level). */
export function fileRowIndentStyle(depth: number): { paddingLeft: string } {
  return { paddingLeft: `${0.5 + depth * 0.75}rem` };
}
