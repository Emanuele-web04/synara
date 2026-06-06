// FILE: ThreadPinToggleButton.tsx
// Purpose: Shared pin/unpin icon button reused by sidebar thread rows.
// Layer: Sidebar UI primitive
// Exports: ThreadPinToggleButton
// Note: Uses IconButton (ghost) for row-hover background/text transitions.
//       SidebarIconButton is for section-header chrome; its flat `bg-transparent`
//       override suppresses the pin hover affordance.

import type React from "react";
import { PinIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { IconButton } from "./ui/icon-button";

export function ThreadPinToggleButton({
  pinned,
  presentation,
  targetLabel = "thread",
  toneClassName,
  onToggle,
}: {
  pinned: boolean;
  presentation: "overlay" | "inline" | "leading";
  targetLabel?: string;
  toneClassName?: string;
  onToggle: (event: React.MouseEvent<HTMLButtonElement> | React.MouseEvent) => void;
}) {
  const label = `${pinned ? "Unpin" : "Pin"} ${targetLabel}`;

  return (
    <IconButton
      label={label}
      aria-pressed={pinned}
      title={label}
      size="icon-xs"
      variant="ghost"
      className={cn(
        "sidebar-icon-button pointer-events-auto size-5 rounded-sm border-transparent bg-transparent shadow-none transition-all hover:text-foreground/82 sm:size-5",
        toneClassName ?? "text-muted-foreground/34",
        presentation === "overlay"
          ? cn(
              "absolute left-1.5 top-1/2 z-30 -translate-y-1/2",
              // Hover/focus-only: the idle far-left slot shows the merge-status glyph
              // instead, and the pin only surfaces when the row is hovered/focused.
              "opacity-0 group-hover/thread-row:opacity-100 focus-visible:opacity-100",
            )
          : presentation === "leading"
            ? "relative z-10 shrink-0 text-muted-foreground/50"
            : "relative z-10 shrink-0",
      )}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={onToggle}
    >
      <PinIcon className="size-3.5" />
    </IconButton>
  );
}
