import type { OrchestrationGoal, OrchestrationGoalStatus } from "@t3tools/contracts";

// Shared goal-fold helpers used by BOTH projections: the in-memory read model
// (projector.ts) and the SQLite projection (ProjectionPipeline.ts). Keeping the
// accounting in one place ensures the reactor/web (which read SQLite) and the decider
// (which reads the in-memory model) stay consistent.

function goalElapsedSeconds(createdAt: string, completedAt: string): number {
  const start = Date.parse(createdAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }
  return Math.floor((end - start) / 1000);
}

// Best-effort per-turn token usage extraction from a provider-shaped (Json) activity
// payload. Mirrors pi-goal's tolerant `extractUsageAccounting`: providers report usage
// under varying key names, so we probe a set of aliases and fall back to zero.
function extractTurnUsageFromActivityPayload(payload: unknown): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  if (typeof payload !== "object" || payload === null) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  const nested = (payload as { usage?: unknown }).usage;
  const source = (typeof nested === "object" && nested !== null ? nested : payload) as Record<
    string,
    unknown
  >;
  const num = (...keys: ReadonlyArray<string>): number => {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return Math.floor(value);
      }
    }
    return 0;
  };
  const inputTokens = num("inputTokens", "input", "promptTokens", "input_tokens", "prompt_tokens");
  const outputTokens = num(
    "outputTokens",
    "output",
    "completionTokens",
    "output_tokens",
    "completion_tokens",
  );
  const explicitTotal = num("totalTokens", "total", "total_tokens");
  const totalTokens = explicitTotal > 0 ? explicitTotal : inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

// Fold a completed turn into the active goal: increment turn count, accumulate usage,
// refresh elapsed time, and trip the budget guard. Mirrors pi-goal's `turn_end` handler.
export function applyGoalTurnAccounting(
  goal: OrchestrationGoal,
  activityPayload: unknown,
  occurredAt: string,
): OrchestrationGoal {
  const delta = extractTurnUsageFromActivityPayload(activityPayload);
  const tokensUsed = goal.tokensUsed + delta.totalTokens;
  const usage = {
    inputTokens: goal.usage.inputTokens + delta.inputTokens,
    outputTokens: goal.usage.outputTokens + delta.outputTokens,
    totalTokens: goal.usage.totalTokens + delta.totalTokens,
  };
  const budgetExhausted = goal.tokenBudget !== null && tokensUsed >= goal.tokenBudget;
  return {
    ...goal,
    status: budgetExhausted ? "budget_limited" : goal.status,
    tokensUsed,
    usage,
    turnCount: goal.turnCount + 1,
    timeUsedSeconds: goalElapsedSeconds(goal.createdAt, occurredAt),
    updatedAt: occurredAt,
  };
}

export function incrementGoalContinuation(
  goal: OrchestrationGoal,
  occurredAt: string,
): OrchestrationGoal {
  return { ...goal, continuationCount: goal.continuationCount + 1, updatedAt: occurredAt };
}

export function transitionGoalStatus(
  goal: OrchestrationGoal,
  status: OrchestrationGoalStatus,
  updatedAt: string,
): OrchestrationGoal {
  return { ...goal, status, updatedAt };
}
