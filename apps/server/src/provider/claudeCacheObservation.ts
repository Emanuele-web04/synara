import type { ClaudeCacheObservation } from "@synara/contracts";

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export function claudeCacheContextTokens(usage: {
  readonly totalTokens: number;
  readonly apiUsage?: unknown;
}): number | undefined {
  const total = tokenCount(usage.totalTokens);
  if (total === undefined) return undefined;
  const raw =
    usage.apiUsage && typeof usage.apiUsage === "object"
      ? (usage.apiUsage as Record<string, unknown>)
      : undefined;
  if (!raw) return total;
  const counts = [
    raw.input_tokens,
    raw.cache_read_input_tokens,
    raw.cache_creation_input_tokens,
  ].map(tokenCount);
  const output = tokenCount(raw.output_tokens);
  // the summary's total can be the last prompt alone — add its output only when native usage proves that correspondence, never to a newer estimate
  return counts.every((count) => count !== undefined) &&
    output !== undefined &&
    counts.reduce<number>((sum, count) => sum + count!, 0) === total
    ? total + output
    : total;
}

export function observedClaudeCacheTtl(usage: Record<string, unknown>): number | undefined {
  const creation = usage.cache_creation;
  if (!creation || typeof creation !== "object") return undefined;
  const fields = creation as Record<string, unknown>;
  // mixed-duration prefixes expire in parts — warn with the shortest observed duration, not a promised hour
  if ((tokenCount(fields.ephemeral_5m_input_tokens) ?? 0) > 0) return 300;
  if ((tokenCount(fields.ephemeral_1h_input_tokens) ?? 0) > 0) return 3_600;
  return undefined;
}

export function claudeCacheFromSessionStart(
  input: Record<string, unknown>,
  observedAt: string,
  lifecycleGeneration?: string,
): ClaudeCacheObservation | undefined {
  if (input.hook_event_name !== "SessionStart" || typeof input.session_id !== "string") {
    return undefined;
  }
  const contextTokens = tokenCount(input.context_tokens);
  const idle = tokenCount(input.seconds_since_last_response);
  const expired = input.prompt_cache_likely_expired;
  const estimate = input.estimated_cache_write_usd;
  return {
    nativeSessionId: input.session_id,
    ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
    ...(typeof input.model === "string" && input.model ? { model: input.model } : {}),
    observedAt,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(idle !== undefined && Date.parse(observedAt) - idle * 1_000 >= 0
      ? { lastResponseAt: new Date(Date.parse(observedAt) - idle * 1_000).toISOString() }
      : {}),
    state: expired === true ? "likely-expired" : expired === false ? "likely-warm" : "unknown",
    source: "session-start",
    ...(typeof estimate === "number" && Number.isFinite(estimate) && estimate >= 0
      ? { estimatedCacheWriteUsd: estimate }
      : {}),
  };
}

export function claudeCacheFromRequest(input: {
  readonly usage: Record<string, unknown>;
  readonly messageId: string;
  readonly observedAt: string;
  readonly cacheReferenceAt?: string;
  readonly nativeSessionId?: string;
  readonly lifecycleGeneration?: string;
  readonly model?: string;
  readonly previous?: ClaudeCacheObservation;
}): ClaudeCacheObservation {
  const { usage } = input;
  const inputTokens = tokenCount(usage.input_tokens);
  const cacheReadInputTokens = tokenCount(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = tokenCount(usage.cache_creation_input_tokens);
  const outputTokens = tokenCount(usage.output_tokens);
  const sameIdentity =
    input.previous?.nativeSessionId === input.nativeSessionId &&
    input.previous?.model === input.model;
  const ttlSeconds =
    observedClaudeCacheTtl(usage) ?? (sameIdentity ? input.previous?.ttlSeconds : undefined);
  const knownCounts = [inputTokens, cacheReadInputTokens, cacheCreationInputTokens, outputTokens];
  const contextTokens = knownCounts.every((count) => count !== undefined)
    ? knownCounts.reduce<number>((sum, count) => sum + count!, 0)
    : undefined;
  const cached = (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0) > 0;
  return {
    ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
    ...(input.lifecycleGeneration ? { lifecycleGeneration: input.lifecycleGeneration } : {}),
    ...(input.model ? { model: input.model } : {}),
    observedAt: input.observedAt,
    lastResponseAt: input.observedAt,
    cacheReferenceAt:
      sameIdentity && input.previous?.lastRequest?.messageId === input.messageId
        ? (input.previous.cacheReferenceAt ?? input.previous.observedAt)
        : (input.cacheReferenceAt ?? input.observedAt),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(ttlSeconds !== undefined && cached ? { ttlSeconds } : {}),
    state: cached ? "likely-warm" : "unknown",
    source: "request-usage",
    lastRequest: {
      messageId: input.messageId,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
      ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    },
  };
}

/** Model changes invalidate the prefix even if its time-based lease is fresh. */
export function claudeCacheForModel(
  observation: ClaudeCacheObservation | undefined,
  model: string | undefined,
): ClaudeCacheObservation | undefined {
  if (!observation || !model || !observation.model || observation.model === model)
    return observation;
  const { estimatedCacheWriteUsd: _stalePrice, ...evidence } = observation;
  return { ...evidence, state: "likely-expired", source: "local-estimate" };
}
