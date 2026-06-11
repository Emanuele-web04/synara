// FILE: KanbanStatusIcon.tsx
// Purpose: Linear-style column status glyph — dashed circle (Draft), half-filled
//          yellow pie (In Progress), filled indigo check (Done). Shared by board
//          column headers and card status labels.
// Layer: Kanban UI component
// Exports: KanbanStatusIcon

import { cn } from "~/lib/utils";
import type { KanbanColumnKey } from "./kanban.logic";

export function KanbanStatusIcon({
  column,
  className,
}: {
  column: KanbanColumnKey;
  className?: string;
}) {
  if (column === "done") {
    return (
      <svg
        viewBox="0 0 14 14"
        className={cn("size-3.5 shrink-0 text-[#5e6ad2]", className)}
        aria-hidden
      >
        <circle cx="7" cy="7" r="7" fill="currentColor" />
        <path
          d="M4.1 7.4 6.15 9.4 9.9 4.9"
          fill="none"
          stroke="var(--color-background-surface, white)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (column === "inProgress") {
    return (
      <svg
        viewBox="0 0 14 14"
        className={cn("size-3.5 shrink-0 text-[#f2c94c]", className)}
        aria-hidden
      >
        <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 14 14"
      className={cn("size-3.5 shrink-0 text-muted-foreground/60", className)}
      aria-hidden
    >
      <circle
        cx="7"
        cy="7"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeDasharray="2 2.2"
      />
    </svg>
  );
}
