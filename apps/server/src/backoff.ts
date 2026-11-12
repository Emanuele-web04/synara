// FILE: backoff.ts
// Purpose: Retry spacing shared by the account-API pollers, so each one
//          doubles, caps and spreads its delays the same way.
// Layer: Server utility (no IO)

/** Doubles from `baseMs` with each consecutive failure (counted from 1), up to `maxMs`. */
export function exponentialBackoffMs(failures: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(0, failures - 1), 30));
}

/**
 * Spreads a delay so hosts restarted together do not poll in step. `spread` is
 * the fraction to vary by; `towards: "shorter"` only ever shortens the delay,
 * for cadences that also bound how stale an answer may get.
 */
export function jitterMs(
  ms: number,
  options: { readonly spread?: number; readonly towards?: "both" | "shorter" } = {},
  random: () => number = Math.random,
): number {
  const spread = options.spread ?? 0.1;
  return options.towards === "shorter"
    ? ms * (1 - spread * random())
    : ms * (1 - spread + 2 * spread * random());
}
