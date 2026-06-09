// Purpose: Pure context-window and reasoning-effort resolution helpers for the Claude Agent adapter.
// Layer: pure functions/constants — no Effect, no session-context state.
// Exports: CLAUDE_CONTEXT_WINDOW_MAX_TOKENS, context-window resolvers, getEffectiveClaudeCodeEffort.

import { ClaudeCodeEffort } from "@t3tools/contracts";
import {
  getDefaultContextWindow,
  getModelCapabilities,
  hasContextWindowOption,
  trimOrNull,
} from "@t3tools/shared/model";

export const CLAUDE_CONTEXT_WINDOW_MAX_TOKENS = {
  "200k": 200_000,
  "1m": 1_000_000,
} as const;

export function getEffectiveClaudeCodeEffort(
  effort: ClaudeCodeEffort | null | undefined,
): Exclude<ClaudeCodeEffort, "ultrathink" | "ultracode"> | null {
  if (!effort) {
    return null;
  }
  if (effort === "ultrathink") {
    return null;
  }
  return effort === "ultracode" ? "xhigh" : effort;
}

export function resolveSelectedClaudeContextWindowMaxTokens(
  model: string | null | undefined,
  selectedContextWindow: string | null | undefined,
): number | undefined {
  const caps = getModelCapabilities("claudeAgent", model);
  const resolvedContextWindow =
    trimOrNull(selectedContextWindow) ?? getDefaultContextWindow(caps) ?? null;
  if (
    !resolvedContextWindow ||
    !hasContextWindowOption(caps, resolvedContextWindow) ||
    !Object.prototype.hasOwnProperty.call(CLAUDE_CONTEXT_WINDOW_MAX_TOKENS, resolvedContextWindow)
  ) {
    return undefined;
  }

  return CLAUDE_CONTEXT_WINDOW_MAX_TOKENS[
    resolvedContextWindow as keyof typeof CLAUDE_CONTEXT_WINDOW_MAX_TOKENS
  ];
}

export function resolveEffectiveClaudeContextWindow(input: {
  reportedContextWindow: number | undefined;
  lastKnownContextWindow: number | undefined;
  currentApiModelId: string | undefined;
}): number | undefined {
  const { reportedContextWindow, lastKnownContextWindow, currentApiModelId } = input;
  const currentSessionUsesOneMillionWindow = currentApiModelId?.endsWith("[1m]") === true;
  if (
    currentSessionUsesOneMillionWindow &&
    lastKnownContextWindow === CLAUDE_CONTEXT_WINDOW_MAX_TOKENS["1m"] &&
    reportedContextWindow !== undefined &&
    reportedContextWindow < lastKnownContextWindow
  ) {
    return lastKnownContextWindow;
  }
  return reportedContextWindow ?? lastKnownContextWindow;
}
