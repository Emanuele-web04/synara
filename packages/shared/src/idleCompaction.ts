import type { ClaudeCacheObservation } from "@synara/contracts";

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
 * Identity of one observed cache lease. A fresh provider request renews
 * `cacheReferenceAt`, so compacting once per lease cannot fire twice for the
 * same warm window.
 */
export function idleCompactionLeaseKey(observation: ClaudeCacheObservation): string | undefined {
  return observation.cacheReferenceAt ?? observation.lastResponseAt;
}

/**
 * True when the cache lease is inside the last `IDLE_COMPACTION_TTL_FRACTION`
 * of its observed TTL and the context is worth compacting. Decides on
 * persisted evidence only; it never asks the provider anything.
 */
export function idleCompactionDue(
  observation: ClaudeCacheObservation | undefined,
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
