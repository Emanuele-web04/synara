// FILE: composerSlashCommands.ts
// Purpose: Share Synara's built-in composer slash command names across web UI
//          parsing and server-side profile stats backfills.
// Layer: Shared runtime utility
// Exports: command-name constants and normalization helpers.

export const BUILT_IN_COMPOSER_SLASH_COMMANDS = [
  "clear",
  "compact",
  "model",
  "plan",
  "default",
  "review",
  "fork",
  "side",
  "status",
  "subagents",
  "fast",
  "automation",
  "goal",
] as const;

export type BuiltInComposerSlashCommand = (typeof BUILT_IN_COMPOSER_SLASH_COMMANDS)[number];

export function normalizeComposerSlashCommandName(value: string): string {
  return value.trim().replace(/^\/+/, "").toLowerCase();
}

export function isBuiltInComposerSlashCommandName(
  value: string,
): value is BuiltInComposerSlashCommand {
  const normalizedValue = normalizeComposerSlashCommandName(value);
  return BUILT_IN_COMPOSER_SLASH_COMMANDS.some((command) => command === normalizedValue);
}

export type GoalSlashCommandAction =
  | { kind: "status" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "complete" }
  | { kind: "create"; objective: string; tokenBudget: number | null };

export function parseGoalSlashCommand(args: string): GoalSlashCommandAction {
  const trimmed = args.trim();
  if (!trimmed) {
    return { kind: "status" };
  }

  const lifecycleKind = (["status", "pause", "resume", "clear", "complete"] as const).find(
    (keyword) => keyword === trimmed.toLowerCase(),
  );
  if (lifecycleKind) {
    return { kind: lifecycleKind };
  }

  let objective = trimmed;
  let tokenBudget: number | null = null;
  const budgetMatch = /\s--budget(?:=|\s+)(\d+)\s*$/.exec(objective);
  if (budgetMatch && budgetMatch.index !== undefined) {
    const parsed = Number(budgetMatch[1]);
    tokenBudget = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
    objective = objective.slice(0, budgetMatch.index).trim();
  }
  return { kind: "create", objective, tokenBudget };
}

export function parseGoalSlashCommandPrompt(input: string): GoalSlashCommandAction | null {
  const trimmedStart = input.trimStart();
  if (!trimmedStart.startsWith("/goal")) {
    return null;
  }

  const args = trimmedStart.slice("/goal".length);
  if (args.length > 0 && !/^\s/.test(args)) {
    return null;
  }

  return parseGoalSlashCommand(args);
}
