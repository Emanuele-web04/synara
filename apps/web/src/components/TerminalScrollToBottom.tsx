// FILE: TerminalScrollToBottom.tsx
// Purpose: Shows a floating terminal action when output has scrolled away from the bottom.
// Layer: Terminal presentation component
// Exports: TerminalScrollToBottom

import type { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "~/components/ui/icon-button";
import { ArrowDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

interface TerminalScrollToBottomProps {
  terminal: Terminal | null;
}

export function TerminalScrollToBottom({ terminal }: TerminalScrollToBottomProps) {
  const { t } = useTranslation();
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
      <IconButton
        onClick={handleClick}
        className="size-7 rounded-full border-border bg-background text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground sm:size-7"
        label={t("terminal.scrollToBottom")}
        size="icon-xs"
        variant="outline"
      >
        <ArrowDownIcon className="size-3.5" />
      </IconButton>
    </div>
  );
}
