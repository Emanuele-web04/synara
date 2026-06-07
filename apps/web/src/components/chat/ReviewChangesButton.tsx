// FILE: ReviewChangesButton.tsx
// Purpose: Compact bordered "Review" action pill shared by the changed-files chrome —
// the per-turn "Edited N files" card and the live composer changes header — so the
// open-the-diff affordance stays visually identical across both surfaces.
// Layer: Chat changed-files UI
// Exports: ReviewChangesButton

import { memo } from "react";
import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";

interface ReviewChangesButtonProps {
  onClick: () => void;
  className?: string;
  style?: CSSProperties;
  label?: string;
}

export const ReviewChangesButton = memo(function ReviewChangesButton({
  onClick,
  className,
  style,
  label = "Review",
}: ReviewChangesButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        "shrink-0 rounded-md border border-[color:var(--color-border-light)] px-2.5 py-0.5 text-foreground/90 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground",
        className,
      )}
      style={style}
      onClick={onClick}
    >
      {label}
    </button>
  );
});
