import {
  ORCHESTRATION_GOAL_COMPLETION_SENTINEL,
  type OrchestrationGoal,
  type OrchestrationGoalStatus,
} from "@t3tools/contracts";

function goalElapsedSeconds(createdAt: string, completedAt: string): number {
  const start = Date.parse(createdAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }
  return Math.floor((end - start) / 1000);
}

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
  const finished = status === "complete" || status === "budget_limited";
  return {
    ...goal,
    status,
    timeUsedSeconds: finished
      ? goalElapsedSeconds(goal.createdAt, updatedAt)
      : goal.timeUsedSeconds,
    updatedAt,
  };
}

export function stripGoalCompletionSentinel(text: string): {
  readonly text: string;
  readonly hadSentinel: boolean;
} {
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.at(-1)?.trim() !== ORCHESTRATION_GOAL_COMPLETION_SENTINEL) {
    return { text, hadSentinel: false };
  }
  return {
    text: lines.slice(0, -1).join("\n").trimEnd(),
    hadSentinel: true,
  };
}
