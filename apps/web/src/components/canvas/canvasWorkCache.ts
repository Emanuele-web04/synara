// FILE: canvasWorkCache.ts
// Purpose: The query cache side of the canvas update pipeline: one subscriber per app applies
//          layer deltas to the cached work, refetches one work when it cannot, defers events
//          while this client's own writes are in flight, and never lets a work go backwards.
// Layer: Canvas data (React Query)
// Exports: query keys and options, storeCanvasWork, runCanvasWrite, handleCanvasChanged,
//          applyCanvasFrameDelta

import type { CanvasChangedEvent, CanvasWork } from "@synara/contracts";
import { applyDesignLayerEdits } from "@synara/shared/designCanvasLayers";
import { replaceEqualDeep, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const canvasQueryKey = ["canvas-library"] as const;
export const canvasWorkQueryKey = (workId: string) => [...canvasQueryKey, "work", workId] as const;
export const canvasTurnActivityQueryKey = (threadId: string) =>
  [...canvasQueryKey, "turns", threadId] as const;

const isOlder = (a: CanvasWork, b: CanvasWork) => Date.parse(a.updatedAt) < Date.parse(b.updatedAt);

/**
 * Every fetch and write of a work goes through this: an older copy (a refetch that raced a
 * newer write) never replaces a newer one, and unchanged pages, frames and layers keep their
 * identity so memoized frames and the keyed renderer skip them.
 */
function keepNewestWork(previous: unknown, next: unknown): unknown {
  const before = previous as CanvasWork | undefined;
  const after = next as CanvasWork;
  if (before && after && isOlder(after, before)) return before;
  return replaceEqualDeep(before, after);
}

export function canvasWorkQueryOptions(workId: string) {
  return {
    queryKey: canvasWorkQueryKey(workId),
    queryFn: () => ensureNativeApi().canvas.get({ workId }),
    structuralSharing: keepNewestWork,
  };
}

/** Writes a saved work to the cache unless the cache already holds a newer one. */
export function storeCanvasWork(client: QueryClient, work: CanvasWork) {
  client.setQueryData<CanvasWork>(
    canvasWorkQueryKey(work.id),
    (current) => keepNewestWork(current, work) as CanvasWork,
  );
}

type WorkSync = {
  writes: number;
  refetching: boolean;
  queue: CanvasChangedEvent[];
};
const syncs = new WeakMap<QueryClient, Map<string, WorkSync>>();
const listTimers = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();
/** Events beyond this while busy are dropped in favour of one refetch. */
const MAX_QUEUED_EVENTS = 64;

function syncFor(client: QueryClient, workId: string): WorkSync {
  let works = syncs.get(client);
  if (!works) syncs.set(client, (works = new Map()));
  let sync = works.get(workId);
  if (!sync) works.set(workId, (sync = { writes: 0, refetching: false, queue: [] }));
  return sync;
}

/**
 * The cached work with `event`'s delta applied, or null when the cache does not hold exactly
 * the state before it (then the caller refetches). Unchanged parts keep their identity.
 */
export function applyCanvasFrameDelta(
  work: CanvasWork,
  event: CanvasChangedEvent,
): CanvasWork | null {
  const { delta, pageId, frameId, revision, updatedAt, previousUpdatedAt } = event;
  if (!delta || !pageId || !frameId || !revision || !updatedAt) return null;
  if (previousUpdatedAt !== work.updatedAt) return null;
  const page = work.pages.find((item) => item.id === pageId);
  const frame = page?.frames.find((item) => item.id === frameId);
  if (!page || !frame || frame.revision !== revision - 1) return null;
  let layers;
  try {
    layers = applyDesignLayerEdits(frame.layers, delta.operations);
  } catch {
    return null;
  }
  const { style: _style, ...rest } = frame;
  const next = {
    ...rest,
    ...(delta.style ? { style: delta.style } : {}),
    revision,
    layers,
    lastLayerEdit: delta.lastLayerEdit,
  };
  return {
    ...work,
    updatedAt,
    pages: work.pages.map((item) =>
      item === page
        ? {
            ...page,
            frames: page.frames.map((candidate) => (candidate === frame ? next : candidate)),
          }
        : item,
    ),
  };
}

function refetchWork(client: QueryClient, workId: string, sync: WorkSync) {
  sync.refetching = true;
  void client
    .invalidateQueries({ queryKey: canvasWorkQueryKey(workId), exact: true })
    .catch(() => {})
    .finally(() => {
      sync.refetching = false;
      drain(client, workId, sync);
    });
}

/** Applies one work event to the cache; returns false when only a refetch can catch up. */
function applyWorkEvent(client: QueryClient, event: CanvasChangedEvent): boolean {
  const key = canvasWorkQueryKey(event.workId!);
  const cached = client.getQueryData<CanvasWork>(key);
  // Nothing loaded: whoever mounts it next fetches the current work anyway.
  if (!cached) return true;
  if (event.updatedAt && Date.parse(event.updatedAt) <= Date.parse(cached.updatedAt)) return true;
  const next = applyCanvasFrameDelta(cached, event);
  if (!next) return false;
  client.setQueryData<CanvasWork>(key, next);
  return true;
}

function drain(client: QueryClient, workId: string, sync: WorkSync) {
  if (sync.writes > 0 || sync.refetching) return;
  const queued = sync.queue.splice(0);
  // One refetch covers every event after the first that could not be applied.
  if (queued.some((event) => !applyWorkEvent(client, event))) refetchWork(client, workId, sync);
}

/** The list, folders and turn cards are summaries of works: refresh them, coalesced. */
function invalidateSummaries(client: QueryClient, everything = false) {
  if (listTimers.has(client)) return;
  listTimers.set(
    client,
    setTimeout(() => {
      listTimers.delete(client);
      void client.invalidateQueries({
        queryKey: canvasQueryKey,
        ...(everything ? {} : { predicate: (query) => query.queryKey[1] !== "work" }),
      });
    }, 120),
  );
}

/** Handles a `changed` event from the app's single canvas subscription. */
export function handleCanvasChanged(client: QueryClient, event: CanvasChangedEvent) {
  if (event.scope === "library") return invalidateSummaries(client);
  if (event.scope !== "work" || !event.workId) {
    // No scope: anything may have changed (reconnect, dropped events, folder archive).
    clearTimeout(listTimers.get(client));
    listTimers.delete(client);
    return invalidateSummaries(client, true);
  }
  invalidateSummaries(client);
  const sync = syncFor(client, event.workId);
  if (sync.writes > 0 || sync.refetching) {
    // This client's own write (or a refetch) settles first; the queue replays after it.
    if (sync.queue.length >= MAX_QUEUED_EVENTS) sync.queue.splice(1);
    sync.queue.push(event);
    return;
  }
  if (!applyWorkEvent(client, event)) refetchWork(client, event.workId, sync);
}

/**
 * Runs one of this client's writes to a work and stores the saved work it returns. Events
 * for that work wait until it settles, so the echo of this write is recognised as already
 * applied instead of triggering a refetch.
 */
export async function runCanvasWrite<A>(
  client: QueryClient,
  workId: string,
  task: () => Promise<A>,
  savedWork: (result: A) => CanvasWork = (result) => result as CanvasWork,
): Promise<A> {
  const sync = syncFor(client, workId);
  sync.writes++;
  try {
    const result = await task();
    storeCanvasWork(client, savedWork(result));
    return result;
  } finally {
    sync.writes--;
    drain(client, workId, sync);
  }
}
