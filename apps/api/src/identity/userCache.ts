// FILE: identity/userCache.ts
// Purpose: Reuse a user the identity provider just described, so the routine
// reads an authorized request makes do not each cost a provider round trip.
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

/** Drops every cached user. Exported for tests. */
export function clearUserCache(): void {
  cache.clear();
}

/** Drops `userId`'s cached user, for the paths that delete the provider account. */
export function invalidateUserCache(userId: string): void {
  cache.delete(userId);
}

/**
 * The provider's description of `userId`, from the cache when a recent enough
 * copy exists.
 *
 * `fresh` skips the cached copy and asks the provider now, for privileged or
 * mutating callers that must see a deleted account immediately; a successful
 * fresh answer still refills the cache for subsequent reads. A failure is
 * never cached. A 404 (the account no longer exists) also evicts any copy, so
 * the next read asks again rather than describing a deleted user; the error
 * propagates unchanged so callers keep mapping it to their own answer.
 */
export async function getCachedUser(
  deps: UserCacheDeps,
  userId: string,
  options?: { fresh?: boolean },
): Promise<IdentityUser> {
  const clock = deps.now ?? Date.now;
  const cached = options?.fresh ? undefined : cache.get(userId);
  if (cached) {
    const age = clock() - cached.fetchedAt;
    if (age >= 0 && age < CACHE_TTL_MS) return cached.user;
  }
  let user: IdentityUser;
  try {
    user = await deps.getUser(userId);
  } catch (error) {
    if (error instanceof IdentityProviderError && error.status === 404) cache.delete(userId);
    throw error;
  }
  cache.set(userId, { user, fetchedAt: clock() });
  return user;
}
