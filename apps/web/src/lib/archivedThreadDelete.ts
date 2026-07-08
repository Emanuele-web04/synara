// FILE: archivedThreadDelete.ts
// Purpose: Coordinates archived-thread deletion with immediate local removal.
// Layer: Web orchestration helper
// Exports: deleteArchivedThreadFromClient, deleteArchivedThreadsFromClient

import type { NativeApi, ThreadId } from "@synara/contracts";

import { reconcileDeletedThreadsFromClient } from "./deletedThreadClientReconciliation";
import { newCommandId } from "./utils";

interface DeleteArchivedThreadFromClientInput {
  api: Pick<NativeApi["orchestration"], "dispatchCommand">;
  threadId: ThreadId;
  removeDeletedThreadFromClientState: (threadId: ThreadId) => void;
}

interface DeleteArchivedThreadsFromClientInput extends Omit<
  DeleteArchivedThreadFromClientInput,
  "threadId"
> {
  threadIds: ReadonlyArray<ThreadId>;
}

// Deletes the archived thread on the server, then removes it from local projections.
export async function deleteArchivedThreadFromClient(
  input: DeleteArchivedThreadFromClientInput,
): Promise<void> {
  await deleteArchivedThreadsFromClient({
    api: input.api,
    threadIds: [input.threadId],
    removeDeletedThreadFromClientState: input.removeDeletedThreadFromClientState,
  });
}

// Deletes a group of archived threads and reconciles successful ids once at the end.
export async function deleteArchivedThreadsFromClient(
  input: DeleteArchivedThreadsFromClientInput,
): Promise<void> {
  const threadIds = [...new Set(input.threadIds)];
  if (threadIds.length === 0) {
    return;
  }

  const deletedThreadIds: ThreadId[] = [];
  try {
    for (const threadId of threadIds) {
      await input.api.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId,
      });
      deletedThreadIds.push(threadId);
    }
  } finally {
    await reconcileDeletedThreadsFromClient({
      threadIds: deletedThreadIds,
      removeDeletedThreadFromClientState: input.removeDeletedThreadFromClientState,
    });
  }
}
