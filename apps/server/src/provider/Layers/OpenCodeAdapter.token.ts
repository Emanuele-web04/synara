// Purpose: Pure numeric coercion and OpenCode/Kilo token-usage normalization helpers.
// Layer: pure functions — no Effect, no session-context state.
// Exports: numeric coercers, readOpenCodeTokens, normalizeOpenCodeTokenUsage, buildOpenCodeTokenUsageKey.

import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";

import type { NormalizedOpenCodeTokens, OpenCodeAssistantTokens } from "./OpenCodeAdapter.types.ts";

export function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

export function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

export function asFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function readOpenCodeTokens(tokens: unknown): NormalizedOpenCodeTokens | undefined {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return undefined;
  }
  const tokenRecord = tokens as Partial<OpenCodeAssistantTokens>;
  const inputTokens = asNonNegativeInteger(tokenRecord.input);
  const outputTokens = asNonNegativeInteger(tokenRecord.output);
  const reasoningOutputTokens = asNonNegativeInteger(tokenRecord.reasoning);
  const cacheReadTokens = asNonNegativeInteger(tokenRecord.cache?.read);
  const cacheWriteTokens = asNonNegativeInteger(tokenRecord.cache?.write);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    reasoningOutputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

export function normalizeOpenCodeTokenUsage(
  tokens: unknown,
  maxTokens?: number | undefined,
): ThreadTokenUsageSnapshot | undefined {
  const normalizedTokens = readOpenCodeTokens(tokens);
  if (!normalizedTokens) {
    return undefined;
  }

  const { inputTokens, outputTokens, reasoningOutputTokens, cacheReadTokens, cacheWriteTokens } =
    normalizedTokens;
  const cachedInputTokens = cacheReadTokens + cacheWriteTokens;
  const totalProcessedTokens =
    inputTokens + cachedInputTokens + outputTokens + reasoningOutputTokens;
  if (totalProcessedTokens <= 0) {
    return undefined;
  }

  const normalizedMaxTokens = asPositiveInteger(maxTokens);
  const usedTokens =
    normalizedMaxTokens !== undefined
      ? Math.min(totalProcessedTokens, normalizedMaxTokens)
      : totalProcessedTokens;

  return {
    usedTokens,
    totalProcessedTokens,
    ...(normalizedMaxTokens !== undefined ? { maxTokens: normalizedMaxTokens } : {}),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    lastCachedInputTokens: cachedInputTokens,
    lastOutputTokens: outputTokens,
    lastReasoningOutputTokens: reasoningOutputTokens,
  };
}

export function buildOpenCodeTokenUsageKey(input: {
  readonly messageId: string;
  readonly tokens: OpenCodeAssistantTokens;
  readonly maxTokens?: number | undefined;
}): string | undefined {
  const normalizedTokens = readOpenCodeTokens(input.tokens);
  if (!normalizedTokens) {
    return undefined;
  }

  const { inputTokens, outputTokens, reasoningOutputTokens, cacheReadTokens, cacheWriteTokens } =
    normalizedTokens;
  return [
    input.messageId,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningOutputTokens,
    asPositiveInteger(input.maxTokens) ?? "",
  ].join(":");
}
