import { memo, useState } from "react";
import { type TimestampFormat } from "../appSettings";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import ChatMarkdown from "./ChatMarkdown";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  LoaderIcon,
  PanelRightCloseIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { ActiveTaskListState } from "../session-logic";
import type { LatestProposedPlanState } from "../session-logic";
import { formatTimestamp } from "../timestampFormat";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "../proposedPlan";
import { ProposedPlanActions } from "./chat/ProposedPlanActions";

function stepStatusIcon(status: string): React.ReactNode {
  if (status === "completed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--success)_15%,transparent)] text-[var(--success)]">
        <CheckIcon className="size-3" />
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--color-accent-blue)_15%,transparent)] text-[var(--color-accent-blue)]">
        <LoaderIcon className="size-3 animate-spin" />
      </span>
    );
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30">
      <span className="size-1.5 rounded-full bg-muted-foreground/30" />
    </span>
  );
}

interface PlanSidebarProps {
  activeTaskList: ActiveTaskListState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  timestampFormat: TimestampFormat;
  onClose: () => void;
}

const PlanSidebar = memo(function PlanSidebar({
  activeTaskList,
  activeProposedPlan,
  markdownCwd,
  workspaceRoot,
  timestampFormat,
  onClose,
}: PlanSidebarProps) {
  const [proposedPlanExpanded, setProposedPlanExpanded] = useState(false);
  const planMarkdown = activeProposedPlan?.planMarkdown ?? null;
  const displayedPlanMarkdown = planMarkdown ? stripDisplayedPlanMarkdown(planMarkdown) : null;
  const planTitle = planMarkdown ? proposedPlanTitle(planMarkdown) : null;

  return (
    <div className="flex h-full w-[340px] shrink-0 flex-col border-l border-border/70 bg-card/50">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className="rounded-md bg-[color-mix(in_srgb,var(--color-accent-blue)_10%,transparent)] px-1.5 py-0 text-[10px] font-semibold tracking-wide text-[var(--color-accent-blue)] uppercase"
          >
            Plan
          </Badge>
          {activeTaskList ? (
            <span className="text-[11px] text-muted-foreground/60">
              {formatTimestamp(activeTaskList.createdAt, timestampFormat)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {planMarkdown ? (
            <ProposedPlanActions
              planMarkdown={planMarkdown}
              workspaceRoot={workspaceRoot}
              variant="ghost"
              buttonClassName="text-muted-foreground/50 hover:text-foreground/70"
            />
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label="Close plan sidebar"
            className="text-muted-foreground/50 hover:text-foreground/70"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3 space-y-4">
          {/* Explanation */}
          {activeTaskList?.explanation ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground/80">
              {activeTaskList.explanation}
            </p>
          ) : null}

          {/* Tasks */}
          {activeTaskList && activeTaskList.tasks.length > 0 ? (
            <div className="space-y-1">
              <p className="mb-2 text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
                Steps
              </p>
              {activeTaskList.tasks.map((task) => (
                <div
                  key={`${task.status}:${task.task}`}
                  className={cn(
                    "flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-200",
                    task.status === "inProgress" &&
                      "bg-[color-mix(in_srgb,var(--color-accent-blue)_5%,transparent)]",
                    task.status === "completed" &&
                      "bg-[color-mix(in_srgb,var(--success)_5%,transparent)]",
                  )}
                >
                  <div className="mt-0.5">{stepStatusIcon(task.status)}</div>
                  <p
                    className={cn(
                      "text-[13px] leading-snug",
                      task.status === "completed"
                        ? "text-muted-foreground/50 line-through decoration-muted-foreground/20"
                        : task.status === "inProgress"
                          ? "text-foreground/90"
                          : "text-muted-foreground/70",
                    )}
                  >
                    {task.task}
                  </p>
                </div>
              ))}
            </div>
          ) : null}

          {/* Proposed Plan Markdown */}
          {planMarkdown ? (
            <div className="space-y-2">
              <button
                type="button"
                className="group flex w-full items-center gap-1.5 text-left"
                onClick={() => setProposedPlanExpanded((v) => !v)}
              >
                {proposedPlanExpanded ? (
                  <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/40 transition-transform" />
                ) : (
                  <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40 transition-transform" />
                )}
                <span className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase group-hover:text-muted-foreground/60">
                  {planTitle ?? "Full Plan"}
                </span>
              </button>
              {proposedPlanExpanded ? (
                <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                  <ChatMarkdown
                    text={displayedPlanMarkdown ?? ""}
                    cwd={markdownCwd}
                    isStreaming={false}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Empty state */}
          {!activeTaskList && !planMarkdown ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-[13px] text-muted-foreground/40">No active plan yet.</p>
              <p className="mt-1 text-[11px] text-muted-foreground/30">
                Plans will appear here when generated.
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
});

export default PlanSidebar;
export type { PlanSidebarProps };
