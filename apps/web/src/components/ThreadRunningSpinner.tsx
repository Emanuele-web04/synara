// FILE: ThreadRunningSpinner.tsx
// Purpose: Shared running/pulse spinner for sidebar thread rows.
// Layer: Sidebar UI primitive
// Exports: ThreadRunningSpinner

import { cn } from "~/lib/utils";

export function ThreadRunningSpinner({
  presentation,
  className,
}: {
  presentation: "overlay" | "inline";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-3 shrink-0 animate-spin rounded-full text-muted-foreground/55 [animation-duration:1.6s]",
        presentation === "overlay"
          ? "pointer-events-none absolute top-1/2 z-10 -translate-y-1/2 transition-opacity"
          : "inline-block",
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
