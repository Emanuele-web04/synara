// FILE: islandThreadTracker.ts
// Purpose: Pure logic for selecting which thread the dynamic island should track.
// Layer: Web UI shared logic
// Why: The island needs one thread to show (most-recently-active running or pending).
//      Extracting the selection logic makes it testable independent of React/hooks.

import type { Thread } from "~/types";
import { isThreadRunningTurn } from "~/session-logic";

// A thread qualifies for active island display if it's running a turn OR has
// any pending state the user needs to act on (approvals, user-input, plan).
export function isThreadIslandActive(
  thread: Pick<
    Thread,
    | "session"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "hasActionableProposedPlan"
    | "archivedAt"
  >,
): boolean {
  if (thread.archivedAt) return false;
  if (isThreadRunningTurn(thread)) return true;
  if (thread.hasPendingApprovals === true) return true;
  if (thread.hasPendingUserInput === true) return true;
  if (thread.hasActionableProposedPlan === true) return true;
  return false;
}

// "Most-recently-active" timestamp: max of latestTurn.startedAt, last activity
// createdAt, updatedAt, createdAt. Handles null/undefined by falling back.
export function threadActivityTimestamp(
  thread: Pick<Thread, "latestTurn" | "activities" | "updatedAt" | "createdAt">,
): string {
  const candidates: string[] = [];
  if (thread.latestTurn?.startedAt) candidates.push(thread.latestTurn.startedAt);
  const lastActivity = thread.activities?.at(-1);
  if (lastActivity?.createdAt) candidates.push(lastActivity.createdAt);
  if (thread.updatedAt) candidates.push(thread.updatedAt);
  if (thread.createdAt) candidates.push(thread.createdAt);
  return candidates.length > 0 ? candidates.reduce((a, b) => (a > b ? a : b)) : "";
}

// Active mode: most-recently-active thread that is running OR has pending state.
// Returns null if no thread qualifies.
export function selectActiveIslandThread(threads: ReadonlyArray<Thread>): Thread | null {
  const active = threads.filter(isThreadIslandActive);
  if (active.length === 0) return null;
  return active.reduce((best, current) =>
    threadActivityTimestamp(current) > threadActivityTimestamp(best) ? current : best,
  );
}

// Idle mode: most-recently-active thread by updatedAt regardless of running/pending.
// Used for idle hover (shows last activity from any thread, not just running ones).
// Excludes archived threads.
export function selectIdleIslandThread(threads: ReadonlyArray<Thread>): Thread | null {
  const visible = threads.filter((t) => !t.archivedAt);
  if (visible.length === 0) return null;
  return visible.reduce((best, current) =>
    threadActivityTimestamp(current) > threadActivityTimestamp(best) ? current : best,
  );
}

// Recent threads for idle hover list (excluding archived, sorted by recency).
export function selectRecentIslandThreads(threads: ReadonlyArray<Thread>, limit = 5): Thread[] {
  const visible = threads.filter((t) => !t.archivedAt);
  return visible
    .toSorted((a, b) => threadActivityTimestamp(b).localeCompare(threadActivityTimestamp(a)))
    .slice(0, limit);
}
