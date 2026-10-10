// FILE: SidebarStatusTrailingGlyph.tsx
// Purpose: Keep thread status and draft glyphs identical across classic and Activity sidebar rows.
// Layer: Sidebar UI primitive

import { StatusDot } from "~/components/ui/status-chip";
import { ClockIcon, PencilIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { ThreadStatusPill } from "./Sidebar.logic";
import { ThreadBackgroundWorkSpinner, ThreadRunningSpinner } from "./ThreadRunningSpinner";

export function SidebarUnreadCompletionGlyph({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Unread completion"
      className={cn("size-[7px] shrink-0 rounded-full bg-[var(--color-text-accent)]", className)}
    />
  );
}

/** Quiet marker for a chat whose composer holds a message the user has not sent yet. */
export function SidebarDraftGlyph({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Unsent draft"
      title="Unsent draft"
      className={cn("inline-flex shrink-0 text-orange-500/85 dark:text-orange-300/85", className)}
    >
      <PencilIcon className="size-3" aria-hidden />
    </span>
  );
}

export function SidebarStatusTrailingGlyph({ status }: { status: ThreadStatusPill }) {
  if (status.label === "Completed") {
    return <SidebarUnreadCompletionGlyph />;
  }
  if (status.label === "Reminder") {
    return (
      <span role="img" aria-label="Snooze reminder" className="inline-flex shrink-0 text-info">
        <ClockIcon className="size-3" aria-hidden />
      </span>
    );
  }
  if (status.label === "In Background") {
    const count = status.backgroundTaskCount ?? 0;
    const title =
      count > 0 ? `In background · ${count} ${count === 1 ? "task" : "tasks"}` : "In background";
    return (
      <span role="img" aria-label={title} title={title} className="inline-flex shrink-0">
        <ThreadBackgroundWorkSpinner />
      </span>
    );
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
