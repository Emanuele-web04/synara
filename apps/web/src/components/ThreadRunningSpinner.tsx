// FILE: ThreadRunningSpinner.tsx
// Purpose: Shared inline running/pulse spinner for sidebar thread status slots.
// Layer: Sidebar UI primitive
// Exports: ThreadRunningSpinner

import { cn } from "~/lib/utils";
import type { ActionStateName } from "~/lib/actionStates";
import { DotmSquare11 } from "~/components/ui/dotm-square-11";

const DOTMATRIX_SIZE = 12;

// Sidebar dotmatrix uses Echo Ring (thinking state) for all running threads.
// At 12px sidebar size, per-state distinction is invisible — the island shows
// per-state loaders where the expanded view has room for the full 5 states.
const DOTMATRIX_ACTION_COLOR: Record<ActionStateName, string> = {
  thinking: "var(--accent)",
  reading: "var(--accent)",
  editing: "var(--accent)",
  "running-command": "var(--accent)",
  error: "var(--destructive)",
};

export interface ThreadRunningSpinnerProps {
  className?: string;
  loaderStyle?: "spinner" | "dotmatrix";
  actionState?: ActionStateName;
}

export function ThreadRunningSpinner({
  className,
  loaderStyle = "spinner",
  actionState = "thinking",
}: ThreadRunningSpinnerProps) {
  if (loaderStyle === "dotmatrix") {
    return (
      <DotmSquare11
        aria-hidden="true"
        size={DOTMATRIX_SIZE}
        color={DOTMATRIX_ACTION_COLOR[actionState]}
        className={cn("shrink-0", className)}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-3 shrink-0 animate-spin rounded-full text-muted-foreground/55 [animation-duration:1.6s]",
        className,
      )}
      style={{
        background: "conic-gradient(from 0deg, transparent 25%, currentColor)",
        mask: "radial-gradient(farthest-side, transparent calc(100% - 1.5px), black calc(100% - 1.5px))",
        WebkitMask:
          "radial-gradient(farthest-side, transparent calc(100% - 1.5px), black calc(100% - 1.5px))",
      }}
    />
  );
}
