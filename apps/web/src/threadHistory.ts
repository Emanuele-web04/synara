// Native history pages share the live detail store, never a second transcript.
import {
  ThreadId,
  type MessageId,
  type OrchestrationThreadDetailSnapshot,
} from "@synara/contracts";
import { useSyncExternalStore } from "react";
import { useStore } from "./store";
import { ensureNativeApi } from "./nativeApi";
import { getVerifiedThreadCacheIdentity } from "./threadDetailCacheIdentity";

interface LoadState {
  loading: boolean;
  error: string | null;
}
const EMPTY: LoadState = Object.freeze({ loading: false, error: null });
const states = new Map<ThreadId, LoadState>();
const requests = new Map<ThreadId, Promise<boolean>>();
const listeners = new Set<() => void>();
const notify = (id: ThreadId, state: LoadState) => {
  states.set(id, state);
  if (states.size > 32) {
    const completed = [...states.keys()].find((key) => !requests.has(key) && key !== id);
    if (completed) states.delete(completed);
  }
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function loadThreadHistoryPage(id: ThreadId): Promise<boolean> {
  const pending = requests.get(id);
  if (pending) return pending;
  const state = useStore.getState();
  const cursor = state.threadHistoryById?.[id]?.olderCursor;
  const activityCursor = state.threadHistoryById?.[id]?.olderActivityCursor;
  const originalHistory = state.threadHistoryById?.[id];
  const identity = getVerifiedThreadCacheIdentity();
  if ((!cursor && !activityCursor) || state.threadDetailSyncById?.[id] !== "synced")
    return Promise.resolve(false);
  notify(id, { loading: true, error: null });
  // Start after registering the promise: a synchronously unavailable API must
  // not leave a completed request installed forever.
  const request = Promise.resolve().then(async () => {
    try {
      const page: OrchestrationThreadDetailSnapshot | null =
        await ensureNativeApi().orchestration.getThreadDetailSnapshot({
          threadId: id,
          messageWindow: {
            limit: 100,
            ...(cursor ? { before: cursor } : {}),
            ...(activityCursor ? { beforeActivity: activityCursor } : {}),
          },
        });
      if (
        !page ||
        page.thread.id !== id ||
        !page.history ||
        (cursor &&
          page.history.olderCursor?.messageId === cursor.messageId &&
          (!activityCursor ||
            page.history.olderActivityCursor?.activityId === activityCursor.activityId)) ||
        getVerifiedThreadCacheIdentity() !== identity ||
        useStore.getState().threadHistoryById?.[id] !== originalHistory
      )
        return false;
      useStore.getState().mergeThreadHistoryPage(page, cursor ?? null, activityCursor);
      return useStore.getState().threadHistoryById?.[id] !== originalHistory;
    } catch (error) {
      notify(id, {
        loading: false,
        error: error instanceof Error ? error.message : "Could not load earlier messages.",
      });
      return false;
    } finally {
      requests.delete(id);
      const current = states.get(id);
      if (current?.loading) notify(id, { loading: false, error: null });
      // Only visible/failing load state needs retention. Requests are bounded by
      // thread leases, and completed entries must not accumulate with navigation.
      if (!states.get(id)?.error) states.delete(id);
    }
  });
  requests.set(id, request);
  return request;
}

/** Find, first-message and pinned/deep-link navigation explicitly request older text. */
export async function ensureThreadHistoryLoaded(
  id: ThreadId,
  target?: MessageId,
  cancelled: () => boolean = () => false,
): Promise<void> {
  while (
    !cancelled() &&
    (useStore.getState().threadHistoryById?.[id]?.olderCursor ||
      useStore.getState().threadHistoryById?.[id]?.olderActivityCursor)
  ) {
    if (target && useStore.getState().messageByThreadId?.[id]?.[target]) return;
    if (!(await loadThreadHistoryPage(id))) return;
  }
}

export function useThreadHistory(threadId: string) {
  const id = ThreadId.makeUnsafe(threadId);
  const history = useStore((state) => state.threadHistoryById?.[id]);
  const sync = useStore((state) => state.threadDetailSyncById?.[id]);
  const loading = useSyncExternalStore(
    subscribe,
    () => states.get(id) ?? EMPTY,
    () => EMPTY,
  );
  return {
    ...loading,
    nextCursor: history?.olderCursor ?? history?.olderActivityCursor ?? null,
    totalMessageCount: history?.totalMessageCount ?? 0,
    available: history !== undefined,
    loading:
      loading.loading ||
      ((history?.olderCursor != null || history?.olderActivityCursor != null) && sync !== "synced"),
    load: () => loadThreadHistoryPage(id),
  };
}
