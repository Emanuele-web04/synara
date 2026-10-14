import type { ClaudeCacheObservation } from "@synara/contracts";

// Claude Code (2.1.296) asks before resuming a conversation whose last response
// is at least 70 minutes old and whose context is at least 100k tokens, whatever
// the cache state; Synara asks at the same point so both behave alike.
export const CLAUDE_LARGE_CONTEXT_TOKENS = 100_000;
export const CLAUDE_RESUME_REVIEW_IDLE_SECONDS = 70 * 60;

/** Re-evaluate persisted evidence without making a request or extending its TTL. */
export function assessClaudeCache(
  observation: ClaudeCacheObservation | undefined,
  nowMs: number,
): {
  readonly state: ClaudeCacheObservation["state"];
  readonly idleSeconds?: number;
  readonly requiresConfirmation: boolean;
} {
  if (!observation || !Number.isFinite(nowMs)) {
    return { state: "unknown", requiresConfirmation: false };
  }
  const observedAt = Date.parse(observation.observedAt);
  const lastResponseAt = observation.lastResponseAt
    ? Date.parse(observation.lastResponseAt)
    : undefined;
  const cacheReferenceAt = observation.cacheReferenceAt
    ? Date.parse(observation.cacheReferenceAt)
    : lastResponseAt;
  const clockValid =
    Number.isFinite(observedAt) &&
    nowMs >= observedAt &&
    (lastResponseAt === undefined ||
      (Number.isFinite(lastResponseAt) && lastResponseAt <= observedAt)) &&
    (cacheReferenceAt === undefined ||
      (Number.isFinite(cacheReferenceAt) && cacheReferenceAt <= (lastResponseAt ?? observedAt)));
  if (!clockValid) return { state: "unknown", requiresConfirmation: false };
  const idleSeconds =
    lastResponseAt === undefined ? undefined : Math.floor((nowMs - lastResponseAt) / 1_000);
  const cacheAgeSeconds =
    cacheReferenceAt === undefined ? undefined : Math.floor((nowMs - cacheReferenceAt) / 1_000);
  // A native expired report remains useful without a TTL. A warm report cannot
  // promise continued warmth once time has advanced and its TTL is unknown.
  const state =
    observation.state === "likely-expired"
      ? "likely-expired"
      : cacheAgeSeconds !== undefined && observation.ttlSeconds !== undefined
        ? cacheAgeSeconds >= observation.ttlSeconds
          ? "likely-expired"
          : observation.partialTtlSeconds !== undefined &&
              cacheAgeSeconds >= observation.partialTtlSeconds
            ? "unknown"
            : "likely-warm"
        : nowMs === observedAt
          ? observation.state
          : "unknown";
  return {
    state,
    ...(idleSeconds !== undefined ? { idleSeconds } : {}),
    requiresConfirmation:
      idleSeconds !== undefined &&
      idleSeconds >= CLAUDE_RESUME_REVIEW_IDLE_SECONDS &&
      observation.contextTokens !== undefined &&
      observation.contextTokens >= CLAUDE_LARGE_CONTEXT_TOKENS,
  };
}
