// Purpose: Pure normalization of Pi session stats into a Synara thread token-usage snapshot.
// Layer: pure function only — no Effect, no session context.
// Exports: normalizeTokenUsage.

import type { AgentSession as PiAgentSession } from "@earendil-works/pi-coding-agent";
import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";

export function normalizeTokenUsage(
  stats: ReturnType<PiAgentSession["getSessionStats"]>,
  contextWindow?: number | null,
): ThreadTokenUsageSnapshot | undefined {
  const inputTokens = stats.tokens.input;
  const cachedInputTokens = stats.tokens.cacheRead;
  const outputTokens = stats.tokens.output;
  const totalProcessedTokens = stats.tokens.total;
  const contextUsage = stats.contextUsage;
  const contextUsageWindow =
    typeof contextUsage?.contextWindow === "number" &&
    Number.isFinite(contextUsage.contextWindow) &&
    contextUsage.contextWindow > 0
      ? Math.floor(contextUsage.contextWindow)
      : undefined;
  const fallbackWindow =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? Math.floor(contextWindow)
      : undefined;
  const maxTokens = contextUsageWindow ?? fallbackWindow;
  const contextUsageTokens =
    typeof contextUsage?.tokens === "number" &&
    Number.isFinite(contextUsage.tokens) &&
    contextUsage.tokens >= 0
      ? Math.round(contextUsage.tokens)
      : undefined;
  const usedPercent =
    typeof contextUsage?.percent === "number" && Number.isFinite(contextUsage.percent)
      ? Math.max(0, Math.min(100, contextUsage.percent))
      : undefined;
  const usedTokensFromPercent =
    contextUsageTokens === undefined && usedPercent !== undefined && maxTokens !== undefined
      ? Math.round((usedPercent / 100) * maxTokens)
      : undefined;
  const usedTokens =
    contextUsageTokens ??
    usedTokensFromPercent ??
    (contextUsage
      ? 0
      : maxTokens !== undefined
        ? Math.min(totalProcessedTokens, maxTokens)
        : totalProcessedTokens);
  if (
    usedTokens <= 0 &&
    inputTokens <= 0 &&
    cachedInputTokens <= 0 &&
    outputTokens <= 0 &&
    maxTokens === undefined &&
    usedPercent === undefined
  ) {
    return undefined;
  }
  return {
    usedTokens,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    lastCachedInputTokens: cachedInputTokens,
    lastOutputTokens: outputTokens,
  };
}
