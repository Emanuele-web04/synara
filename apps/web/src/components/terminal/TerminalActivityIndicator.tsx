// FILE: TerminalActivityIndicator.tsx
// Purpose: Compact terminal lifecycle indicator for running, attention, and review states.
// Layer: Terminal presentation primitive

import type { TerminalVisualState } from "@t3tools/shared/terminalThreads";

import { cn } from "~/lib/utils";

interface TerminalActivityIndicatorProps {
  className?: string;
  state?: Exclude<TerminalVisualState, "idle">;
}

const RUNNING_INDICATOR_OFFSETS_MS = [0, 160, 320, 480] as const;

export default function TerminalActivityIndicator({
  className,
  state = "running",
}: TerminalActivityIndicatorProps) {
  if (state === "attention" || state === "review") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-1.5 shrink-0 rounded-full",
          state === "attention"
            ? "bg-amber-500 dark:bg-amber-300/90"
            : "bg-emerald-500 dark:bg-emerald-300/90",
          className,
        )}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-grid h-2.5 w-2.5 shrink-0 grid-cols-2 grid-rows-2 gap-px text-current",
        className,
      )}
    >
      {RUNNING_INDICATOR_OFFSETS_MS.map((delayMs) => (
        <span
          // CSS animation keeps busy terminal indicators out of React's render loop.
          key={delayMs}
          className="terminal-running-indicator__dot block size-1 rounded-full bg-current"
          style={{ animationDelay: `${delayMs}ms` }}
        />
      ))}
    </span>
  );
}
