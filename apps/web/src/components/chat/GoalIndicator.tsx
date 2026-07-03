import type { OrchestrationGoal } from "@t3tools/contracts";

import { formatGoalUsageSummary } from "~/lib/goalDisplay";
import { cn } from "~/lib/utils";
import { ComposerStackedPanel } from "./ComposerStackedPanel";
import {
  ComposerStackedPanelRow,
  ComposerStackedPanelRowLabel,
  ComposerStackedPanelRowMain,
} from "./ComposerStackedPanelContent";
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME } from "./composerStackedPanelStyles";

const GOAL_STATUS_LABEL: Record<OrchestrationGoal["status"], string> = {
  active: "active",
  paused: "paused",
  budget_limited: "budget limited",
  complete: "complete",
  cleared: "cleared",
};

function goalMetaLabel(goal: OrchestrationGoal): string {
  if (goal.status === "complete" || goal.status === "budget_limited") {
    return formatGoalUsageSummary(goal);
  }
  return `${goal.turnCount} turns`;
}

/**
 * Slim composer bar for the thread's persisted goal. Hidden when there is no goal or it
 * has been cleared.
 */
export function GoalIndicator({
  goal,
  attachedToPrevious = false,
}: {
  goal: OrchestrationGoal | null | undefined;
  attachedToPrevious?: boolean;
}) {
  if (!goal || goal.status === "cleared") {
    return null;
  }

  return (
    <ComposerStackedPanel
      data-testid="goal-indicator"
      data-goal-status={goal.status}
      title={goal.objective}
      attachedToPrevious={attachedToPrevious}
    >
      <ComposerStackedPanelRow compact>
        <ComposerStackedPanelRowMain>
          <span
            aria-hidden="true"
            className={cn(
              COMPOSER_STACKED_PANEL_ICON_CLASS_NAME,
              "inline-flex items-center justify-center",
            )}
          >
            <span className="size-2 rounded-full bg-[var(--color-text-foreground-secondary)]" />
          </span>
          <span className="shrink-0 text-[12px] font-medium text-foreground/85">
            Goal: {GOAL_STATUS_LABEL[goal.status]}
          </span>
          <ComposerStackedPanelRowLabel className="min-w-0">
            {goal.objective}
          </ComposerStackedPanelRowLabel>
        </ComposerStackedPanelRowMain>
        <span className="shrink-0 text-[11px] text-muted-foreground/70">{goalMetaLabel(goal)}</span>
      </ComposerStackedPanelRow>
    </ComposerStackedPanel>
  );
}
