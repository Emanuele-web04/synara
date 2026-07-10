// FILE: threadDetailPrewarm.ts
// Purpose: Short-lived thread-detail subscription prewarm controller for navigation intent.
// Layer: Web subscription utility
// Exports: Pure controller factory plus a React hook backed by thread-detail retention.

import type { ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { retainThreadDetailSubscription } from "./threadDetailSubscriptionRetention";

export const THREAD_DETAIL_PREWARM_RELEASE_MS = 10_000;
export const THREAD_DETAIL_PREWARM_LIMIT = 5;

type TimeoutHandle = ReturnType<typeof setTimeout>;
type RetainThreadDetailSubscription = (threadId: ThreadId) => () => void;

interface ThreadDetailPrewarmClock {
  setTimeout(callback: () => void, delayMs: number): TimeoutHandle;
  clearTimeout(timeoutId: TimeoutHandle): void;
}

interface RetainedThreadPrewarmEntry {
  release: () => void;
  timeoutId: TimeoutHandle;
}

export interface ThreadDetailPrewarmController {
  prewarmThreadDetail(threadId: ThreadId): void;
  prewarmThreadDetails(threadIds: readonly ThreadId[]): void;
  dispose(): void;
}

export interface ThreadDetailPrewarmControllerOptions {
  retainThreadDetailSubscription?: RetainThreadDetailSubscription | undefined;
  releaseMs?: number | undefined;
  maxRetainedThreads?: number | undefined;
  clock?: ThreadDetailPrewarmClock | undefined;
}

const DEFAULT_CLOCK: ThreadDetailPrewarmClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timeoutId) => clearTimeout(timeoutId),
};

function uniqueThreadIds(threadIds: readonly ThreadId[], limit: number): ThreadId[] {
  const nextThreadIds: ThreadId[] = [];
  const seenThreadIds = new Set<ThreadId>();

  for (const threadId of threadIds) {
    if (seenThreadIds.has(threadId)) {
      continue;
    }
    seenThreadIds.add(threadId);
    nextThreadIds.push(threadId);
    if (nextThreadIds.length >= limit) {
      break;
    }
  }

  return nextThreadIds;
}

export function createThreadDetailPrewarmController(
  options: ThreadDetailPrewarmControllerOptions = {},
): ThreadDetailPrewarmController {
  const retainThreadDetail =
    options.retainThreadDetailSubscription ?? retainThreadDetailSubscription;
  const releaseMs = options.releaseMs ?? THREAD_DETAIL_PREWARM_RELEASE_MS;
  const maxRetainedThreads = options.maxRetainedThreads ?? THREAD_DETAIL_PREWARM_LIMIT;
  const clock = options.clock ?? DEFAULT_CLOCK;
  const retainedThreadById = new Map<ThreadId, RetainedThreadPrewarmEntry>();

  const releaseThread = (threadId: ThreadId) => {
    const entry = retainedThreadById.get(threadId);
    if (!entry) {
      return;
    }
    clock.clearTimeout(entry.timeoutId);
    entry.release();
    retainedThreadById.delete(threadId);
  };

  const prewarmThreadDetail = (threadId: ThreadId) => {
    const existing = retainedThreadById.get(threadId);
    if (existing) {
      clock.clearTimeout(existing.timeoutId);
    }

    const release = existing?.release ?? retainThreadDetail(threadId);
    const timeoutId = clock.setTimeout(() => {
      const current = retainedThreadById.get(threadId);
      if (!current || current.release !== release) {
        return;
      }
      current.release();
      retainedThreadById.delete(threadId);
    }, releaseMs);

    retainedThreadById.set(threadId, { release, timeoutId });
  };

  return {
    prewarmThreadDetail,
    prewarmThreadDetails(threadIds) {
      const nextThreadIds = uniqueThreadIds(threadIds, maxRetainedThreads);
      const nextThreadIdSet = new Set(nextThreadIds);

      for (const threadId of nextThreadIds) {
        prewarmThreadDetail(threadId);
      }
      for (const threadId of [...retainedThreadById.keys()]) {
        if (!nextThreadIdSet.has(threadId)) {
          releaseThread(threadId);
        }
      }
    },
    dispose() {
      for (const threadId of [...retainedThreadById.keys()]) {
        releaseThread(threadId);
      }
    },
  };
}

export function useThreadDetailPrewarm(): Omit<ThreadDetailPrewarmController, "dispose"> {
  const controllerRef = useRef<ThreadDetailPrewarmController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createThreadDetailPrewarmController();
  }

  useEffect(
    () => () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
    },
    [],
  );

  const prewarmThreadDetail = useCallback((threadId: ThreadId) => {
    controllerRef.current?.prewarmThreadDetail(threadId);
  }, []);

  const prewarmThreadDetails = useCallback((threadIds: readonly ThreadId[]) => {
    controllerRef.current?.prewarmThreadDetails(threadIds);
  }, []);

  return useMemo(
    () => ({
      prewarmThreadDetail,
      prewarmThreadDetails,
    }),
    [prewarmThreadDetail, prewarmThreadDetails],
  );
}
