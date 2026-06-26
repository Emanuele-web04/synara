// FILE: fileRowStyles.ts
// Purpose: Shared visual chrome for file/entry rows (editor explorer, diff file
//          lists, review file tree) so every file row matches without each
//          surface re-declaring the same Tailwind classes and indent math.
// Layer: Chat/shared UI

import { cn } from "~/lib/utils";

/**
 * Base chrome shared by every file/entry row button. Height and horizontal
 * padding differ per surface, so callers append them (e.g. `"h-7 pr-2"`).
 */
export const FILE_ROW_BASE_CLASS_NAME =
  "flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md text-left text-[12px] transition-colors";

/** Selected vs. resting/hover tone for a file row. */
export function fileRowToneClassName(selected: boolean): string {
  return selected
    ? "bg-[var(--color-background-button-secondary)] text-foreground"
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
