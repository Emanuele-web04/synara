// FILE: deletedThreadClientReconciliation.ts
// Purpose: Keeps thread-delete UI state responsive after the server accepts deletion.
// Layer: Web orchestration helper
// Exports: reconcileDeletedThreadFromClient, reconcileDeletedThreadsFromClient

import type { ThreadId } from "@synara/contracts";

interface DeletedThreadClientReconciliationInput {
  threadIds: ReadonlyArray<ThreadId>;
  removeDeletedThreadFromClientState: (threadId: ThreadId) => void;
}

interface DeletedThreadClientReconciliationSingleInput extends Omit<
  DeletedThreadClientReconciliationInput,
  "threadIds"
> {
  threadId: ThreadId;
}

export function reconcileDeletedThreadFromClient(
  input: DeletedThreadClientReconciliationSingleInput,
): Promise<void> {
  return reconcileDeletedThreadsFromClient({
    threadIds: [input.threadId],
    removeDeletedThreadFromClientState: input.removeDeletedThreadFromClientState,
  });
}

// Delete reconciliation is intentionally local-only; shell snapshots/events still own
// authoritative refresh and can arrive stale while a delete is propagating.
export async function reconcileDeletedThreadsFromClient(
  input: DeletedThreadClientReconciliationInput,
): Promise<void> {
  const threadIds = [...new Set(input.threadIds)];
  if (threadIds.length === 0) {
    return;
  }

  for (const threadId of threadIds) {
    input.removeDeletedThreadFromClientState(threadId);
  }
}
