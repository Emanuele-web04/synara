import { memo } from "react";
import { PiArrowsInSimple, PiSlidersHorizontal } from "react-icons/pi";

import type { ActiveTaskListState } from "../../session-logic";
import { BotIcon, CheckIcon, LoaderIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

interface ActiveTaskListCardProps {
  activeTaskList: ActiveTaskListState;
  backgroundTaskCount?: number;
  onOpenSidebar: () => void;
}

function taskStatusIcon(status: ActiveTaskListState["tasks"][number]["status"]) {
  if (status === "completed") {
    return <CheckIcon className="size-3" />;
  }
  if (status === "inProgress") {
    return <LoaderIcon className="size-3 animate-spin" />;
  }
  return <span className="block size-[7px] rounded-full border border-current" />;
}

export const ActiveTaskListCard = memo(function ActiveTaskListCard({
  activeTaskList,
  backgroundTaskCount = 0,
  onOpenSidebar,
}: ActiveTaskListCardProps) {
  const totalCount = activeTaskList.tasks.length;
  const completedCount = activeTaskList.tasks.filter((task) => task.status === "completed").length;
  const taskOccurrenceCount = new Map<string, number>();

  return (
    <div className="overflow-hidden rounded-t-2xl border border-b-0 border-[color:var(--color-border)] bg-[var(--color-background-surface-under)]">
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
          aria-label="Collapse tasks"
          title="Collapse tasks"
        >
          <PiArrowsInSimple className="size-3" />
        </Button>
      </div>

      <ol className="space-y-0 px-2.5 pb-2">
        {activeTaskList.tasks.map((task, index) => {
          const occurrence = (taskOccurrenceCount.get(task.task) ?? 0) + 1;
          taskOccurrenceCount.set(task.task, occurrence);

          return (
            <li key={`${task.task}:${occurrence}`} className="flex items-start gap-2 py-1">
              <div
                className={cn(
                  "mt-[3px] flex min-w-0 shrink-0 items-center gap-1.5 text-[12px]",
                  task.status === "completed"
                    ? "text-muted-foreground/45"
                    : task.status === "inProgress"
                      ? "text-foreground/80"
                      : "text-muted-foreground/60",
                )}
              >
                <span className="flex size-3.5 items-center justify-center">
                  {taskStatusIcon(task.status)}
                </span>
                <span className="tabular-nums">{index + 1}.</span>
              </div>
              <p
                className={cn(
                  "min-w-0 flex-1 text-[13px] leading-5 text-foreground/85",
                  task.status === "completed" && "text-muted-foreground/50 line-through",
                )}
              >
                {task.task}
              </p>
            </li>
          );
        })}
      </ol>

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

export type { ActiveTaskListCardProps };
