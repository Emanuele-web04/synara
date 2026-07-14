// FILE: WorkflowRunCard.tsx
// Purpose: Live workflow run panel stacked above the composer (Claude dynamic
// workflows): workflow name/description header with running counts and a stop
// action, plus one row per member agent (status dot, description, model, tokens,
// elapsed, status glyph). Navigable rows open the agent's subagent thread.
// Layer: Chat composer UI
// Exports: WorkflowRunCard

import type { ThreadId } from "@synara/contracts";
import { pluralize } from "@synara/shared/text";
import { memo } from "react";
import { PiArrowsInSimple, PiArrowsOutSimple, PiTreeStructure } from "react-icons/pi";

import { formatContextWindowTokens } from "~/lib/contextWindow";
import { LoaderIcon, StopIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { formatClockDuration } from "../../session-logic";
import { Button } from "../ui/button";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import {
  workflowElapsedMs,
  type WorkflowAgentRow,
  type WorkflowRunState,
} from "./WorkflowRunCard.logic";
import {
  ComposerStackedPanelHeaderRow,
  ComposerStackedPanelRowLabel,
  ComposerStackedPanelRowMain,
} from "./ComposerStackedPanelContent";
import { ComposerStackedPanel } from "./ComposerStackedPanel";
import {
  COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_CLASS_NAME,
} from "./composerStackedPanelStyles";

interface WorkflowRunCardProps {
  workflowRun: WorkflowRunState;
  nowMs: number;
  compact: boolean;
  onCompactChange: (compact: boolean) => void;
  onOpenThread: (threadId: ThreadId) => void;
  onStop: () => void;
  attachedToPrevious?: boolean;
}

function workflowAgentStatusToneClassName(statusKind: WorkflowAgentRow["statusKind"]): string {
  switch (statusKind) {
    case "running":
      return "text-sky-300/85";
    case "completed":
      return "text-emerald-300/75";
    case "failed":
      return "text-rose-300/85";
    case "stopped":
      return "text-amber-300/80";
    case "queued":
      return "text-violet-300/80";
    default:
      return "text-muted-foreground/55";
  }
}

function agentRowMeta(agent: WorkflowAgentRow, nowMs: number): string | null {
  const elapsedMs = workflowElapsedMs(agent, nowMs);
  const parts = [
    agent.totalTokens !== null ? `${formatContextWindowTokens(agent.totalTokens)} tokens` : null,
    elapsedMs !== null ? formatClockDuration(elapsedMs) : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export const WorkflowRunCard = memo(function WorkflowRunCard({
  workflowRun,
  nowMs,
  compact,
  onCompactChange,
  onOpenThread,
  onStop,
  attachedToPrevious = false,
}: WorkflowRunCardProps) {
  const totalCount = workflowRun.agents.length;
  const startedAtMs = Date.parse(workflowRun.startedAt);
  const elapsedLabel = Number.isNaN(startedAtMs)
    ? null
    : formatClockDuration(Math.max(0, nowMs - startedAtMs));
  const countLabel =
    totalCount > 0
      ? workflowRun.runningCount > 0
        ? `${workflowRun.runningCount} of ${totalCount} ${pluralize(totalCount, "agent")} running`
        : `${totalCount} ${pluralize(totalCount, "agent")}`
      : "Starting agents";

  return (
    <ComposerStackedPanel
      passthroughSideMargins
      attachedToPrevious={attachedToPrevious}
      data-testid="workflow-run-card"
    >
      <ComposerStackedPanelHeaderRow>
        <ComposerStackedPanelRowMain title={workflowRun.description ?? undefined}>
          {compact && workflowRun.runningCount > 0 ? (
            <LoaderIcon className={cn(COMPOSER_STACKED_PANEL_ICON_CLASS_NAME, "animate-spin")} />
          ) : (
            <PiTreeStructure className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
          )}
          <ComposerStackedPanelRowLabel tone="meta">
            <span className="font-medium text-foreground/80">{workflowRun.name}</span>
            <span className="ml-1.5">{countLabel}</span>
            {elapsedLabel ? <span className="ml-1.5 tabular-nums">{elapsedLabel}</span> : null}
          </ComposerStackedPanelRowLabel>
        </ComposerStackedPanelRowMain>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
            onClick={onStop}
            aria-label="Stop workflow"
            title="Stop workflow"
          >
            <StopIcon className="size-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
            onClick={() => onCompactChange(!compact)}
            aria-label={compact ? "Expand workflow panel" : "Collapse workflow panel"}
            title={compact ? "Expand workflow panel" : "Collapse workflow panel"}
          >
            {compact ? (
              <PiArrowsOutSimple className="size-3" />
            ) : (
              <PiArrowsInSimple className="size-3" />
            )}
          </Button>
        </div>
      </ComposerStackedPanelHeaderRow>

      <DisclosureRegion open={!compact && workflowRun.agents.length > 0}>
        <div className={cn("space-y-0", COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME)}>
          {workflowRun.agents.map((agent) => {
            const meta = agentRowMeta(agent, nowMs);
            const rowContent = (
              <>
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    agent.statusKind === "running" ? "bg-sky-300/95" : "bg-muted-foreground/22",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/85">
                  {agent.description}
                  {agent.subagentType ? (
                    <span className="ml-1 text-[11px] font-normal text-muted-foreground/55">
                      ({agent.subagentType})
                    </span>
                  ) : null}
                  {agent.modelLabel ? (
                    <span className="ml-1.5 text-[11px] font-normal text-muted-foreground/45">
                      {agent.modelLabel}
                    </span>
                  ) : null}
                </span>
                {meta ? (
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/45">
                    {meta}
                  </span>
                ) : null}
                <span
                  className={cn(
                    "shrink-0 text-[11px]",
                    workflowAgentStatusToneClassName(agent.statusKind),
                  )}
                >
                  {agent.statusLabel}
                </span>
              </>
            );
            const rowClassName =
              "flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left";
            const { threadId } = agent;

            return threadId ? (
              <button
                key={agent.taskId}
                type="button"
                data-testid="workflow-agent-row"
                className={cn(
                  rowClassName,
                  "transition-colors hover:bg-[var(--color-background-button-secondary-hover)]",
                )}
                title={agent.description}
                onClick={() => onOpenThread(threadId)}
              >
                {rowContent}
              </button>
            ) : (
              <div
                key={agent.taskId}
                data-testid="workflow-agent-row"
                className={rowClassName}
                title={agent.description}
              >
                {rowContent}
              </div>
            );
          })}
        </div>
      </DisclosureRegion>
    </ComposerStackedPanel>
  );
});
