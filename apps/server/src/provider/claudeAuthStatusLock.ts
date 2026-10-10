// FILE: claudeAuthStatusLock.ts
// Purpose: Serialize every `claude auth status` invocation across this process.
// Layer: Provider utility (dependency-free, in-process only).
// Exports: acquireClaudeAuthStatusLock()
//
// Why this exists
// ----------------
// `claude auth status` can redeem a single-use rotating OAuth refresh token when the
// stored access token is at/near expiry. If two invocations race (e.g. the macOS
// credential keepalive timer firing at the same moment as a provider-health probe, or
// either racing a Claude session start), the loser observes the token has already been
// rotated out from under it and reports `{"loggedIn":false}` even though the account is
// authenticated. Funneling every `claude auth status` call through this FIFO mutex
// ensures at most one invocation is in flight at a time within this process, which
// removes the race entirely.
//
// This is intentionally a plain, dependency-free promise chain (no Effect import) so it
// can be shared as-is by both the plain-Node keepalive job and the Effect-based health
// check.

let tail: Promise<unknown> = Promise.resolve();

/**
 * Acquire the lock, resolving once it is this caller's turn. Callers MUST invoke the
 * returned release function exactly once when done (though calling it more than once is
 * harmless) so the next queued acquirer can proceed.
 */
export function acquireClaudeAuthStatusLock(): Promise<() => void> {
  const previousTail = tail;

  let resolveHeld: () => void;
  const held = new Promise<void>((resolve) => {
    resolveHeld = resolve;
  });

  // Advance the shared tail immediately so any acquirer registered after this call
  // waits for both everyone ahead of it AND this holder's eventual release.
  tail = previousTail.then(() => held);

  return previousTail.then(() => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      resolveHeld();
    };
  });
}
