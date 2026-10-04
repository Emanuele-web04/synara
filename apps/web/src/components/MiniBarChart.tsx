// FILE: MiniBarChart.tsx
// Purpose: A row of small bottom-aligned bars, scaled to a shared maximum. Used by the
// Inbox recap (tokens per hour) and the Profile model speed trend (tok/s per week).
// Layer: web shared presentation.

import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface MiniBar {
  readonly key: string | number;
  readonly value: number;
  // "empty" renders a faint stub (no data, or a slot still in the future).
  readonly tone: "empty" | "muted" | "strong";
  readonly tooltip?: ReactNode;
}

const BAR_TONE_CLASS_NAMES: Record<MiniBar["tone"], string> = {
  empty: "bg-foreground/8",
  muted: "bg-muted-foreground/45",
  strong: "bg-foreground",
};

export function MiniBarChart({
  bars,
  max,
  className,
}: {
  bars: ReadonlyArray<MiniBar>;
  // Value of a full-height bar; defaults to the largest bar.
  max?: number;
  className?: string;
}) {
  const fullHeight = Math.max(1, max ?? Math.max(0, ...bars.map((bar) => bar.value)));
  const hasTooltips = bars.some((bar) => bar.tooltip !== undefined);
  return (
    <div
      className={cn("flex h-7 items-end justify-between gap-[3px]", className)}
      aria-hidden={hasTooltips ? undefined : true}
    >
      {bars.map((bar) => {
        const barClassName = cn(
          "min-h-[3px] w-full max-w-2 rounded-[2px]",
          BAR_TONE_CLASS_NAMES[bar.tone],
        );
        const height = `${Math.round((Math.max(0, bar.value) / fullHeight) * 100)}%`;
        if (bar.tooltip === undefined) {
          return <span key={bar.key} className={barClassName} style={{ height }} />;
        }
        return (
          <Tooltip key={bar.key}>
            {/* The trigger spans the full column so short bars stay easy to hover. */}
            <TooltipTrigger
              render={<span className="flex h-full w-full max-w-2 items-end" />}
              aria-label={typeof bar.tooltip === "string" ? bar.tooltip : undefined}
            >
              <span className={cn(barClassName, "max-w-none")} style={{ height }} />
            </TooltipTrigger>
            <TooltipPopup>{bar.tooltip}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
