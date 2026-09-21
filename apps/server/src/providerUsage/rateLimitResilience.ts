import type { ProviderKind, ServerProviderUsageSnapshot } from "@synara/contracts";

import { errorSnapshot } from "./parse";

/** fallback backoff when a 429 carries no usable Retry-After */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
/** cap so a huge/hostile Retry-After can't freeze usage on stale data for hours */
export const MAX_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
/** re-logins rotating tokens would grow the map unbounded; writes re-insert so iteration order is least-recently-written first */
const MAX_TRACKED_KEYS = 32;

interface ResilienceEntry {
  lastGoodSnapshot: ServerProviderUsageSnapshot | null;
  cooldownUntilMs: number;
}

export interface RateLimitResilience {
  /** snapshot to serve while `key` is throttled, or null */
  serveDuringCooldown(key: string, nowMs: number): ServerProviderUsageSnapshot | null;
  rememberLastGood(key: string, snapshot: ServerProviderUsageSnapshot, nowMs: number): void;
  /** begin a cooldown honoring Retry-After (clamped), then return the snapshot to serve */
  enterCooldown(
    key: string,
    nowMs: number,
    retryAfterMs: number | undefined,
  ): ServerProviderUsageSnapshot;
  /** test-only: drop all remembered state */
  reset(): void;
}

export function createRateLimitResilience(options: {
  provider: ProviderKind;
  source: string;
  detail: (retryMins: number) => string;
  defaultCooldownMs?: number;
  maxCooldownMs?: number;
}): RateLimitResilience {
  const defaultCooldownMs = options.defaultCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  const maxCooldownMs = options.maxCooldownMs ?? MAX_RATE_LIMIT_COOLDOWN_MS;
  const store = new Map<string, ResilienceEntry>();

  const entryFor = (key: string, nowMs: number): ResilienceEntry => {
    const existing = store.get(key);
    if (existing) {
      // re-insert so iteration order tracks write recency for eviction
      store.delete(key);
      store.set(key, existing);
      return existing;
    }
    // prefer the oldest inactive entry, but never discard an account mid-cooldown — that would resume requests against an endpoint that throttled us
    // may temporarily exceed the soft cap when 32+ accounts are cooling simultaneously
    if (store.size >= MAX_TRACKED_KEYS) {
      for (const [candidateKey, candidate] of store) {
        if (candidate.cooldownUntilMs <= nowMs) {
          store.delete(candidateKey);
          break;
        }
      }
    }
    const entry: ResilienceEntry = { lastGoodSnapshot: null, cooldownUntilMs: 0 };
    store.set(key, entry);
    return entry;
  };

  const detailFor = (entry: ResilienceEntry, nowMs: number): string =>
    options.detail(Math.max(1, Math.ceil((entry.cooldownUntilMs - nowMs) / 60_000)));

  // last clean fetch with a staleness note, else an explanatory error snapshot; the note rides status:"ok" so the UI keeps rendering; `stale:true` + original updatedAt distinguish a re-serve
  const snapshotForCooldown = (
    entry: ResilienceEntry,
    nowMs: number,
  ): ServerProviderUsageSnapshot => {
    const lastGood = entry.lastGoodSnapshot;
    return lastGood
      ? { ...lastGood, status: "ok", detail: detailFor(entry, nowMs), stale: true }
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
    rememberLastGood(key, snapshot, nowMs) {
      const entry = entryFor(key, nowMs);
      entry.lastGoodSnapshot = snapshot;
      entry.cooldownUntilMs = 0;
    },
    enterCooldown(key, nowMs, retryAfterMs) {
      const entry = entryFor(key, nowMs);
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
