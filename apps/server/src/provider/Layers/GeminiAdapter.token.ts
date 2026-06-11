/**
 * GeminiAdapter.token - Token-usage normalizers for the Gemini provider adapter.
 *
 * Purpose: map Gemini ACP prompt-result and usage-update payloads into canonical
 * ThreadTokenUsageSnapshot values. Pure functions only.
 *
 * @module GeminiAdapter.token
 */
import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";

import { asNumber, asRecord } from "../geminiValue.ts";

export function normalizePromptUsage(value: unknown): ThreadTokenUsageSnapshot | undefined {
  const usage = asRecord(value);
  const usedTokens = asNumber(usage?.totalTokens);
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const inputTokens = asNumber(usage?.inputTokens);
  const outputTokens = asNumber(usage?.outputTokens);
  const thoughtTokens = asNumber(usage?.thoughtTokens);
  const cachedReadTokens = asNumber(usage?.cachedReadTokens);
  const cachedWriteTokens = asNumber(usage?.cachedWriteTokens);
  const cachedInputTokens =
    (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0) > 0
      ? (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0)
      : undefined;

  return {
    usedTokens,
    totalProcessedTokens: usedTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(thoughtTokens !== undefined ? { reasoningOutputTokens: thoughtTokens } : {}),
    lastUsedTokens: usedTokens,
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(thoughtTokens !== undefined ? { lastReasoningOutputTokens: thoughtTokens } : {}),
  };
}

export function normalizeUsageUpdate(value: unknown): ThreadTokenUsageSnapshot | undefined {
  const usage = asRecord(value);
  const usedTokens = asNumber(usage?.used);
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = asNumber(usage?.size);
  return {
    usedTokens,
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
    lastUsedTokens: usedTokens,
    compactsAutomatically: true,
  };
}
