import { OrchestrationThreadDetailSnapshot, type ThreadId } from "@synara/contracts";
import { Schema } from "effect";
import type { AppState } from "./storeState";
import { getThreadFromState } from "./threadDerivation";
import { useStore } from "./store";
import {
  getVerifiedThreadCacheIdentity,
  subscribeThreadCacheIdentity,
} from "./threadDetailCacheIdentity";
import {
  getThreadDetailResumeCursor,
  setThreadDetailResumeCursor,
} from "./threadDetailResumeCursors";
import {
  deleteThreadDetailCache,
  readThreadDetailCache,
  writeThreadDetailCache,
  type ThreadDetailCacheNamespace,
} from "./lib/threadDetailCache";

/** Called during idle flush, never while queuing or rendering a token. */
export function snapshotAppliedThreadDetail(
  state: AppState,
  id: ThreadId,
): OrchestrationThreadDetailSnapshot | null {
  const thread = getThreadFromState(state, id);
  const sequence = state.threadDetailAppliedSequenceById?.[id];
  if (!thread || sequence === undefined || state.threadDetailSyncById?.[id] !== "synced")
    return null;
  try {
    return Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot)({
      snapshotSequence: sequence,
      ...(state.threadHistoryById?.[id] ? { history: state.threadHistoryById[id] } : {}),
      thread: {
        ...thread,
        updatedAt: thread.updatedAt ?? thread.createdAt,
        deletedAt: null,
        messages: thread.messages.map((message) => ({
          ...message,
          turnId: message.turnId ?? null,
          updatedAt: message.updatedAt ?? message.createdAt,
          source: message.source ?? "native",
        })),
        checkpoints: thread.turnDiffSummaries
          .filter(
            (summary) =>
              summary.checkpointRef !== undefined && summary.checkpointTurnCount !== undefined,
          )
          .map((summary) => ({
            ...summary,
            assistantMessageId: summary.assistantMessageId ?? null,
            status: summary.status ?? "ready",
            files: summary.files.map((file) => ({
              ...file,
              kind: file.kind ?? "modified",
              additions: file.additions ?? 0,
              deletions: file.deletions ?? 0,
            })),
          })),
        session: thread.session
          ? {
              threadId: id,
              status: thread.session.orchestrationStatus,
              providerName: thread.session.provider,
              providerInstanceId: thread.session.providerInstanceId,
              runtimeMode: thread.runtimeMode,
              activeTurnId: thread.session.activeTurnId ?? null,
              lastError: thread.session.lastError ?? null,
              updatedAt: thread.session.updatedAt,
            }
          : null,
      },
    });
  } catch {
    return null;
  }
}

const namespace = (): ThreadDetailCacheNamespace | null => {
  const identity = getVerifiedThreadCacheIdentity();
  return identity && typeof location !== "undefined"
    ? { origin: location.origin, serverInstanceId: identity }
    : null;
};

export async function hydrateCachedThreadDetail(id: ThreadId): Promise<void> {
  const owner = namespace();
  if (
    !owner ||
    getThreadDetailResumeCursor(id) !== undefined ||
    useStore.getState().threadDetailSyncById?.[id] !== undefined
  )
    return;
  const record = await readThreadDetailCache(owner, id);
  if (!record || namespace()?.serverInstanceId !== owner.serverInstanceId) return;
  // Another stream may have hydrated while IDB was reading. The store action
  // checks tombstones, shell ownership and idle status again atomically.
  useStore.getState().restoreCachedThreadDetail(record);
  if (useStore.getState().threadDetailSyncById?.[id] === "cached")
    setThreadDetailResumeCursor(id, record.snapshotSequence);
}

/** One owner per EventRouter effect; only immutable committed state is queued. */
export function startThreadDetailCachePersistence(): () => void {
  const pending = new Map<ThreadId, { state: AppState; owner: ThreadDetailCacheNamespace }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idle: number | null = null;
  const deletions = new Map<ThreadId, ThreadDetailCacheNamespace>();
  let writing = false;
  let flushRequested = false;
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (idle !== null) window.cancelIdleCallback(idle);
    idle = null;
    if (writing) {
      flushRequested = true;
      return;
    }
    const batch = [...pending.entries()];
    const removed = [...deletions.entries()];
    pending.clear();
    deletions.clear();
    if (batch.length === 0 && removed.length === 0) return;
    writing = true;
    // At most one bounded batch is in flight. New tokens replace a pending
    // state reference rather than building a promise chain of old transcripts.
    void (async () => {
      for (const [id, owner] of removed) await deleteThreadDetailCache(owner, id);
      for (const [id, entry] of batch) {
        if (namespace()?.serverInstanceId !== entry.owner.serverInstanceId || deletions.has(id))
          continue;
        const snapshot = snapshotAppliedThreadDetail(entry.state, id);
        if (snapshot) await writeThreadDetailCache(entry.owner, snapshot);
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        writing = false;
        if (flushRequested) {
          flushRequested = false;
          flush();
        } else if (pending.size > 0 || deletions.size > 0) schedule();
      });
  };
  const schedule = () => {
    if (timer !== null || idle !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (typeof window.requestIdleCallback === "function")
        idle = window.requestIdleCallback(flush, { timeout: 1000 });
      else flush();
    }, 1000);
  };
  const unsubscribe = useStore.subscribe((state, previous) => {
    const owner = namespace();
    if (!owner) return;
    for (const id of previous.threadIds ?? []) {
      if (
        !state.threadShellById?.[id] ||
        state.deletedThreadIdsById?.[id] !== undefined ||
        (previous.threadShellById?.[id]?.projectId !== undefined &&
          state.deletedProjectIdsById?.[previous.threadShellById[id]!.projectId] !== undefined)
      ) {
        pending.delete(id);
        deletions.set(id, owner);
        // Durable entries are capped at 32. Retaining 512 recent removals also
        // covers cross-tab writers without unbounded deletion work in memory.
        if (deletions.size > 512) deletions.delete(deletions.keys().next().value!);
      }
    }
    for (const id of state.threadIds ?? []) {
      if (
        state.threadDetailSyncById?.[id] !== "synced" ||
        state.threadDetailAppliedSequenceById?.[id] === undefined
      )
        continue;
      if (
        state.threadDetailAppliedSequenceById[id] ===
          previous.threadDetailAppliedSequenceById?.[id] &&
        state.threadHistoryById?.[id] === previous.threadHistoryById?.[id] &&
        previous.threadDetailSyncById?.[id] === "synced"
      )
        continue;
      pending.set(id, { state, owner });
      if (pending.size > 20) pending.delete(pending.keys().next().value!);
    }
    if (pending.size > 0 || deletions.size > 0) schedule();
  });
  const unsubscribeIdentity = subscribeThreadCacheIdentity((_identity, previous) => {
    pending.clear();
    deletions.clear();
    if (previous !== null) {
      useStore
        .getState()
        .evictThreadDetails(
          Object.keys(useStore.getState().threadDetailSyncById ?? {}) as ThreadId[],
        );
      useStore.setState({
        shellSnapshotSequence: 0,
        deletedThreadIdsById: {},
        deletedProjectIdsById: {},
      });
    }
  });
  window.addEventListener("pagehide", flush);
  const onVisibility = () => {
    if (document.visibilityState === "hidden") flush();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    unsubscribe();
    unsubscribeIdentity();
    window.removeEventListener("pagehide", flush);
    document.removeEventListener("visibilitychange", onVisibility);
    flush();
  };
}
