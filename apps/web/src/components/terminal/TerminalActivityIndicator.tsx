// FILE: TerminalActivityIndicator.tsx
// Purpose: Compact terminal lifecycle indicator for running, attention, and review states.
// Layer: Terminal presentation primitive

import type { TerminalVisualState } from "@t3tools/shared/terminalThreads";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";

interface TerminalActivityIndicatorProps {
  className?: string;
  state?: Exclude<TerminalVisualState, "idle">;
}

// Braille dot frames for a 2x3 perimeter snake.
// Default state shows 4 lit dots; corner transitions drop to 3.
const BRAILLE_SNAKE_FRAMES = ["⠙", "⠹", "⠸", "⠼", "⠴", "⠶", "⠦", "⠧", "⠇", "⠏", "⠋", "⠛"] as const;
const BRAILLE_SNAKE_INTERVAL_MS = 90;

export default function TerminalActivityIndicator({
  className,
  state = "running",
}: TerminalActivityIndicatorProps) {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (state !== "running") {
      return;
    }
    const timer = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % BRAILLE_SNAKE_FRAMES.length);
    }, BRAILLE_SNAKE_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [state]);

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
        "inline-flex shrink-0 items-center justify-center font-mono text-[8px] leading-none text-current antialiased",
        className,
      )}
    >
      {BRAILLE_SNAKE_FRAMES[frameIndex]}
    </span>
  );
}
