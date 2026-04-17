import type { ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { useStore } from "./store";

const THREAD_DETAIL_RETENTION_EVICTION_MS = 15 * 60 * 1000;
const MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS = 32;

type RetainedThreadEntry = {
  refCount: number;
  lastAccessedAt: number;
  evictionTimeout: ReturnType<typeof setTimeout> | null;
};

const retainedThreadEntries = new Map<ThreadId, RetainedThreadEntry>();
const listeners = new Set<() => void>();
let cachedSnapshot: readonly ThreadId[] = [];

function emitChange(): void {
  cachedSnapshot = [...retainedThreadEntries.keys()];
  for (const listener of listeners) {
    listener();
  }
}

function isNonIdleThread(threadId: ThreadId): boolean {
  const state = useStore.getState();
  const sidebarThread = state.sidebarThreadSummaryById[threadId];

  if (sidebarThread) {
    if (
      sidebarThread.hasPendingApprovals ||
      sidebarThread.hasPendingUserInput ||
      sidebarThread.hasActionableProposedPlan ||
      sidebarThread.hasLiveTailWork
    ) {
      return true;
    }

    const orchestrationStatus = sidebarThread.session?.orchestrationStatus;
    if (
      orchestrationStatus &&
      orchestrationStatus !== "idle" &&
      orchestrationStatus !== "stopped"
    ) {
      return true;
    }

    if (sidebarThread.latestTurn?.state === "running") {
      return true;
    }
  }

  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    return false;
  }

  const orchestrationStatus = thread.session?.orchestrationStatus;
  return (
    Boolean(
      orchestrationStatus && orchestrationStatus !== "idle" && orchestrationStatus !== "stopped",
    ) ||
    thread.latestTurn?.state === "running" ||
    thread.pendingSourceProposedPlan !== undefined
  );
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

useStore.subscribe(() => {
  reconcileRetentionEntries();
});

export function retainThreadDetailSubscription(threadId: ThreadId): () => void {
  const existing = retainedThreadEntries.get(threadId);
  if (existing) {
    clearEvictionTimeout(existing);
    existing.refCount += 1;
    existing.lastAccessedAt = Date.now();
    return () => releaseThreadDetailSubscription(threadId);
  }

  retainedThreadEntries.set(threadId, {
    refCount: 1,
    lastAccessedAt: Date.now(),
    evictionTimeout: null,
  });
  emitChange();
  evictIdleEntriesToCapacity();

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
    return;
  }

  scheduleEviction(threadId, entry);
  evictIdleEntriesToCapacity();
}

export function subscribeRetainedThreadDetailIds(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRetainedThreadDetailIdsSnapshot(): readonly ThreadId[] {
  return cachedSnapshot;
}

export function useRetainedThreadDetailIds(): readonly ThreadId[] {
  return useSyncExternalStore(
    subscribeRetainedThreadDetailIds,
    getRetainedThreadDetailIdsSnapshot,
    getRetainedThreadDetailIdsSnapshot,
  );
}

export function resetRetainedThreadDetailSubscriptionsForTests(): void {
  for (const entry of retainedThreadEntries.values()) {
    clearEvictionTimeout(entry);
  }
  retainedThreadEntries.clear();
  emitChange();
}
