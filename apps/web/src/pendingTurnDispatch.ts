import type { ThreadId } from "@synara/contracts";

// the watchdog only re-syncs threads the store believes are busy; a lost session-set(running) event corrupts that belief — this signal comes from the composer dispatch, not the store
// armed on dispatch and re-armed when the turn RPC resolves (pre-dispatch work can outlive the age cap); cleared on RPC failure or confirmed rollback; else expired by the age cap
const pendingDispatchArmedAtByThreadId = new Map<ThreadId, number>();

// Upper bound on how long a pending dispatch keeps forcing catch-up work. Covers both leaked markers and a dispatched turn that settles before the watchdog ever observes a busy state (nothing else clears that marker).
export const PENDING_TURN_DISPATCH_MAX_AGE_MS = 30_000;

export function markPendingTurnDispatch(threadId: ThreadId): void {
  pendingDispatchArmedAtByThreadId.set(threadId, Date.now());
}

export function clearPendingTurnDispatch(threadId: ThreadId): void {
  pendingDispatchArmedAtByThreadId.delete(threadId);
}

export function hasPendingTurnDispatch(threadId: ThreadId): boolean {
  const armedAt = pendingDispatchArmedAtByThreadId.get(threadId);
  if (armedAt === undefined) {
    return false;
  }
  if (Date.now() - armedAt > PENDING_TURN_DISPATCH_MAX_AGE_MS) {
    pendingDispatchArmedAtByThreadId.delete(threadId);
    return false;
  }
  return true;
}
