/** a deterministically failing head row freezes projection for every thread durably; poison only when BOTH hold: enough blocked drains on the same cursor AND enough wall-clock with zero progress — attempts alone misfire on traffic bursts, time alone is weak evidence on a quiet install; the cursor is monotonic so a different one proves progress and resets */

export const RUNTIME_JOURNAL_POISON_DRAIN_LIMIT = 240;
export const RUNTIME_JOURNAL_POISON_MIN_BLOCKED_MS = 60_000;

export interface RuntimeJournalPoisonGate {
  /** true when the head row after that cursor should be dead-lettered */
  readonly noteBlockedDrain: (cursor: number, nowMs: number) => boolean;
  /** forget all blocked-drain history, e.g. after a dead-letter */
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
