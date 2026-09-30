// FILE: SidebarStatusTrailingGlyph.tsx
// Purpose: Keep thread status glyphs identical across classic and Activity sidebar rows.
// Layer: Sidebar UI primitive

import { StatusDot } from "~/components/ui/status-chip";
import { cn } from "~/lib/utils";
import type { ThreadStatusPill } from "./Sidebar.logic";
import { ThreadRunningSpinner } from "./ThreadRunningSpinner";

export function SidebarUnreadCompletionGlyph({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Unread completion"
      className={cn("size-[7px] shrink-0 rounded-full bg-[var(--color-text-accent)]", className)}
    />
  );
}

export function SidebarStatusTrailingGlyph({ status }: { status: ThreadStatusPill }) {
  if (status.label === "Completed") {
    return <SidebarUnreadCompletionGlyph />;
  }
  if (status.pulse) {
    return (
      <span role="img" aria-label={status.label} className="inline-flex shrink-0">
        <ThreadRunningSpinner />
      </span>
    );
  }
  return <StatusDot role="img" aria-label={status.label} className={status.dotClass} />;
}
