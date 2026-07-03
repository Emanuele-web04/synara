import { ORCHESTRATION_GOAL_COMPLETION_SENTINEL, type OrchestrationGoal } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { renderGoalContinuationPrompt } from "./goalContinuationPrompt.ts";

const NOW = "2026-06-02T10:00:00.000Z";

function makeGoal(overrides?: Partial<OrchestrationGoal>): OrchestrationGoal {
  return {
    id: "goal-1",
    objective: "Fix <auth> & ship it",
    status: "active",
    tokenBudget: 1_000,
    tokensUsed: 250,
    usage: { inputTokens: 150, outputTokens: 100, totalTokens: 250 },
    turnCount: 2,
    continuationCount: 1,
    timeUsedSeconds: 42,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("renderGoalContinuationPrompt", () => {
  it("includes the objective, escaped, and the completion sentinel", () => {
    const prompt = renderGoalContinuationPrompt(makeGoal());
    expect(prompt).toContain("Fix &lt;auth&gt; &amp; ship it");
    expect(prompt).toContain(ORCHESTRATION_GOAL_COMPLETION_SENTINEL);
    expect(prompt).toContain("completion audit");
    // The objective is framed as untrusted data, not higher-priority instructions.
    expect(prompt).toContain("user-provided data");
  });

  it("renders the budget line when a token budget is set", () => {
    const prompt = renderGoalContinuationPrompt(makeGoal());
    expect(prompt).toContain("Tokens used: 250 of 1000");
    expect(prompt).toContain("Time spent pursuing goal: 42s");
  });

  it("omits the budget ceiling when no token budget is set", () => {
    const prompt = renderGoalContinuationPrompt(makeGoal({ tokenBudget: null, tokensUsed: 0 }));
    expect(prompt).toContain("Tokens used: 0");
    expect(prompt).not.toContain(" of ");
  });
});
