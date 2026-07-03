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

export interface CodexNativeGoalDisplay {
  objective: string;
  commandMessageId: string | null;
}

const CODEX_GOAL_CLEAR_COMMANDS = new Set(["clear", "complete", "pause"]);
const CODEX_GOAL_STATUS_COMMANDS = new Set(["", "status", "resume"]);

function stripCodexGoalBudgetFlag(args: string): string {
  return args
    .replace(/\s+--budget(?:=|\s+)\S+/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function parseCodexNativeGoalCommandText(
  text: string,
): { kind: "set"; objective: string } | { kind: "clear" } | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) {
    return null;
  }

  const args = (match[1] ?? "").trim();
  const [firstToken = ""] = args.split(/\s+/u);
  const normalizedFirstToken = firstToken.toLowerCase();
  if (CODEX_GOAL_CLEAR_COMMANDS.has(normalizedFirstToken)) {
    return { kind: "clear" };
  }
  if (CODEX_GOAL_STATUS_COMMANDS.has(normalizedFirstToken)) {
    return null;
  }

  const objective = stripCodexGoalBudgetFlag(args);
  return objective.length > 0 ? { kind: "set", objective } : null;
}

export function deriveCodexNativeGoalDisplay(
  messages: ReadonlyArray<{ id?: string | null; role: string; text: string }>,
): CodexNativeGoalDisplay | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") {
      continue;
    }
    const command = parseCodexNativeGoalCommandText(message.text);
    if (!command) {
      continue;
    }
    if (command.kind === "clear") {
      return null;
    }
    return {
      objective: command.objective,
      commandMessageId: message.id ?? null,
    };
  }
  return null;
}
