// FILE: ActivePlanCard.tsx
// Purpose: Renders the skinny inline checklist for active turn plans above the composer.
// Layer: Chat UI component
// Depends on: session-logic active plan state and shared button/icon primitives

import { memo } from "react";
import { PiArrowsInSimple, PiSlidersHorizontal } from "react-icons/pi";

import type { ActivePlanState } from "../../session-logic";
import { BotIcon, CheckIcon, LoaderIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

interface ActivePlanCardProps {
  activePlan: ActivePlanState;
  backgroundTaskCount?: number;
  onOpenSidebar: () => void;
}

function stepStatusIcon(status: ActivePlanState["steps"][number]["status"]) {
  if (status === "completed") {
    return <CheckIcon className="size-3" />;
  }
  if (status === "inProgress") {
    return <LoaderIcon className="size-3 animate-spin" />;
  }
  return <span className="block size-[7px] rounded-full border border-current" />;
}

export const ActivePlanCard = memo(function ActivePlanCard({
  activePlan,
  backgroundTaskCount = 0,
  onOpenSidebar,
}: ActivePlanCardProps) {
  const totalCount = activePlan.steps.length;
  const completedCount = activePlan.steps.filter((step) => step.status === "completed").length;
  const stepOccurrenceCount = new Map<string, number>();

  return (
    <div className="overflow-hidden rounded-t-2xl border border-b-0 border-[color:var(--color-border)] bg-[var(--color-background-surface-under)]">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground/80">
          <PiSlidersHorizontal className="size-3.5 shrink-0" />
          <span className="truncate">
            {completedCount} out of {totalCount} tasks completed
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-5 shrink-0 rounded-md text-[var(--color-text-foreground-tertiary)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]"
          onClick={onOpenSidebar}
          aria-label="Collapse plan"
          title="Collapse plan"
        >
          <PiArrowsInSimple className="size-3" />
        </Button>
      </div>

      {/* Steps list */}
      <ol className="space-y-0 px-2.5 pb-2">
        {activePlan.steps.map((step, index) => {
          const occurrence = (stepOccurrenceCount.get(step.step) ?? 0) + 1;
          stepOccurrenceCount.set(step.step, occurrence);

          return (
            <li key={`${step.step}:${occurrence}`} className="flex items-start gap-2 py-1">
              <div
                className={cn(
                  "mt-[3px] flex min-w-0 shrink-0 items-center gap-1.5 text-[12px]",
                  step.status === "completed"
                    ? "text-muted-foreground/45"
                    : step.status === "inProgress"
                      ? "text-foreground/80"
                      : "text-muted-foreground/60",
                )}
              >
                <span className="flex size-3.5 items-center justify-center">
                  {stepStatusIcon(step.status)}
                </span>
                <span className="tabular-nums">{index + 1}.</span>
              </div>
              <p
                className={cn(
                  "min-w-0 flex-1 text-[13px] leading-5 text-foreground/85",
                  step.status === "completed" && "text-muted-foreground/50 line-through",
                )}
              >
                {step.step}
              </p>
            </li>
          );
        })}
      </ol>

      {/* Background tasks section */}
      {backgroundTaskCount > 0 ? (
        <div className="flex items-center justify-between gap-2 border-t border-border/50 px-2.5 py-1.5 text-[11px] text-muted-foreground/70">
          <div className="flex min-w-0 items-center gap-1.5">
            <BotIcon className="size-3 shrink-0" />
            <span className="truncate">
              {backgroundTaskCount} background agent{backgroundTaskCount === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
});

export type { ActivePlanCardProps };
