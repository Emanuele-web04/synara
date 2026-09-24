// FILE: groupThreadActivity.logic.ts
// Purpose: Derives the Group panel's "threads working" sparkline series from the
//          sidebar thread summaries already in the store — purely client-side,
//          no polling and no per-bucket server calls. Each thread contributes
//          one work interval (its latest turn, or its live session while no turn
//          exists yet) and the series counts how many intervals cover each
//          minute bucket of the trailing ~60-minute window.
// Layer: Group panel logic (pure)

import { isLatestTurnSettled } from "@synara/shared/groupThreadState";

/** Sparkline window: the trailing hour, or since the group's first thread when shorter. */
export const GROUP_THREAD_ACTIVITY_WINDOW_MS = 60 * 60 * 1000;
export const GROUP_THREAD_ACTIVITY_BUCKET_MS = 60 * 1000;

// A session spinning up or mid-turn without a turn snapshot counts as working —
// same vocabulary `resolveGroupThreadState` uses for its "working" bucket.
const ACTIVE_SESSION_STATUSES: ReadonlySet<string> = new Set(["connecting", "starting", "running"]);

export interface GroupThreadActivityTurnView {
  readonly state: string;
  readonly requestedAt?: string | null | undefined;
  readonly startedAt?: string | null | undefined;
  readonly completedAt?: string | null | undefined;
}

export interface GroupThreadActivitySessionView {
  readonly status: string;
  readonly orchestrationStatus?: string | undefined;
  readonly activeTurnId?: string | null | undefined;
  readonly createdAt?: string | null | undefined;
}

/** Structural subset of `SidebarThreadSummary` the activity series reads. */
export interface GroupThreadActivityThreadView {
  readonly createdAt?: string | null | undefined;
  readonly hasLiveTailWork?: boolean | undefined;
  readonly session?: GroupThreadActivitySessionView | null | undefined;
  readonly latestTurn?: GroupThreadActivityTurnView | null | undefined;
}

export interface GroupThreadActivitySeries {
  /** Working-thread count per bucket, oldest → newest; empty when no thread ever worked. */
  readonly points: readonly number[];
  /** Threads working at `windowEndMs` — the "N threads working now" figure. */
  readonly currentCount: number;
  readonly peakCount: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
}

function parseMs(value: string | null | undefined): number | null {
  if (value == null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The interval during which one thread counts as "working". A thread with a
 * turn works from that turn's start until it settles; a thread still spinning
 * up (live session or tail work, no turn yet) works from its session start
 * until now. Idle/closed threads with no turn data contribute nothing — they
 * never demonstrably worked.
 */
export function resolveGroupThreadWorkInterval(
  thread: GroupThreadActivityThreadView,
  nowMs: number,
): { readonly startMs: number; readonly endMs: number } | null {
  const latestTurn = thread.latestTurn ?? null;
  const session = thread.session ?? null;
  if (latestTurn !== null) {
    const startMs = parseMs(latestTurn.startedAt) ?? parseMs(latestTurn.requestedAt);
    if (startMs === null || startMs > nowMs) {
      return null;
    }
    const completedMs = parseMs(latestTurn.completedAt);
    const settled = isLatestTurnSettled(latestTurn, session);
    const endMs = settled && completedMs !== null ? completedMs : nowMs;
    return { startMs, endMs: Math.max(startMs, endMs) };
  }
  const sessionStatus = session === null ? null : (session.orchestrationStatus ?? session.status);
  if (
    thread.hasLiveTailWork === true ||
    (sessionStatus !== null && ACTIVE_SESSION_STATUSES.has(sessionStatus))
  ) {
    const startMs = parseMs(session?.createdAt) ?? parseMs(thread.createdAt);
    if (startMs === null || startMs > nowMs) {
      return null;
    }
    return { startMs, endMs: nowMs };
  }
  return null;
}

export function buildGroupThreadActivitySeries(input: {
  readonly threads: readonly GroupThreadActivityThreadView[];
  readonly nowMs?: number | undefined;
}): GroupThreadActivitySeries {
  const nowMs = input.nowMs === undefined ? Date.now() : input.nowMs;
  const empty: GroupThreadActivitySeries = {
    points: [],
    currentCount: 0,
    peakCount: 0,
    windowStartMs: nowMs,
    windowEndMs: nowMs,
  };
  if (input.threads.length === 0) {
    return empty;
  }
  const intervals: Array<{ startMs: number; endMs: number }> = [];
  let firstThreadMs: number | null = null;
  for (const thread of input.threads) {
    const createdMs = parseMs(thread.createdAt);
    if (createdMs !== null && (firstThreadMs === null || createdMs < firstThreadMs)) {
      firstThreadMs = createdMs;
    }
    const interval = resolveGroupThreadWorkInterval(thread, nowMs);
    if (interval !== null && interval.endMs > interval.startMs) {
      intervals.push(interval);
    }
  }
  if (intervals.length === 0) {
    return empty;
  }
  const windowStartMs = Math.max(
    nowMs - GROUP_THREAD_ACTIVITY_WINDOW_MS,
    firstThreadMs ?? nowMs - GROUP_THREAD_ACTIVITY_WINDOW_MS,
  );
  const bucketCount = Math.max(
    1,
    Math.ceil((nowMs - windowStartMs) / GROUP_THREAD_ACTIVITY_BUCKET_MS),
  );
  const points = Array.from({ length: bucketCount }, () => 0);
  let currentCount = 0;
  for (const interval of intervals) {
    if (interval.startMs <= nowMs && interval.endMs >= nowMs) {
      currentCount += 1;
    }
    const startMs = Math.max(interval.startMs, windowStartMs);
    const endMs = Math.min(interval.endMs, nowMs);
    if (endMs <= startMs) {
      continue;
    }
    const firstBucket = Math.max(
      0,
      Math.floor((startMs - windowStartMs) / GROUP_THREAD_ACTIVITY_BUCKET_MS),
    );
    const lastBucket = Math.min(
      bucketCount - 1,
      Math.floor((endMs - 1 - windowStartMs) / GROUP_THREAD_ACTIVITY_BUCKET_MS),
    );
    for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
      points[bucket] = (points[bucket] ?? 0) + 1;
    }
  }
  return {
    points,
    currentCount,
    peakCount: Math.max(...points),
    windowStartMs,
    windowEndMs: nowMs,
  };
}
