// FILE: TerminalActivityIndicator.tsx
// Purpose: Compact braille-based terminal activity indicator.
// Layer: Terminal presentation primitive

import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";

interface TerminalActivityIndicatorProps {
  className?: string;
}

// Braille dot frames for a 2x3 perimeter snake.
// Default state shows 4 lit dots; corner transitions drop to 3.
const BRAILLE_SNAKE_FRAMES = ["⠙", "⠹", "⠸", "⠼", "⠴", "⠶", "⠦", "⠧", "⠇", "⠏", "⠋", "⠛"] as const;
const BRAILLE_SNAKE_INTERVAL_MS = 90;

export default function TerminalActivityIndicator({ className }: TerminalActivityIndicatorProps) {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % BRAILLE_SNAKE_FRAMES.length);
    }, BRAILLE_SNAKE_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

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
