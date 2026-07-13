// FILE: providerUsage/rateLimitResilience.ts
// Purpose: Shared "keep last-good + back off" resilience for live usage fetchers. When a provider's
// usage endpoint throttles (HTTP 429) or blips, blanking the panel is worse than showing slightly
// stale numbers — so we remember the last clean snapshot per account and keep serving it (with a
// staleness note) during a cooldown that honors Retry-After, while skipping live calls so we don't
// pile on more 429s. Mirrors OpenUsage's ClaudeProvider (PR #849). Any fetcher can opt in via
// createRateLimitResilience; keeping the state here avoids duplicating the bookkeeping per provider.

import type { ProviderKind, ServerProviderUsageSnapshot } from "@synara/contracts";

import { errorSnapshot } from "./parse";

/** Fallback backoff when a 429 carries no usable Retry-After header. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
/** Upper bound on a cooldown so a huge/hostile Retry-After can't freeze usage on stale data for hours. */
export const MAX_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;

interface ResilienceEntry {
  lastGoodSnapshot: ServerProviderUsageSnapshot | null;
  cooldownUntilMs: number;
}

export interface RateLimitResilience {
  /** Snapshot to serve while `key` is throttled, or null when no cooldown is active for it. */
  serveDuringCooldown(key: string, nowMs: number): ServerProviderUsageSnapshot | null;
  /** Record a clean fetch and clear any cooldown for `key`. */
  rememberLastGood(key: string, snapshot: ServerProviderUsageSnapshot): void;
  /** Begin a cooldown for `key` honoring Retry-After (clamped), then return the snapshot to serve. */
  enterCooldown(
    key: string,
    nowMs: number,
    retryAfterMs: number | undefined,
  ): ServerProviderUsageSnapshot;
  /** Test-only: drop all remembered state. */
  reset(): void;
}

export function createRateLimitResilience(options: {
  provider: ProviderKind;
  source: string;
  /** Builds the throttle note shown on the served snapshot, given the rounded minutes until retry. */
  detail: (retryMins: number) => string;
  defaultCooldownMs?: number;
  maxCooldownMs?: number;
}): RateLimitResilience {
  const defaultCooldownMs = options.defaultCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  const maxCooldownMs = options.maxCooldownMs ?? MAX_RATE_LIMIT_COOLDOWN_MS;
  const store = new Map<string, ResilienceEntry>();

  const entryFor = (key: string): ResilienceEntry => {
    let entry = store.get(key);
    if (!entry) {
      entry = { lastGoodSnapshot: null, cooldownUntilMs: 0 };
      store.set(key, entry);
    }
    return entry;
  };

  const detailFor = (entry: ResilienceEntry, nowMs: number): string =>
    options.detail(Math.max(1, Math.ceil((entry.cooldownUntilMs - nowMs) / 60_000)));

  // The last clean fetch with a staleness note when we have it, otherwise an error snapshot that at
  // least explains the throttle. The last-good note rides on `status: "ok"` so the UI keeps rendering
  // the limits instead of hiding the section on a non-ok snapshot.
  const snapshotForCooldown = (
    entry: ResilienceEntry,
    nowMs: number,
  ): ServerProviderUsageSnapshot => {
    const lastGood = entry.lastGoodSnapshot;
    return lastGood
      ? { ...lastGood, status: "ok", detail: detailFor(entry, nowMs) }
      : errorSnapshot(options.provider, nowMs, options.source, detailFor(entry, nowMs));
  };

  return {
    serveDuringCooldown(key, nowMs) {
      const entry = store.get(key);
      if (!entry || nowMs >= entry.cooldownUntilMs) {
        return null;
      }
      return snapshotForCooldown(entry, nowMs);
    },
    rememberLastGood(key, snapshot) {
      const entry = entryFor(key);
      entry.lastGoodSnapshot = snapshot;
      entry.cooldownUntilMs = 0;
    },
    enterCooldown(key, nowMs, retryAfterMs) {
      const entry = entryFor(key);
      const backoffMs = Math.min(
        Math.max(retryAfterMs ?? defaultCooldownMs, 0) || defaultCooldownMs,
        maxCooldownMs,
      );
      entry.cooldownUntilMs = nowMs + backoffMs;
      return snapshotForCooldown(entry, nowMs);
    },
    reset() {
      store.clear();
    },
  };
}
