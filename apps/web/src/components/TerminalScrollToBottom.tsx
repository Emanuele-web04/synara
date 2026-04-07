import type { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";

interface TerminalScrollToBottomProps {
  terminal: Terminal | null;
}

export function TerminalScrollToBottom({ terminal }: TerminalScrollToBottomProps) {
  const [isVisible, setIsVisible] = useState(false);
  const visibilityRafRef = useRef<number | null>(null);

  const checkPosition = useCallback(() => {
    if (!terminal) return;
    const buf = terminal.buffer.active;
    const nextVisible = buf.viewportY < buf.baseY;
    setIsVisible((current) => (current === nextVisible ? current : nextVisible));
  }, [terminal]);

  const scheduleVisibilityCheck = useCallback(() => {
    if (visibilityRafRef.current !== null) {
      return;
    }
    visibilityRafRef.current = window.requestAnimationFrame(() => {
      visibilityRafRef.current = null;
      checkPosition();
    });
  }, [checkPosition]);

  useEffect(() => {
    if (!terminal) {
      setIsVisible(false);
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
      <button
        type="button"
        onClick={handleClick}
        className="flex size-7 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Scroll to bottom"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="size-3.5"
        >
          <path
            fillRule="evenodd"
            d="M10 3a.75.75 0 01.75.75v10.638l3.96-4.158a.75.75 0 111.08 1.04l-5.25 5.5a.75.75 0 01-1.08 0l-5.25-5.5a.75.75 0 111.08-1.04l3.96 4.158V3.75A.75.75 0 0110 3z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  );
}
