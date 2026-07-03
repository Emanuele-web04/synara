import type { OrchestrationGoal } from "@t3tools/contracts";

const GOAL_STATUS_LABEL: Record<OrchestrationGoal["status"], string> = {
  active: "active",
  paused: "paused",
  budget_limited: "budget limited",
  complete: "complete",
  cleared: "cleared",
};

/**
 * Compact composer chip for the thread's persisted goal (the agent-agnostic port of
 * pi-goal / Codex goals). Mirrors pi-goal's footer status: shows the lifecycle status and
 * turn count while a goal is live. Hidden when there is no goal or it has been cleared.
 */
export function GoalIndicator({ goal }: { goal: OrchestrationGoal | null | undefined }) {
  if (!goal || goal.status === "cleared") {
    return null;
  }

  return (
    <span
      data-testid="goal-indicator"
      data-goal-status={goal.status}
      title={goal.objective}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground"
    >
      <span className="sr-only sm:not-sr-only">Goal: {GOAL_STATUS_LABEL[goal.status]}</span>
      <span className="text-muted-foreground/70">{goal.turnCount} turns</span>
    </span>
  );
}
