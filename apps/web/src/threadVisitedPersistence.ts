// FILE: threadVisitedPersistence.ts
// Purpose: Persists which threads have an unseen completion, plus a watermark, so unread
//          state survives reloads.
// Exports: Initial lastVisitedAt resolution for hydration plus the store's writer.

import { hasUnseenCompletion, hasUnseenSnoozeReturn } from "./components/Sidebar.logic";
import { isPlainObject, sanitizeStringKeyedRecord } from "./persistedRecord";
import type { AppState } from "./storeState";
import type { SidebarThreadSummary } from "./types";

export const THREAD_VISITED_STORAGE_KEY = "synara:thread-visited:v1";
export const MAX_PERSISTED_VISITED_THREADS = 500;

interface PersistedThreadVisitedState {
  // The newest server time (thread update or turn completion) the app had seen when it
  // last saved. Server time, not this device's clock, so clock skew cannot misplace it.
  readonly watermarkAt: string | null;
  // The visits of threads that were unread at the last save. Every other thread counts
  // as read up to its last update, as long as that update is not after the watermark.
  readonly byThreadId: Readonly<Record<string, string>>;
}

let persisted: PersistedThreadVisitedState | null = null;
let lastSavedSummaries: AppState["sidebarThreadSummaryById"] | null = null;

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function readPersisted(): PersistedThreadVisitedState {
  if (persisted) return persisted;
  persisted = { watermarkAt: null, byThreadId: {} };
  if (typeof window === "undefined") return persisted;
  try {
    const raw = window.localStorage.getItem(THREAD_VISITED_STORAGE_KEY);
    // SAFETY: localStorage is only writable by same-origin scripts; every entry is
    // validated below and a malformed blob behaves like a first run.
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (isPlainObject(parsed)) {
      persisted = {
        watermarkAt: isTimestamp(parsed.watermarkAt) ? parsed.watermarkAt : null,
        byThreadId: sanitizeStringKeyedRecord(parsed.byThreadId, (entry) =>
          isTimestamp(entry) ? entry : null,
        ),
      };
    }
  } catch {
    // Corrupt JSON: keep the empty first-run state.
  }
  return persisted;
}

/**
 * lastVisitedAt for a thread the store sees for the first time: its saved visit,
 * otherwise, while the app restores its session (a full snapshot, or anything that
 * lands before the first one, like the last open thread's detail), updates up to the
 * last save count as seen, so turns that finished while the app was closed show as
 * unread. A thread that first appears through a live event after that (a new thread,
 * a fork) is new as it happens, and without any saved state every thread keeps the
 * old behavior of counting as read.
 */
export function resolveInitialLastVisitedAt(
  thread: ThreadServerTimes & { readonly id: string },
  options: { readonly restoringSession?: boolean } = {},
): string | undefined {
  const { watermarkAt, byThreadId } = readPersisted();
  const visitedAt = byThreadId[thread.id];
  if (visitedAt !== undefined) return visitedAt;
  const latestAt = latestServerTime(thread);
  if (
    options.restoringSession === true &&
    watermarkAt !== null &&
    latestAt !== undefined &&
    Date.parse(latestAt) > Date.parse(watermarkAt)
  ) {
    return watermarkAt;
  }
  return latestAt;
}

interface ThreadServerTimes {
  readonly updatedAt?: string | undefined;
  readonly latestTurn?: { readonly completedAt?: string | null | undefined } | null | undefined;
}

// A thread's newest server time: its last update or its latest turn's completion,
// whichever is later. The unread rule compares visits with the completion, so a thread
// seen "up to its update" alone could read as unread again.
function latestServerTime(thread: ThreadServerTimes): string | undefined {
  const completedAt = thread.latestTurn?.completedAt ?? undefined;
  return (Date.parse(completedAt ?? "") || 0) > (Date.parse(thread.updatedAt ?? "") || 0)
    ? completedAt
    : thread.updatedAt;
}

function latestServerTimeMs(thread: ThreadServerTimes): number {
  return Date.parse(latestServerTime(thread) ?? "") || 0;
}

function sameVisits(left: Readonly<Record<string, string>>, right: Record<string, string>) {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((threadId) => left[threadId] === right[threadId])
  );
}

/**
 * Saves the unread threads' visits and the watermark. Skips the work while the thread
 * summaries are unchanged (they are not touched on the streaming hot path) and the write
 * when nothing saved would change; `force` always writes (page unload).
 */
export function persistThreadVisitedState(
  state: AppState,
  options: { readonly force?: boolean } = {},
): void {
  if (typeof window === "undefined" || !state.threadsHydrated) return;
  const summaries = state.sidebarThreadSummaryById;
  if (!options.force && summaries === lastSavedSummaries) return;
  lastSavedSummaries = summaries;

  let watermarkMs = 0;
  let unread: SidebarThreadSummary[] = [];
  for (const thread of Object.values(summaries)) {
    watermarkMs = Math.max(watermarkMs, latestServerTimeMs(thread));
    if (
      thread.lastVisitedAt !== undefined &&
      (hasUnseenCompletion(thread) || hasUnseenSnoozeReturn(thread))
    ) {
      unread.push(thread);
    }
  }
  if (unread.length > MAX_PERSISTED_VISITED_THREADS) {
    unread = unread
      .toSorted((left, right) => latestServerTimeMs(right) - latestServerTimeMs(left))
      .slice(0, MAX_PERSISTED_VISITED_THREADS);
  }
  const byThreadId: Record<string, string> = {};
  for (const thread of unread) {
    byThreadId[thread.id] = thread.lastVisitedAt as string;
  }
  const previous = readPersisted();
  // The app has seen everything up to the saved watermark even when the thread that set
  // it is gone now, so the watermark never moves back.
  watermarkMs = Math.max(watermarkMs, Date.parse(previous.watermarkAt ?? "") || 0);
  const watermarkAt = watermarkMs > 0 ? new Date(watermarkMs).toISOString() : null;
  if (
    !options.force &&
    previous.watermarkAt === watermarkAt &&
    sameVisits(previous.byThreadId, byThreadId)
  ) {
    return;
  }
  const next = { watermarkAt, byThreadId };
  try {
    window.localStorage.setItem(THREAD_VISITED_STORAGE_KEY, JSON.stringify(next));
    persisted = next;
  } catch (error) {
    // Quota/private-mode failures only cost unread state after a reload.
    console.debug("Failed to persist thread visits", error);
  }
}
