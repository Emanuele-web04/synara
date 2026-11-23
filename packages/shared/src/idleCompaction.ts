/**
 * Minimum context worth a pre-emptive native compaction. Below it a cold
 * resume is cheaper than the maintenance request itself.
 */
export const IDLE_COMPACTION_MIN_CONTEXT_TOKENS = 20_000;

/**
 * Fraction of the observed cache TTL after which an idle thread becomes a
 * compaction candidate — close enough to expiry that the warm prefix still
 * pays for the request, early enough that one sweep cannot skip the window.
 */
export const IDLE_COMPACTION_TTL_FRACTION = 0.8;

/** How often the idle-compaction sweep rescans threads. */
export const IDLE_COMPACTION_SWEEP_MS = 45_000;

/**
 * Prompt-cache TTL per provider for runtimes that persist no cache
 * observation. Codex follows the OpenAI prompt-cache window; Antigravity
 * follows the ~5-minute Gemini window its own keep-alive pings target.
 */
export const IDLE_COMPACTION_PROVIDER_DEFAULT_TTL_SECONDS: Readonly<Record<string, number>> = {
  codex: 1_800,
  antigravity: 300,
};

/**
 * Conservative message-text ratio used to estimate context size when the
 * provider reports no token counts. Message text covers only part of real
 * context, so the estimate under-reads — it can skip a candidate, never
 * admit one that is not worth compacting.
 */
export const IDLE_COMPACTION_ESTIMATED_CHARS_PER_TOKEN = 4;

export function idleCompactionEstimatedContextTokens(messageTextLength: number): number {
  return Math.ceil(messageTextLength / IDLE_COMPACTION_ESTIMATED_CHARS_PER_TOKEN);
}

/**
 * Persisted evidence the sweep decides on. `ClaudeCacheObservation` satisfies
 * this shape; providers without native cache telemetry synthesize it from
 * session activity and a default TTL.
 */
export interface IdleCompactionObservation {
  readonly cacheReferenceAt?: string | null | undefined;
  readonly lastResponseAt?: string | null | undefined;
  readonly ttlSeconds?: number | undefined;
  readonly contextTokens?: number | undefined;
  readonly state?: string | undefined;
}

/**
 * Identity of one observed cache lease. A fresh provider request renews
 * `cacheReferenceAt`, so compacting once per lease cannot fire twice for the
 * same warm window.
 */
export function idleCompactionLeaseKey(observation: IdleCompactionObservation): string | undefined {
  return observation.cacheReferenceAt ?? observation.lastResponseAt ?? undefined;
}

/**
 * True when the cache lease is inside the last `IDLE_COMPACTION_TTL_FRACTION`
 * of its observed TTL and the context is worth compacting. Decides on
 * persisted evidence only; it never asks the provider anything.
 */
export function idleCompactionDue(
  observation: IdleCompactionObservation | undefined,
  nowMs: number,
): boolean {
  if (!observation || observation.state === "likely-expired" || !Number.isFinite(nowMs)) {
    return false;
  }
  const leaseKey = idleCompactionLeaseKey(observation);
  const { ttlSeconds, contextTokens } = observation;
  if (ttlSeconds === undefined || leaseKey === undefined) {
    return false;
  }
  if (contextTokens === undefined || contextTokens < IDLE_COMPACTION_MIN_CONTEXT_TOKENS) {
    return false;
  }
  const referenceMs = Date.parse(leaseKey);
  if (!Number.isFinite(referenceMs)) {
    return false;
  }
  const ageSeconds = (nowMs - referenceMs) / 1_000;
  return ageSeconds >= ttlSeconds * IDLE_COMPACTION_TTL_FRACTION && ageSeconds < ttlSeconds;
}
