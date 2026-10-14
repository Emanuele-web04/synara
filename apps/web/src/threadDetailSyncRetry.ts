// FILE: threadDetailSyncRetry.ts
// Purpose: Route all manual thread retries through the active subscription owner.
// Layer: Web subscription utility

import type { ThreadId } from "@synara/contracts";

type ThreadDetailSyncRetry = (threadId: ThreadId) => Promise<void>;
let activeRetry: ThreadDetailSyncRetry | null = null;

/** The owner supplies its lease checks, cursor fence and subscription queue. */
export function registerThreadDetailSyncRetry(retry: ThreadDetailSyncRetry): () => void {
  activeRetry = retry;
  return () => {
    if (activeRetry === retry) activeRetry = null;
  };
}

export function retryThreadDetailSync(threadId: ThreadId): Promise<void> {
  return activeRetry?.(threadId) ?? Promise.resolve();
}
