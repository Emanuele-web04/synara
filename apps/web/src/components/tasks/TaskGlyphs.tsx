// FILE: TaskGlyphs.tsx
// Purpose: Linear-style glyphs for the Tasks view — the status circle whose shape and
//          color say what a delegated agent is doing, and the priority bars.
// Layer: Tasks UI component
// Exports: TaskStatusGlyph, TaskStatusChip, TaskPriorityGlyph

import type { TodoPriority } from "@synara/contracts";

import { STATUS_GLYPH_CUTOUT_STROKE, StatusChip } from "~/components/ui/status-chip";
import { cn } from "~/lib/utils";
import type { TaskStatusKind } from "./tasks.logic";

// One row per status: the glyph's ink, and the pill classes for statuses that name an
// agent's activity (nothing for plain or done to-dos, which have no chip).
const STATUS_TONE: Record<TaskStatusKind, { glyph: string; chip?: string }> = {
  todo: { glyph: "text-muted-foreground/55" },
  starting: { glyph: "text-muted-foreground/70", chip: "bg-muted text-muted-foreground" },
  running: { glyph: "text-info", chip: "bg-info/12 text-info" },
  needs: { glyph: "text-warning", chip: "bg-warning/14 text-warning" },
  review: { glyph: "text-status-merged", chip: "bg-status-merged/14 text-status-merged" },
  stopped: { glyph: "text-status-failure", chip: "bg-status-failure/12 text-status-failure" },
  done: { glyph: "text-muted-foreground/60" },
};

/** The pill naming what a delegated agent is doing; nothing for plain or done to-dos. */
export function TaskStatusChip({ kind, label }: { kind: TaskStatusKind; label: string }) {
  const chipClass = STATUS_TONE[kind].chip;
  if (!chipClass) return null;
  return (
    <StatusChip variant="pill" pulse={kind === "running"} className={chipClass}>
      {label}
    </StatusChip>
  );
}

// Statuses drawn as a solid disc with a mark cut out of it.
const DISC_MARKS = {
  done: { d: "M5 8.2l2 2 4-4.2", strokeWidth: 1.6 },
  needs: { d: "M8 4.6v4M8 11.2v.2", strokeWidth: 1.7 },
  stopped: { d: "M5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6", strokeWidth: 1.6 },
} as const;

export function TaskStatusGlyph({
  kind,
  className,
  animated = true,
}: {
  kind: TaskStatusKind;
  className?: string | undefined;
  /** False keeps the running spinner still, e.g. on a section header. */
  animated?: boolean;
}) {
  const classes = cn("size-4 shrink-0", STATUS_TONE[kind].glyph, className);
  switch (kind) {
    case "done":
    case "needs":
    case "stopped": {
      const mark = DISC_MARKS[kind];
      return (
        <svg viewBox="0 0 16 16" className={classes} aria-hidden>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d={mark.d}
            fill="none"
            stroke={STATUS_GLYPH_CUTOUT_STROKE}
            strokeWidth={mark.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    }
    case "review":
      return (
        <svg viewBox="0 0 16 16" fill="none" className={classes} aria-hidden>
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 3.5a4.5 4.5 0 0 1 0 9z" fill="currentColor" />
        </svg>
      );
    case "running":
      return (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          className={cn(classes, animated && "animate-spin-stepped")}
          aria-hidden
        >
          <circle
            cx="8"
            cy="8"
            r="6.25"
            stroke="currentColor"
            strokeOpacity=".3"
            strokeWidth="1.5"
          />
          <path
            d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    case "starting":
    case "todo":
      return (
        <svg viewBox="0 0 16 16" fill="none" className={classes} aria-hidden>
          <circle
            cx="8"
            cy="8"
            r="6.25"
            stroke="currentColor"
            strokeWidth="1.4"
            {...(kind === "starting" ? { strokeDasharray: "2.2 2.2" } : {})}
          />
        </svg>
      );
  }
}

export function TaskPriorityGlyph({
  priority,
  className,
}: {
  priority: TodoPriority;
  className?: string | undefined;
}) {
  if (priority === "urgent") {
    return (
      <svg
        viewBox="0 0 16 16"
        className={cn("size-3.5 shrink-0 text-status-failure", className)}
        aria-hidden
      >
        <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill="currentColor" />
        <path
          d="M8 4.6v4M8 11v.3"
          stroke={STATUS_GLYPH_CUTOUT_STROKE}
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (priority === "none") {
    return (
      <svg
        viewBox="0 0 16 16"
        className={cn("size-3.5 shrink-0 text-muted-foreground/45", className)}
        aria-hidden
      >
        <path
          d="M2.5 8h2M7 8h2M11.5 8h2"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  const level = priority === "high" ? 3 : priority === "medium" ? 2 : 1;
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
      aria-hidden
    >
      <rect x="2" y="9.5" width="2.6" height="4.5" rx=".9" fill="currentColor" />
      <rect
        x="6.7"
        y="6.2"
        width="2.6"
        height="7.8"
        rx=".9"
        fill="currentColor"
        opacity={level >= 2 ? 1 : 0.3}
      />
      <rect
        x="11.4"
        y="3"
        width="2.6"
        height="11"
        rx=".9"
        fill="currentColor"
        opacity={level >= 3 ? 1 : 0.3}
      />
    </svg>
  );
}
