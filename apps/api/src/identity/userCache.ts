// FILE: identity/userCache.ts
// Purpose: Reuse a user the identity provider just described, so the routine
// reads an authorized request makes do not each cost a provider round trip —
// and so those reads survive a provider hiccup instead of failing with it.
// Same discipline as the membership cache in orgProvisioning.ts: per process,
// a short TTL, a `fresh` read for privileged callers, and failures never
// cached. Provider-neutral: the provider's lookup arrives as an injected
// function speaking seam types.
// Layer: API identity (implementation support)
// Depends on: interfaces.ts (seam types).

import { IdentityProviderError, type IdentityUser } from "./interfaces";

/**
 * How long a user is reused before the provider is asked again. Matches the
 * membership cache, so a read route has one staleness bound for both halves of
 * its authorization answer.
 */
const CACHE_TTL_MS = 60_000;

/**
 * How old an entry may be and still answer a plain read whose provider lookup
 * just failed. Ten minutes covers a provider incident of a few minutes and two
 * rounds of the clients' slowest routine cadence (the 5-minute idle poll),
 * while staying a hard bound: past it a read fails with the provider, exactly
 * as it did before this cache existed. It only ever answers reads — a `fresh`
 * (mutating or admission) caller is never served from here — and what it can
 * prolong is a name, email and avatar, plus read access for an account deleted
 * directly at the provider while the provider is also unreachable. Erasure
 * requested through this API is refused by the durable deletion fence before
 * any request reaches this cache.
 */
const STALE_IF_ERROR_MS = 10 * 60_000;

/**
 * How many stored entries each lookup may examine for expiry, as in
 * rateLimit.ts: no lookup pays for more than this many, and a burst of one-off
 * users is reclaimed across the lookups that follow it. No timer, so nothing
 * keeps the process (or a test) alive.
 */
const PRUNE_BATCH = 8;

/** The provider surface this module needs, as a function rather than the whole client. */
export type UserCacheDeps = {
  getUser(userId: string): Promise<IdentityUser>;
  /** Injectable clock, so the TTL can be tested without waiting a minute. */
  now?: () => number;
};

type CacheEntry = {
  user: IdentityUser;
  fetchedAt: number;
};

/**
 * Per process, not per request: the point is to survive across the several
 * requests a client makes in a burst. A restart or a deploy simply refills it,
 * and nothing here is authoritative. In particular it is never the account
 * deletion fence: every authenticated request checks the durable deletion
 * tombstone before it gets here.
 */
const cache = new Map<string, CacheEntry>();

/**
 * The provider lookup currently in flight per user, so concurrent cold reads
 * share one call. Only plain reads ever wait on an entry here. A `fresh`
 * caller always makes its own call — it must not inherit an answer the
 * provider may have produced before its request arrived — though the call it
 * makes is offered to plain readers when no other is in flight.
 */
const inFlight = new Map<string, Promise<IdentityUser>>();

/**
 * Bumped whenever an entry is deliberately dropped. A lookup that started
 * before the drop must not write its answer back afterwards, or a user deleted
 * mid-flight would be cached again by the read that raced the deletion. Global
 * rather than per user: drops are rare, and the only cost to an unrelated
 * lookup is one missed cache fill.
 */
let generation = 0;

/** Insertion-order cursor for incremental pruning; undefined between passes. */
let pruneCursor: Iterator<[string, CacheEntry]> | undefined;

/** Whether an entry is too old (or from a clock since moved back) to use at `maxAgeMs`. */
function isWithin(entry: CacheEntry, now: number, maxAgeMs: number): boolean {
  const age = now - entry.fetchedAt;
  return age >= 0 && age < maxAgeMs;
}

/**
 * Deletes entries no read can use any more — older than the stale window —
 * walking at most {@link PRUNE_BATCH} of them per call. Deletions during
 * iteration are safe on a Map, and a user re-inserted after deletion is simply
 * visited again on a later pass.
 */
function pruneSome(now: number): void {
  pruneCursor ??= cache.entries();
  for (let step = 0; step < PRUNE_BATCH; step += 1) {
    const next = pruneCursor.next();
    if (next.done) {
      pruneCursor = undefined;
      return;
    }
    const [userId, entry] = next.value;
    if (!isWithin(entry, now, STALE_IF_ERROR_MS)) cache.delete(userId);
  }
}

/** Drops every cached user. Exported for tests. */
export function clearUserCache(): void {
  cache.clear();
  inFlight.clear();
  pruneCursor = undefined;
  generation += 1;
}

/** Drops `userId`'s cached user, for the paths that delete the provider account. */
export function invalidateUserCache(userId: string): void {
  cache.delete(userId);
  // A lookup already in flight may predate the deletion: later readers must
  // not share it, and it must not refill the cache when it lands.
  inFlight.delete(userId);
  generation += 1;
}

/** How many users are cached right now. Exported for tests. */
export function userCacheSize(): number {
  return cache.size;
}

/**
 * Asks the provider and records the answer. A 404 (the account no longer
 * exists) evicts any copy, so the next read asks again rather than describing
 * a deleted user. Any other failure leaves the stored entry alone.
 */
async function lookUp(deps: UserCacheDeps, userId: string, clock: () => number) {
  const startedIn = generation;
  let user: IdentityUser;
  try {
    user = await deps.getUser(userId);
  } catch (error) {
    if (error instanceof IdentityProviderError && error.status === 404) {
      cache.delete(userId);
      generation += 1;
    }
    throw error;
  }
  if (startedIn === generation) cache.set(userId, { user, fetchedAt: clock() });
  return user;
}

/** Runs a lookup, offering it to plain readers unless another is already in flight. */
function startLookup(
  deps: UserCacheDeps,
  userId: string,
  clock: () => number,
): Promise<IdentityUser> {
  const pending = lookUp(deps, userId, clock);
  if (!inFlight.has(userId)) {
    inFlight.set(userId, pending);
    const release = () => {
      if (inFlight.get(userId) === pending) inFlight.delete(userId);
    };
    pending.then(release, release);
  }
  return pending;
}

/**
 * The provider's description of `userId`, from the cache when a recent enough
 * copy exists.
 *
 * `fresh` skips the cached copy and asks the provider now, for privileged or
 * mutating callers that must see a deleted account immediately; a successful
 * fresh answer still refills the cache for subsequent reads. A fresh read is
 * never answered from a stored entry or from someone else's lookup: when the
 * provider fails, it fails.
 *
 * A plain read shares a lookup already in flight for the same user, and when
 * its lookup fails for any reason other than a 404 it falls back to the stored
 * entry if that is younger than {@link STALE_IF_ERROR_MS}. A 404 always
 * propagates unchanged, so callers keep mapping it to their own answer; a
 * failure with nothing usable stored propagates too. Failures are never
 * cached.
 */
export async function getCachedUser(
  deps: UserCacheDeps,
  userId: string,
  options?: { fresh?: boolean },
): Promise<IdentityUser> {
  const clock = deps.now ?? Date.now;
  pruneSome(clock());

  if (options?.fresh) return startLookup(deps, userId, clock);

  const cached = cache.get(userId);
  if (cached && isWithin(cached, clock(), CACHE_TTL_MS)) return cached.user;

  try {
    return await (inFlight.get(userId) ?? startLookup(deps, userId, clock));
  } catch (error) {
    if (error instanceof IdentityProviderError && error.status === 404) throw error;
    // Read again: the 404 of a concurrent lookup, or an invalidation, may have
    // dropped the entry while this one was in flight.
    const stale = cache.get(userId);
    if (stale && isWithin(stale, clock(), STALE_IF_ERROR_MS)) return stale.user;
    throw error;
  }
}
