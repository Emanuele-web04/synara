// FILE: threadDetailCache.ts
// Purpose: IndexedDB-backed per-thread detail cache. Reopening a chat paints its
//          last-seen message/activity tail immediately; the live snapshot then
//          reconciles it through the normal by-id merge, so stale rows self-correct.
// Layer: Web store persistence

import type { MessageId, ThreadId } from "@synara/contracts";

import { awaitIdbRequest, openIndexedDbDatabase, waitForIdbTransaction } from "./lib/indexedDb";
import { executionKey } from "./lib/hosts/executionContext";
import { isPlainObject } from "./persistedRecord";
import { useStore } from "./store";
import type { AppState } from "./storeState";
import type { ChatMessage, Thread } from "./types";

export const THREAD_DETAIL_CACHE_DB_NAME = "synara-thread-detail";
export const THREAD_DETAIL_CACHE_MAX_MESSAGES = 150;
export const THREAD_DETAIL_CACHE_MAX_ACTIVITIES = 300;
export const THREAD_DETAIL_CACHE_MAX_THREADS = 60;
const MEMORY_MIRROR_MAX_THREADS = 20;
const PERSIST_DEBOUNCE_MS = 800;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface CachedThreadDetailEntry {
  readonly key: string;
  readonly threadId: ThreadId;
  readonly messages: ChatMessage[];
  readonly activities: Thread["activities"];
  readonly updatedAt: number;
}

// Same-session mirror of the last slices persisted per thread. Reading the
// mirror is synchronous, so a reopened thread paints without waiting on the
// IndexedDB round-trip that sits between mount and the async hydrate.
const memoryMirrorByThreadId = new Map<
  ThreadId,
  Pick<CachedThreadDetailEntry, "messages" | "activities">
>();

function writeMemoryMirror(
  threadId: ThreadId,
  slices: Pick<CachedThreadDetailEntry, "messages" | "activities">,
): void {
  memoryMirrorByThreadId.delete(threadId);
  memoryMirrorByThreadId.set(threadId, slices);
  if (memoryMirrorByThreadId.size > MEMORY_MIRROR_MAX_THREADS) {
    const oldest = memoryMirrorByThreadId.keys().next().value;
    if (oldest !== undefined) memoryMirrorByThreadId.delete(oldest);
  }
}

let databasePromise: Promise<IDBDatabase | null> | null = null;
let lastPruneAt = 0;

function openCacheDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;
  databasePromise =
    typeof indexedDB === "undefined"
      ? Promise.resolve(null)
      : openIndexedDbDatabase({
          name: THREAD_DETAIL_CACHE_DB_NAME,
          version: 1,
          storeName: "threads",
          keyPath: "key",
          label: "Thread detail cache",
        }).catch(() => null);
  return databasePromise;
}

// The cache key rides the execution namespace so threads from different
// environments sharing an origin (local app vs a remote host) never collide.
function readCacheKey(threadId: ThreadId): string {
  return executionKey(`thread-detail:${threadId}`);
}

function isCachedEntry(value: unknown): value is CachedThreadDetailEntry {
  return (
    isPlainObject(value) &&
    typeof value.key === "string" &&
    typeof value.threadId === "string" &&
    Array.isArray(value.messages) &&
    Array.isArray(value.activities) &&
    typeof value.updatedAt === "number"
  );
}

async function readCachedThreadDetail(threadId: ThreadId): Promise<CachedThreadDetailEntry | null> {
  const database = await openCacheDatabase();
  if (!database) return null;
  try {
    const value = await awaitIdbRequest(
      database
        .transaction("threads", "readonly")
        .objectStore("threads")
        .get(readCacheKey(threadId)),
      "Could not read the cached thread detail.",
    );
    return isCachedEntry(value) ? value : null;
  } catch {
    return null;
  }
}

async function deleteCachedThreadDetail(threadId: ThreadId): Promise<void> {
  memoryMirrorByThreadId.delete(threadId);
  const database = await openCacheDatabase();
  if (!database) return;
  try {
    await awaitIdbRequest(
      database
        .transaction("threads", "readwrite")
        .objectStore("threads")
        .delete(readCacheKey(threadId)),
      "Could not delete the cached thread detail.",
    );
  } catch {
    // A failed eviction only keeps a stale advisory entry.
  }
}

async function writeCachedThreadDetail(entry: CachedThreadDetailEntry): Promise<void> {
  const database = await openCacheDatabase();
  if (!database) return;
  try {
    const transaction = database.transaction("threads", "readwrite");
    transaction.objectStore("threads").put(entry);
    await waitForIdbTransaction(transaction, "Thread detail cache write");
    void maybePruneCache(database);
  } catch {
    // Cache writes are advisory; never surface them to the sync path.
  }
}

async function maybePruneCache(database: IDBDatabase): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  try {
    const entries = await awaitIdbRequest(
      database.transaction("threads", "readonly").objectStore("threads").getAll(),
      "Could not list the cached thread details.",
    );
    if (!Array.isArray(entries) || entries.length <= THREAD_DETAIL_CACHE_MAX_THREADS) return;
    const keysByAge = entries
      .filter(isCachedEntry)
      .toSorted((left, right) => left.updatedAt - right.updatedAt)
      .slice(0, entries.length - THREAD_DETAIL_CACHE_MAX_THREADS)
      .map((entry) => entry.key);
    const transaction = database.transaction("threads", "readwrite");
    const store = transaction.objectStore("threads");
    for (const key of keysByAge) {
      store.delete(key);
    }
  } catch {
    // Pruning is best-effort.
  }
}

/**
 * Injects a cached tail into the normalized store slices, only while the thread
 * still has no detail. The next authoritative snapshot reconciles by message id:
 * cached rows still valid merge, rows the server removed are dropped by the same
 * hot-path retention rules local dispatches already follow.
 */
export function mergeCachedThreadDetailIntoState(
  state: AppState,
  threadId: ThreadId,
  entry: Pick<CachedThreadDetailEntry, "messages" | "activities">,
): AppState {
  if (state.deletedThreadIdsById?.[threadId] !== undefined) return state;
  const existingMessageIds = state.messageIdsByThreadId?.[threadId];
  const existingActivityIds = state.activityIdsByThreadId?.[threadId];
  if (
    (existingMessageIds !== undefined && existingMessageIds.length > 0) ||
    (existingActivityIds !== undefined && existingActivityIds.length > 0)
  ) {
    return state;
  }
  if (entry.messages.length === 0 && entry.activities.length === 0) return state;

  const messageById: Record<MessageId, ChatMessage> = {};
  for (const message of entry.messages) {
    messageById[message.id] = message;
  }
  const activityById: Record<string, Thread["activities"][number]> = {};
  for (const activity of entry.activities) {
    activityById[activity.id] = activity;
  }
  return {
    ...state,
    messageIdsByThreadId: {
      ...state.messageIdsByThreadId,
      [threadId]: entry.messages.map((message) => message.id),
    },
    messageByThreadId: { ...state.messageByThreadId, [threadId]: messageById },
    activityIdsByThreadId: {
      ...state.activityIdsByThreadId,
      [threadId]: entry.activities.map((activity) => activity.id),
    },
    activityByThreadId: { ...state.activityByThreadId, [threadId]: activityById },
  };
}

/**
 * Paints the cached tail before the first detail snapshot lands. No-op when the
 * thread already holds detail (live events beat the cache read) or is tombstoned.
 */
const hydrateInFlightThreadIds = new Set<ThreadId>();

export async function hydrateThreadDetailFromCache(threadId: ThreadId): Promise<boolean> {
  const mirrored = memoryMirrorByThreadId.get(threadId);
  if (mirrored !== undefined && (mirrored.messages.length > 0 || mirrored.activities.length > 0)) {
    let applied = false;
    useStore.setState((state) => {
      const next = mergeCachedThreadDetailIntoState(state, threadId, mirrored);
      applied = next !== state;
      return next;
    });
    return applied;
  }
  if (hydrateInFlightThreadIds.has(threadId)) return false;
  hydrateInFlightThreadIds.add(threadId);
  try {
    const entry = await readCachedThreadDetail(threadId);
    if (!entry || (entry.messages.length === 0 && entry.activities.length === 0)) return false;
    let applied = false;
    useStore.setState((state) => {
      const next = mergeCachedThreadDetailIntoState(state, threadId, entry);
      applied = next !== state;
      return next;
    });
    if (applied) writeMemoryMirror(threadId, entry);
    return applied;
  } finally {
    hydrateInFlightThreadIds.delete(threadId);
  }
}

/** Slices a thread's store records down to the cacheable tail. Exported for tests. */
export function buildCachedThreadDetailEntry(
  state: AppState,
  threadId: ThreadId,
): Pick<CachedThreadDetailEntry, "messages" | "activities"> | null {
  const messageIds = state.messageIdsByThreadId?.[threadId];
  const messageById = state.messageByThreadId?.[threadId];
  const activityIds = state.activityIdsByThreadId?.[threadId];
  const activityById = state.activityByThreadId?.[threadId];
  const messages = (messageIds ?? [])
    .map((id) => messageById?.[id])
    .filter((message): message is ChatMessage => message !== undefined)
    .slice(-THREAD_DETAIL_CACHE_MAX_MESSAGES)
    // A still-streaming row persisted with the flag set could linger forever
    // when the server rolled it back while the app was closed.
    .map((message) => (message.streaming ? { ...message, streaming: false } : message));
  const activities = (activityIds ?? [])
    .map((id) => activityById?.[id])
    .filter((activity): activity is Thread["activities"][number] => activity !== undefined)
    .slice(-THREAD_DETAIL_CACHE_MAX_ACTIVITIES);
  if (messages.length === 0 && activities.length === 0) return null;
  return { messages, activities };
}

async function persistThreadDetailNow(threadId: ThreadId): Promise<void> {
  const state = useStore.getState();
  if (state.deletedThreadIdsById?.[threadId] !== undefined) {
    await deleteCachedThreadDetail(threadId);
    return;
  }
  const slices = buildCachedThreadDetailEntry(state, threadId);
  if (!slices) return;
  writeMemoryMirror(threadId, slices);
  await writeCachedThreadDetail({
    key: readCacheKey(threadId),
    threadId,
    messages: slices.messages,
    activities: slices.activities,
    updatedAt: Date.now(),
  });
}

const pendingPersistTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
const trackedThreadIds = new Set<ThreadId>();
const lastSeenSlicesByThreadId = new Map<
  ThreadId,
  { messages: unknown; activities: unknown } | undefined
>();
let subscriptionInstalled = false;

function schedulePersistThreadDetail(threadId: ThreadId): void {
  const existing = pendingPersistTimers.get(threadId);
  if (existing !== undefined) clearTimeout(existing);
  pendingPersistTimers.set(
    threadId,
    setTimeout(() => {
      pendingPersistTimers.delete(threadId);
      void persistThreadDetailNow(threadId);
    }, PERSIST_DEBOUNCE_MS),
  );
}

function onStoreChange(state: AppState): void {
  for (const threadId of trackedThreadIds) {
    const messages = state.messageByThreadId?.[threadId];
    const activities = state.activityByThreadId?.[threadId];
    const lastSeen = lastSeenSlicesByThreadId.get(threadId);
    if (
      lastSeen !== undefined &&
      lastSeen.messages === messages &&
      lastSeen.activities === activities
    ) {
      continue;
    }
    lastSeenSlicesByThreadId.set(threadId, { messages, activities });
    if (state.deletedThreadIdsById?.[threadId] !== undefined) {
      void deleteCachedThreadDetail(threadId);
      continue;
    }
    if (
      (messages && Object.keys(messages).length > 0) ||
      (activities && Object.keys(activities).length > 0)
    ) {
      schedulePersistThreadDetail(threadId);
    }
  }
}

function installSubscription(): void {
  if (subscriptionInstalled) return;
  subscriptionInstalled = true;
  useStore.subscribe(onStoreChange);
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushPendingThreadDetailPersists);
  }
}

/** Watches a subscribed thread's detail slices and keeps its cache entry fresh. */
export function trackThreadDetailCache(threadId: ThreadId): void {
  installSubscription();
  trackedThreadIds.add(threadId);
  const state = useStore.getState();
  lastSeenSlicesByThreadId.set(threadId, {
    messages: state.messageByThreadId?.[threadId],
    activities: state.activityByThreadId?.[threadId],
  });
}

export function untrackThreadDetailCache(threadId: ThreadId): void {
  trackedThreadIds.delete(threadId);
  lastSeenSlicesByThreadId.delete(threadId);
  const pending = pendingPersistTimers.get(threadId);
  if (pending !== undefined) {
    clearTimeout(pending);
    pendingPersistTimers.delete(threadId);
    // A tracked thread leaving the lease keeps whatever it accumulated so the
    // next open can paint it; flush now because slices may be evicted next.
    void persistThreadDetailNow(threadId);
  }
}

export function flushPendingThreadDetailPersists(): void {
  for (const threadId of pendingPersistTimers.keys()) {
    const pending = pendingPersistTimers.get(threadId);
    if (pending !== undefined) clearTimeout(pending);
    pendingPersistTimers.delete(threadId);
    void persistThreadDetailNow(threadId);
  }
}

/** Test hook: restores the module's tracking state between files. */
export function resetThreadDetailCacheForTests(): void {
  trackedThreadIds.clear();
  memoryMirrorByThreadId.clear();
  hydrateInFlightThreadIds.clear();
  lastSeenSlicesByThreadId.clear();
  for (const timer of pendingPersistTimers.values()) clearTimeout(timer);
  pendingPersistTimers.clear();
  databasePromise = null;
  lastPruneAt = 0;
}
