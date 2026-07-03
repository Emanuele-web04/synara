import type { OrchestrationGoal } from "@t3tools/contracts";

import { formatContextWindowTokens } from "./contextWindow";

export function formatGoalDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  if (safeSeconds < 60) {
    return `${safeSeconds}s`;
  }
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function formatGoalUsageSummary(goal: OrchestrationGoal): string {
  return `${formatContextWindowTokens(goal.tokensUsed)} tokens · ${formatGoalDuration(
    goal.timeUsedSeconds,
  )}`;
}

export function formatGoalCompletionSummary(goal: OrchestrationGoal): string | null {
  if (goal.status !== "complete" && goal.status !== "budget_limited") {
    return null;
  }
  const label = goal.status === "budget_limited" ? "Goal budget reached" : "Goal complete";
  return `${label} · ${formatGoalUsageSummary(goal)}`;
}
