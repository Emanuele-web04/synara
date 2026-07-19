// FILE: ThreadRunningSpinner.tsx
// Purpose: Shared inline running/pulse spinner for sidebar thread status slots.
// Layer: Sidebar UI primitive
// Exports: ThreadRunningSpinner

import { cn } from "~/lib/utils";

export function ThreadRunningSpinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-3 shrink-0 animate-spin rounded-full text-muted-foreground/55 [animation-duration:1.6s] motion-reduce:animate-none",
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
