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
  // The summary's total can be the last prompt alone. Add its output only when
  // the native usage proves that correspondence, never to a newer estimate.
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
  // A short-lived tail does not expire a longer-lived prefix.
  if ((tokenCount(fields.ephemeral_1h_input_tokens) ?? 0) > 0) return 3_600;
  if ((tokenCount(fields.ephemeral_5m_input_tokens) ?? 0) > 0) return 300;
  return undefined;
}

export function claudeCacheFromSessionStart(
  input: Record<string, unknown>,
  observedAt: string,
  lifecycleGeneration?: string,
  previous?: ClaudeCacheObservation,
): ClaudeCacheObservation | undefined {
  if (input.hook_event_name !== "SessionStart" || typeof input.session_id !== "string") {
    return undefined;
  }
  const contextTokens = tokenCount(input.context_tokens);
  const idle = tokenCount(input.seconds_since_last_response);
  const expired = input.prompt_cache_likely_expired;
  const estimate = input.estimated_cache_write_usd;
  const lastResponseAt =
    idle !== undefined && Date.parse(observedAt) - idle * 1_000 >= 0
      ? new Date(Date.parse(observedAt) - idle * 1_000).toISOString()
      : undefined;
  const restored = previous?.nativeSessionId === input.session_id ? previous : undefined;
  // Native idle seconds are rounded. Retain a known request-start timestamp
  // only for the same response, including a long response whose cache has expired.
  // A newer native response may have run outside this adapter; its start and TTL
  // are unknown, so an older request cannot establish its expiry.
  const sameResponse =
    lastResponseAt !== undefined &&
    restored?.lastResponseAt !== undefined &&
    Math.abs(Date.parse(lastResponseAt) - Date.parse(restored.lastResponseAt)) < 1_000;
  const retainRequestEvidence = sameResponse || (lastResponseAt === undefined && expired !== false);
  return {
    ...(retainRequestEvidence ? restored : {}),
    ...(restored?.model ? { model: restored.model } : {}),
    nativeSessionId: input.session_id,
    ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
    ...(typeof input.model === "string" && input.model ? { model: input.model } : {}),
    observedAt,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(lastResponseAt !== undefined ? { lastResponseAt } : {}),
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
  const observedTtl = observedClaudeCacheTtl(usage);
  const previousRequest =
    sameIdentity && input.previous?.lastRequest?.messageId === input.messageId
      ? input.previous
      : undefined;
  const retainedLifetime =
    sameIdentity &&
    (previousRequest || (cacheReadInputTokens ?? 0) > 0 || observedTtl === undefined)
      ? input.previous
      : undefined;
  const creation =
    usage.cache_creation && typeof usage.cache_creation === "object"
      ? (usage.cache_creation as Record<string, unknown>)
      : undefined;
  const lifetimes = [
    observedTtl,
    (tokenCount(creation?.ephemeral_5m_input_tokens) ?? 0) > 0 ? 300 : undefined,
    retainedLifetime?.ttlSeconds,
    retainedLifetime?.ttlSeconds !== undefined ? retainedLifetime.partialTtlSeconds : undefined,
  ].filter((ttl): ttl is number => ttl !== undefined);
  const ttlSeconds = lifetimes.length > 0 ? Math.max(...lifetimes) : undefined;
  const partialTtlSeconds = lifetimes.length > 0 ? Math.min(...lifetimes) : undefined;
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
    cacheReferenceAt: previousRequest
      ? (previousRequest.cacheReferenceAt ?? previousRequest.observedAt)
      : (input.cacheReferenceAt ?? input.observedAt),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(ttlSeconds !== undefined && cached ? { ttlSeconds } : {}),
    ...(partialTtlSeconds !== undefined && partialTtlSeconds !== ttlSeconds && cached
      ? { partialTtlSeconds }
      : {}),
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
