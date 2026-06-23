// FILE: threadDetailSubscriptionRetention.ts
// Purpose: Keep recently used thread-detail subscriptions warm across route/sidebar switches.
// Layer: Web subscription retention utility
// Exports: retain/release helpers plus React and imperative subscription listeners.

import type { ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { type AppState, useStore } from "./store";
import type { ThreadSession } from "./types";

const THREAD_DETAIL_RETENTION_EVICTION_MS = 15 * 60 * 1000;
const MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS = 32;

type RetainedThreadEntry = {
  refCount: number;
  lastAccessedAt: number;
  evictionTimeout: ReturnType<typeof setTimeout> | null;
};

const retainedThreadEntries = new Map<ThreadId, RetainedThreadEntry>();
const listeners = new Set<() => void>();
const retainedThreadIdChangeListeners = new Set<(threadIds: readonly ThreadId[]) => void>();
const liveRetainedThreadIdChangeListeners = new Set<(threadIds: readonly ThreadId[]) => void>();
let cachedSnapshot: readonly ThreadId[] = [];
let cachedLiveSnapshot: readonly ThreadId[] = [];
let retainedThreadStatusFingerprint = "";

function arraysEqual(left: readonly ThreadId[], right: readonly ThreadId[]): boolean {
  return left.length === right.length && left.every((threadId, index) => threadId === right[index]);
}

function buildLiveRetainedThreadIds(state: AppState): readonly ThreadId[] {
  const liveThreadIds: ThreadId[] = [];
  let threadById: Map<ThreadId, AppState["threads"][number]> | null = null;

  for (const [threadId, entry] of retainedThreadEntries) {
    if (entry.refCount > 0) {
      liveThreadIds.push(threadId);
      continue;
    }
    if (!state.sidebarThreadSummaryById[threadId] && threadById === null) {
      threadById = new Map(state.threads.map((thread) => [thread.id, thread] as const));
    }
    if (isNonIdleThreadFromState(threadId, state, threadById ?? undefined)) {
      liveThreadIds.push(threadId);
    }
  }

  return liveThreadIds;
}

function emitLiveChange(): void {
  const nextSnapshot = buildLiveRetainedThreadIds(useStore.getState());
  if (arraysEqual(cachedLiveSnapshot, nextSnapshot)) {
    return;
  }
  cachedLiveSnapshot = nextSnapshot;
  for (const listener of liveRetainedThreadIdChangeListeners) {
    listener(cachedLiveSnapshot);
  }
}

function emitChange(): void {
  cachedSnapshot = [...retainedThreadEntries.keys()];
  for (const listener of listeners) {
    listener();
  }
  for (const listener of retainedThreadIdChangeListeners) {
    listener(cachedSnapshot);
  }
  emitLiveChange();
}

function sessionHasLiveWork(
  session: Pick<ThreadSession, "activeTurnId" | "orchestrationStatus"> | null | undefined,
): boolean {
  return (
    session?.activeTurnId != null ||
    session?.orchestrationStatus === "starting" ||
    session?.orchestrationStatus === "running"
  );
}

function threadHasNonIdleStatus(thread: AppState["threads"][number]): boolean {
  return (
    sessionHasLiveWork(thread.session) ||
    thread.latestTurn?.state === "running" ||
    thread.pendingSourceProposedPlan !== undefined ||
    thread.hasPendingApprovals === true ||
    thread.hasPendingUserInput === true ||
    thread.hasActionableProposedPlan === true
  );
}

function isNonIdleThreadFromState(
  threadId: ThreadId,
  state: AppState,
  threadById?: ReadonlyMap<ThreadId, AppState["threads"][number]>,
): boolean {
  const sidebarThread = state.sidebarThreadSummaryById[threadId];

  if (sidebarThread) {
    if (
      sidebarThread.hasPendingApprovals ||
      sidebarThread.hasPendingUserInput ||
      sidebarThread.hasActionableProposedPlan
    ) {
      return true;
    }

    if (sessionHasLiveWork(sidebarThread.session)) {
      return true;
    }

    if (sidebarThread.latestTurn?.state === "running") {
      return true;
    }
  }

  const thread =
    threadById?.get(threadId) ?? state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    return false;
  }

  return threadHasNonIdleStatus(thread);
}

function isNonIdleThread(threadId: ThreadId): boolean {
  return isNonIdleThreadFromState(threadId, useStore.getState());
}

function buildRetainedStatusFingerprint(state: AppState): string {
  if (retainedThreadEntries.size === 0) {
    return "";
  }

  let threadById: Map<ThreadId, AppState["threads"][number]> | null = null;
  const parts: string[] = [];

  for (const threadId of retainedThreadEntries.keys()) {
    if (!state.sidebarThreadSummaryById[threadId] && threadById === null) {
      threadById = new Map(state.threads.map((thread) => [thread.id, thread] as const));
    }
    const nonIdle = isNonIdleThreadFromState(threadId, state, threadById ?? undefined);
    parts.push(`${threadId}:${nonIdle ? "1" : "0"}`);
  }

  return parts.join("\n");
}

function rememberRetainedStatusFingerprint(): void {
  retainedThreadStatusFingerprint = buildRetainedStatusFingerprint(useStore.getState());
}

function shouldEvictEntry(threadId: ThreadId, entry: RetainedThreadEntry): boolean {
  return entry.refCount === 0 && !isNonIdleThread(threadId);
}

function clearEvictionTimeout(entry: RetainedThreadEntry): void {
  if (entry.evictionTimeout === null) {
    return;
  }
  clearTimeout(entry.evictionTimeout);
  entry.evictionTimeout = null;
}

function scheduleEviction(threadId: ThreadId, entry: RetainedThreadEntry): void {
  clearEvictionTimeout(entry);
  if (!shouldEvictEntry(threadId, entry)) {
    return;
  }
  entry.evictionTimeout = setTimeout(() => {
    const currentEntry = retainedThreadEntries.get(threadId);
    if (!currentEntry || !shouldEvictEntry(threadId, currentEntry)) {
      return;
    }
    retainedThreadEntries.delete(threadId);
    emitChange();
    rememberRetainedStatusFingerprint();
  }, THREAD_DETAIL_RETENTION_EVICTION_MS);
}

function evictIdleEntriesToCapacity(): void {
  if (retainedThreadEntries.size <= MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS) {
    return;
  }

  const idleEntries = [...retainedThreadEntries.entries()]
    .filter((entry): entry is [ThreadId, RetainedThreadEntry] =>
      shouldEvictEntry(entry[0], entry[1]),
    )
    .toSorted((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt);

  for (const [threadId] of idleEntries) {
    if (retainedThreadEntries.size <= MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS) {
      return;
    }
    const entry = retainedThreadEntries.get(threadId);
    if (!entry || !shouldEvictEntry(threadId, entry)) {
      continue;
    }
    clearEvictionTimeout(entry);
    retainedThreadEntries.delete(threadId);
    emitChange();
    rememberRetainedStatusFingerprint();
  }
}

function reconcileRetentionEntries(): void {
  for (const [threadId, entry] of retainedThreadEntries) {
    clearEvictionTimeout(entry);
    if (shouldEvictEntry(threadId, entry)) {
      scheduleEviction(threadId, entry);
    }
  }
  evictIdleEntriesToCapacity();
}

useStore.subscribe((state) => {
  const nextFingerprint = buildRetainedStatusFingerprint(state);
  if (nextFingerprint === retainedThreadStatusFingerprint) {
    return;
  }
  retainedThreadStatusFingerprint = nextFingerprint;
  reconcileRetentionEntries();
  emitLiveChange();
});

export function retainThreadDetailSubscription(threadId: ThreadId): () => void {
  const existing = retainedThreadEntries.get(threadId);
  if (existing) {
    clearEvictionTimeout(existing);
    existing.refCount += 1;
    existing.lastAccessedAt = Date.now();
    emitLiveChange();
    return () => releaseThreadDetailSubscription(threadId);
  }

  retainedThreadEntries.set(threadId, {
    refCount: 1,
    lastAccessedAt: Date.now(),
    evictionTimeout: null,
  });
  emitChange();
  evictIdleEntriesToCapacity();
  rememberRetainedStatusFingerprint();

  return () => releaseThreadDetailSubscription(threadId);
}

export function releaseThreadDetailSubscription(threadId: ThreadId): void {
  const entry = retainedThreadEntries.get(threadId);
  if (!entry) {
    return;
  }

  entry.refCount = Math.max(0, entry.refCount - 1);
  entry.lastAccessedAt = Date.now();
  if (entry.refCount > 0) {
    emitLiveChange();
    return;
  }

  scheduleEviction(threadId, entry);
  evictIdleEntriesToCapacity();
  emitLiveChange();
  rememberRetainedStatusFingerprint();
}

export function subscribeRetainedThreadDetailIds(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeRetainedThreadDetailIdChanges(
  listener: (threadIds: readonly ThreadId[]) => void,
): () => void {
  retainedThreadIdChangeListeners.add(listener);
  return () => {
    retainedThreadIdChangeListeners.delete(listener);
  };
}

export function subscribeLiveRetainedThreadDetailIdChanges(
  listener: (threadIds: readonly ThreadId[]) => void,
): () => void {
  liveRetainedThreadIdChangeListeners.add(listener);
  return () => {
    liveRetainedThreadIdChangeListeners.delete(listener);
  };
}

export function getRetainedThreadDetailIdsSnapshot(): readonly ThreadId[] {
  return cachedSnapshot;
}

export function getLiveRetainedThreadDetailIdsSnapshot(): readonly ThreadId[] {
  return cachedLiveSnapshot;
}

export function useRetainedThreadDetailIds(): readonly ThreadId[] {
  return useSyncExternalStore(
    subscribeRetainedThreadDetailIds,
    getRetainedThreadDetailIdsSnapshot,
    getRetainedThreadDetailIdsSnapshot,
  );
}

export function useLiveRetainedThreadDetailIds(): readonly ThreadId[] {
  return useSyncExternalStore(
    subscribeLiveRetainedThreadDetailIdChanges,
    getLiveRetainedThreadDetailIdsSnapshot,
    getLiveRetainedThreadDetailIdsSnapshot,
  );
}

export function resetRetainedThreadDetailSubscriptionsForTests(): void {
  for (const entry of retainedThreadEntries.values()) {
    clearEvictionTimeout(entry);
  }
  retainedThreadEntries.clear();
  emitChange();
  cachedLiveSnapshot = [];
  rememberRetainedStatusFingerprint();
}
