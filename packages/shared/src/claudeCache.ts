import type { ClaudeCacheObservation } from "@synara/contracts";

export const CLAUDE_LARGE_CONTEXT_TOKENS = 100_000;

/** re-evaluate persisted evidence without making a request or extending its TTL */
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
  // an expired report stays useful without a TTL; a warm report can't promise warmth once time advances past an unknown TTL
  const state =
    observation.state === "likely-expired"
      ? "likely-expired"
      : cacheAgeSeconds !== undefined && observation.ttlSeconds !== undefined
        ? cacheAgeSeconds >= observation.ttlSeconds
          ? "likely-expired"
          : "likely-warm"
        : nowMs === observedAt
          ? observation.state
          : "unknown";
  return {
    state,
    ...(idleSeconds !== undefined ? { idleSeconds } : {}),
    requiresConfirmation:
      state === "likely-expired" &&
      observation.contextTokens !== undefined &&
      observation.contextTokens > CLAUDE_LARGE_CONTEXT_TOKENS,
  };
}
