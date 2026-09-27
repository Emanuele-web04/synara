// FILE: TaskGlyphs.tsx
// Purpose: Linear-style glyphs for the Tasks view — the status circle whose shape and
//          color say what a delegated agent is doing, and the priority bars.
// Layer: Tasks UI component
// Exports: TaskStatusGlyph, TaskStatusChip, TaskPriorityGlyph

import type { TodoPriority } from "@synara/contracts";

import { cn } from "~/lib/utils";
import type { TaskStatusKind } from "./tasks.logic";

const STATUS_COLOR_CLASS: Record<TaskStatusKind, string> = {
  todo: "text-muted-foreground/55",
  starting: "text-muted-foreground/70",
  running: "text-info",
  needs: "text-warning",
  review: "text-status-merged",
  stopped: "text-status-failure",
  done: "text-muted-foreground/60",
};

const STATUS_CHIP_CLASS: Partial<Record<TaskStatusKind, string>> = {
  starting: "bg-muted text-muted-foreground",
  running: "bg-info/12 text-info",
  needs: "bg-warning/14 text-warning",
  review: "bg-status-merged/14 text-status-merged",
  stopped: "bg-status-failure/12 text-status-failure",
};

/** The pill naming what a delegated agent is doing; nothing for plain or done to-dos. */
export function TaskStatusChip({ kind, label }: { kind: TaskStatusKind; label: string }) {
  const chipClass = STATUS_CHIP_CLASS[kind];
  if (!chipClass) return null;
  return (
    <span
      className={cn(
        "flex h-5.5 shrink-0 items-center gap-1.5 rounded-full px-2 text-ui-xs font-medium",
        chipClass,
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full bg-current", kind === "running" && "animate-pulse")}
      />
      {label}
    </span>
  );
}

// On-fill ink for glyphs painted as solid discs: the surface color, so the mark reads
// as a cut-out in both themes.
const CUTOUT_STROKE = "var(--color-background-surface, white)";

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
  const classes = cn("size-4 shrink-0", STATUS_COLOR_CLASS[kind], className);
  switch (kind) {
    case "done":
      return (
        <svg viewBox="0 0 16 16" className={classes} aria-hidden>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M5 8.2l2 2 4-4.2"
            fill="none"
            stroke={CUTOUT_STROKE}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "needs":
      return (
        <svg viewBox="0 0 16 16" className={classes} aria-hidden>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M8 4.6v4M8 11.2v.2"
            stroke={CUTOUT_STROKE}
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      );
    case "stopped":
      return (
        <svg viewBox="0 0 16 16" className={classes} aria-hidden>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6"
            stroke={CUTOUT_STROKE}
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
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
      return (
        <svg viewBox="0 0 16 16" fill="none" className={classes} aria-hidden>
          <circle
            cx="8"
            cy="8"
            r="6.25"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeDasharray="2.2 2.2"
          />
        </svg>
      );
    case "todo":
      return (
        <svg viewBox="0 0 16 16" fill="none" className={classes} aria-hidden>
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
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
        <path d="M8 4.6v4M8 11v.3" stroke={CUTOUT_STROKE} strokeWidth="1.7" strokeLinecap="round" />
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
