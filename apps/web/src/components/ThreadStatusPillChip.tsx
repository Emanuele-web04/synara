// FILE: ThreadStatusPillChip.tsx
// Purpose: Dot + label rendering of a thread status pill, shared by kanban
//          cards and the sidebar Activity rows so the two can never drift.
// Layer: UI component (pure)
// Exports: ThreadStatusPillChip

import { StatusChip } from "~/components/ui/status-chip";
import { cn } from "~/lib/utils";
import type { ThreadStatusPill } from "./Sidebar.logic";

export function ThreadStatusPillChip({
  pill,
  className,
}: {
  pill: ThreadStatusPill;
  className?: string;
}) {
  return (
    <StatusChip
      variant="inline"
      dotClassName={pill.dotClass}
      pulse={pill.pulse}
      className={cn(pill.colorClass, className)}
    >
      <span className="truncate">{pill.label}</span>
    </StatusChip>
  );
}
