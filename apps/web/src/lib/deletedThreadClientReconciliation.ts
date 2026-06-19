// FILE: deletedThreadClientReconciliation.ts
// Purpose: Keeps thread-delete UI state responsive after the server accepts deletion.
// Layer: Web orchestration helper
// Exports: reconcileDeletedThreadFromClient, reconcileDeletedThreadsFromClient

import type { NativeApi, OrchestrationShellSnapshot, ThreadId } from "@t3tools/contracts";

interface DeletedThreadClientReconciliationInput {
  api: Pick<NativeApi["orchestration"], "getShellSnapshot">;
  threadIds: ReadonlyArray<ThreadId>;
  removeDeletedThreadFromClientState: (threadId: ThreadId) => void;
  removeBeforeRefresh?: boolean;
  syncServerShellSnapshot: (snapshot: OrchestrationShellSnapshot) => void;
}

interface DeletedThreadClientReconciliationSingleInput
  extends Omit<DeletedThreadClientReconciliationInput, "threadIds"> {
  threadId: ThreadId;
}

export function reconcileDeletedThreadFromClient(
  input: DeletedThreadClientReconciliationSingleInput,
): Promise<void> {
  return reconcileDeletedThreadsFromClient({
    api: input.api,
    threadIds: [input.threadId],
    removeDeletedThreadFromClientState: input.removeDeletedThreadFromClientState,
    syncServerShellSnapshot: input.syncServerShellSnapshot,
  });
}

// Removes accepted deletes immediately, then refreshes shell state without letting a stale
// snapshot briefly resurrect the deleted rows.
export async function reconcileDeletedThreadsFromClient(
  input: DeletedThreadClientReconciliationInput,
): Promise<void> {
  const threadIds = [...new Set(input.threadIds)];
  if (threadIds.length === 0) {
    return;
  }

  if (input.removeBeforeRefresh ?? true) {
    for (const threadId of threadIds) {
      input.removeDeletedThreadFromClientState(threadId);
    }
  }

  const snapshot = await input.api.getShellSnapshot().catch(() => null);
  if (!snapshot) {
    return;
  }

  input.syncServerShellSnapshot(snapshot);
  for (const threadId of threadIds) {
    input.removeDeletedThreadFromClientState(threadId);
  }
}
