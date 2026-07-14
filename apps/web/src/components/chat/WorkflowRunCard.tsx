// FILE: WorkflowRunCard.tsx
// Purpose: Workflow run panel stacked above the composer (Claude dynamic
// workflows): workflow name/description header with running counts and
// pause/stop actions, a phase rail when the script declared phases, and one row
// per agent (status dot, label, model, tokens, elapsed, status glyph). Settled
// runs keep the card with the persisted script path/runId and a resume action.
// Layer: Chat composer UI
// Exports: WorkflowRunCard

import type { ThreadId } from "@synara/contracts";
import { pluralize } from "@synara/shared/text";
import { memo } from "react";
import { PiArrowsInSimple, PiArrowsOutSimple, PiTreeStructure } from "react-icons/pi";

import { formatContextWindowTokens } from "~/lib/contextWindow";
import { CheckIcon, CopyIcon, LoaderIcon, PauseIcon, PlayIcon, StopIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
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
  onPause: () => void;
  onResume: () => void;
  onDismiss: () => void;
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

function settledWorkflowPresentation(workflowRun: WorkflowRunState): {
  label: string;
  toneClassName: string;
} {
  if (workflowRun.pausedByUser) {
    return { label: "Paused", toneClassName: "text-amber-300/80" };
  }
  switch (workflowRun.status) {
    case "failed":
      return { label: "Failed", toneClassName: "text-rose-300/85" };
    case "stopped":
      return { label: "Stopped", toneClassName: "text-amber-300/80" };
    default:
      return { label: "Completed", toneClassName: "text-emerald-300/75" };
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

function WorkflowAgentRowView({
  agent,
  nowMs,
  onOpenThread,
}: {
  agent: WorkflowAgentRow;
  nowMs: number;
  onOpenThread: (threadId: ThreadId) => void;
}) {
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
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/45">{meta}</span>
      ) : null}
      <span
        className={cn("shrink-0 text-[11px]", workflowAgentStatusToneClassName(agent.statusKind))}
      >
        {agent.statusLabel}
      </span>
    </>
  );
  const rowClassName = "flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left";
  const { threadId } = agent;

  return threadId ? (
    <button
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
    <div data-testid="workflow-agent-row" className={rowClassName} title={agent.description}>
      {rowContent}
    </div>
  );
}

export const WorkflowRunCard = memo(function WorkflowRunCard({
  workflowRun,
  nowMs,
  compact,
  onCompactChange,
  onOpenThread,
  onStop,
  onPause,
  onResume,
  onDismiss,
  attachedToPrevious = false,
}: WorkflowRunCardProps) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const totalCount = workflowRun.agents.length;
  const startedAtMs = Date.parse(workflowRun.startedAt);
  const elapsedLabel =
    workflowRun.settled || Number.isNaN(startedAtMs)
      ? null
      : formatClockDuration(Math.max(0, nowMs - startedAtMs));
  const countLabel =
    totalCount > 0
      ? workflowRun.runningCount > 0
        ? `${workflowRun.runningCount} of ${totalCount} ${pluralize(totalCount, "agent")} running`
        : `${totalCount} ${pluralize(totalCount, "agent")}`
      : workflowRun.settled
        ? null
        : "Starting agents";
  const settledPresentation = workflowRun.settled ? settledWorkflowPresentation(workflowRun) : null;
  const canResume =
    workflowRun.settled && workflowRun.runId !== null && workflowRun.scriptPath !== null;
  const savedLine = workflowRun.settled
    ? [workflowRun.scriptPath, workflowRun.runId].filter((part) => part !== null).join(" · ")
    : "";
  const phaseGroups = workflowRun.phases?.map((phase) => ({
    phase,
    agents: workflowRun.agents.filter((agent) => agent.phase === phase.title),
  }));

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
            {settledPresentation ? (
              <span className={cn("ml-1.5", settledPresentation.toneClassName)}>
                {settledPresentation.label}
              </span>
            ) : null}
            {countLabel ? <span className="ml-1.5">{countLabel}</span> : null}
            {elapsedLabel ? <span className="ml-1.5 tabular-nums">{elapsedLabel}</span> : null}
          </ComposerStackedPanelRowLabel>
        </ComposerStackedPanelRowMain>
        <div className="flex shrink-0 items-center gap-0.5">
          {workflowRun.settled ? (
            <>
              {canResume ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
                  onClick={onResume}
                  aria-label="Resume workflow"
                  title="Resume workflow"
                >
                  <PlayIcon className="size-3" />
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
                onClick={onDismiss}
                aria-label="Dismiss workflow panel"
                title="Dismiss workflow panel"
              >
                <XIcon className="size-3" />
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
                onClick={onPause}
                aria-label="Pause workflow"
                title="Pause workflow (resume replays completed agents from cache)"
              >
                <PauseIcon className="size-3" />
              </Button>
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
            </>
          )}
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

      <DisclosureRegion open={!compact && (workflowRun.agents.length > 0 || savedLine.length > 0)}>
        <div className={COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME}>
          {phaseGroups ? (
            <div className="flex min-w-0 gap-3">
              <div
                data-testid="workflow-phase-rail"
                className="w-max max-w-[38%] shrink-0 space-y-0 border-r border-border/40 pr-3"
              >
                {phaseGroups.map(({ phase }) => (
                  <div
                    key={phase.title}
                    data-testid="workflow-phase-rail-item"
                    className="flex items-center gap-2 px-1 py-1"
                    title={phase.detail ?? undefined}
                  >
                    <span
                      className={cn(
                        "min-w-0 truncate text-[12px]",
                        phase.isCurrent
                          ? "font-medium text-foreground/85"
                          : "text-muted-foreground/55",
                      )}
                    >
                      {phase.title}
                    </span>
                    {phase.totalCount > 0 ? (
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/45">
                        {phase.doneCount}/{phase.totalCount}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="min-w-0 flex-1 space-y-0">
                {phaseGroups
                  .filter(({ agents }) => agents.length > 0)
                  .map(({ phase, agents }) => (
                    <div key={phase.title} data-testid="workflow-phase-group">
                      <div className="px-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/45">
                        {phase.title}
                      </div>
                      {agents.map((agent) => (
                        <WorkflowAgentRowView
                          key={agent.taskId}
                          agent={agent}
                          nowMs={nowMs}
                          onOpenThread={onOpenThread}
                        />
                      ))}
                    </div>
                  ))}
              </div>
            </div>
          ) : (
            <div className="space-y-0">
              {workflowRun.agents.map((agent) => (
                <WorkflowAgentRowView
                  key={agent.taskId}
                  agent={agent}
                  nowMs={nowMs}
                  onOpenThread={onOpenThread}
                />
              ))}
            </div>
          )}
          {savedLine.length > 0 ? (
            <div
              data-testid="workflow-saved-line"
              className="mt-1 flex min-w-0 items-center gap-1.5 border-t border-border/40 px-1 pt-1.5"
            >
              <span className="shrink-0 text-[11px] text-muted-foreground/55">Saved</span>
              <span
                className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/45"
                title={savedLine}
              >
                {savedLine}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
                onClick={() => copyToClipboard(savedLine, undefined)}
                aria-label="Copy script path and run id"
                title="Copy script path and run id"
              >
                {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
              </Button>
            </div>
          ) : null}
        </div>
      </DisclosureRegion>
    </ComposerStackedPanel>
  );
});
