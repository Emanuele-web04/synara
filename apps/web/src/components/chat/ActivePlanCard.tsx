// FILE: ActivePlanCard.tsx
// Purpose: Renders the skinny inline checklist for active turn plans above the composer.
// Layer: Chat UI component
// Depends on: session-logic active plan state and shared button/icon primitives

import { memo } from "react";

import type { ActivePlanState } from "../../session-logic";
import { BotIcon, CheckIcon, ChevronRightIcon, ListTodoIcon, LoaderIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

interface ActivePlanCardProps {
  activePlan: ActivePlanState;
  backgroundTaskCount?: number;
  onOpenSidebar: () => void;
}

function stepStatusIcon(status: ActivePlanState["steps"][number]["status"]) {
  if (status === "completed") {
    return <CheckIcon className="size-3.5" />;
  }
  if (status === "inProgress") {
    return <LoaderIcon className="size-3.5 animate-spin" />;
  }
  return <span className="block size-2 rounded-full border border-current/65" />;
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
    <div className="mx-auto mb-3 w-full max-w-3xl">
      <div className="overflow-hidden rounded-[24px] border border-border/70 bg-card/80 shadow-sm">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground/80">
            <ListTodoIcon className="size-4 shrink-0" />
            <span className="truncate">
              {completedCount} out of {totalCount} tasks completed
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0 rounded-full text-muted-foreground/65 hover:text-foreground/80"
            onClick={onOpenSidebar}
            aria-label="Open plan sidebar"
            title="Open plan sidebar"
          >
            <ChevronRightIcon className="size-3.5" />
          </Button>
        </div>

        <ol className="space-y-0.5 px-4 pb-3">
          {activePlan.steps.map((step, index) => {
            const occurrence = (stepOccurrenceCount.get(step.step) ?? 0) + 1;
            stepOccurrenceCount.set(step.step, occurrence);

            return (
              <li key={`${step.step}:${occurrence}`} className="flex items-start gap-3 py-1.5">
                <div
                  className={cn(
                    "mt-0.5 flex min-w-0 shrink-0 items-center gap-2 text-[13px]",
                    step.status === "completed"
                      ? "text-muted-foreground/45"
                      : step.status === "inProgress"
                        ? "text-foreground/80"
                        : "text-muted-foreground/60",
                  )}
                >
                  <span className="flex size-4 items-center justify-center">
                    {stepStatusIcon(step.status)}
                  </span>
                  <span className="tabular-nums">{index + 1}.</span>
                </div>
                <p
                  className={cn(
                    "min-w-0 flex-1 text-[15px] leading-6 text-foreground/88",
                    step.status === "completed" && "text-muted-foreground/50 line-through",
                  )}
                >
                  {step.step}
                </p>
              </li>
            );
          })}
        </ol>

        {backgroundTaskCount > 0 ? (
          <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-2.5 text-[12px] text-muted-foreground/72">
            <div className="flex min-w-0 items-center gap-2">
              <BotIcon className="size-3.5 shrink-0" />
              <span className="truncate">
                {backgroundTaskCount} background agent{backgroundTaskCount === 1 ? "" : "s"}
              </span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="shrink-0 rounded-full text-muted-foreground/65 hover:text-foreground/80"
              onClick={onOpenSidebar}
              aria-label="Open plan sidebar"
              title="Open plan sidebar"
            >
              <ChevronRightIcon className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
});

export type { ActivePlanCardProps };
