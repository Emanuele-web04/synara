/**
 * runtimeJournalPoisonGate - Decides when a blocked runtime-journal head row is poison.
 *
 * The runtime journal drains through a single global consumer cursor, so a
 * deterministically failing head row freezes projection for every thread and
 * every provider, durably, across restarts. This gate watches consecutive
 * blocked drains and declares the head row poison only when BOTH hold:
 *
 * - enough blocked drain attempts landed on the same cursor, and
 * - enough wall-clock time passed with zero cursor progress.
 *
 * The attempt count alone is not sufficient: every live event append also
 * triggers a drain, so a traffic burst during a transient stall (engine
 * overload, sqlite contention) racks up attempts in seconds. The time floor
 * alone is not sufficient either: a quiet install may only retry on the slow
 * durable poll, and a handful of attempts spread over a minute is weak
 * evidence. A deterministic failure re-blocks on the exact same row through
 * both gates. The cursor is monotonic, so observing a different cursor proves
 * progress and resets the gate.
 *
 * @module runtimeJournalPoisonGate
 */

export const RUNTIME_JOURNAL_POISON_DRAIN_LIMIT = 240;
export const RUNTIME_JOURNAL_POISON_MIN_BLOCKED_MS = 60_000;

export interface RuntimeJournalPoisonGate {
  /**
   * Record one blocked drain at the given consumer cursor. Returns true when
   * the head row after that cursor should be dead-lettered.
   */
  readonly noteBlockedDrain: (cursor: number, nowMs: number) => boolean;
  /** Forget all blocked-drain history, e.g. after a row was dead-lettered. */
  readonly reset: () => void;
}

export function makeRuntimeJournalPoisonGate(options?: {
  readonly attemptLimit?: number;
  readonly minBlockedMs?: number;
}): RuntimeJournalPoisonGate {
  const attemptLimit = Math.max(1, options?.attemptLimit ?? RUNTIME_JOURNAL_POISON_DRAIN_LIMIT);
  const minBlockedMs = Math.max(0, options?.minBlockedMs ?? RUNTIME_JOURNAL_POISON_MIN_BLOCKED_MS);

  let blockedCursor: number | null = null;
  let blockedCount = 0;
  let blockedSinceMs = 0;

  return {
    noteBlockedDrain: (cursor, nowMs) => {
      if (blockedCursor === cursor) {
        blockedCount += 1;
      } else {
        blockedCursor = cursor;
        blockedCount = 1;
        blockedSinceMs = nowMs;
      }
      return blockedCount >= attemptLimit && nowMs - blockedSinceMs >= minBlockedMs;
    },
    reset: () => {
      blockedCursor = null;
      blockedCount = 0;
      blockedSinceMs = 0;
    },
  };
}
