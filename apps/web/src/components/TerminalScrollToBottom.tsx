// FILE: TerminalScrollToBottom.tsx
// Purpose: Shows a floating terminal action when output has scrolled away from the bottom.
// Layer: Terminal presentation component
// Exports: TerminalScrollToBottom

import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "~/components/ui/icon-button";
import { ArrowDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

interface TerminalScrollToBottomProps {
  terminal: Terminal | null;
}

export function TerminalScrollToBottom({ terminal }: TerminalScrollToBottomProps) {
  // Keyed by terminal: swapping terminals derives back to hidden in the same
  // render (no state-resetting effect); the rAF check re-evaluates right after.
  const [visibility, setVisibility] = useState<{
    terminal: Terminal;
    visible: boolean;
  } | null>(null);
  const isVisible =
    terminal !== null && visibility !== null && visibility.terminal === terminal
      ? visibility.visible
      : false;
  const visibilityRafRef = useRef<number | null>(null);

  const checkPosition = () => {
    if (!terminal) return;
    const buf = terminal.buffer.active;
    const nextVisible = buf.viewportY < buf.baseY;
    setVisibility((current) =>
      current !== null && current.terminal === terminal && current.visible === nextVisible
        ? current
        : { terminal, visible: nextVisible },
    );
  };

  const scheduleVisibilityCheck = () => {
    if (visibilityRafRef.current !== null) {
      return;
    }
    visibilityRafRef.current = window.requestAnimationFrame(() => {
      visibilityRafRef.current = null;
      checkPosition();
    });
  };

  useEffect(() => {
    if (!terminal) {
      return;
    }
    scheduleVisibilityCheck();
    const d1 = terminal.onWriteParsed(scheduleVisibilityCheck);
    const d2 = terminal.onScroll(scheduleVisibilityCheck);
    return () => {
      if (visibilityRafRef.current !== null) {
        window.cancelAnimationFrame(visibilityRafRef.current);
        visibilityRafRef.current = null;
      }
      d1.dispose();
      d2.dispose();
    };
  }, [terminal, scheduleVisibilityCheck]);

  const handleClick = () => terminal?.scrollToBottom();

  return (
    <div
      className={cn(
        "absolute bottom-4 left-1/2 z-10 -translate-x-1/2 transition-all duration-200",
        isVisible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
      )}
    >
      <IconButton
        onClick={handleClick}
        className="size-7 rounded-full border-border bg-background text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground sm:size-7"
        label="Scroll to bottom"
        size="icon-xs"
        variant="outline"
      >
        <ArrowDownIcon className="size-3.5" />
      </IconButton>
    </div>
  );
}
