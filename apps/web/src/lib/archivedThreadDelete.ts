// FILE: archivedThreadDelete.ts
// Purpose: Coordinates archived-thread deletion with immediate local removal and shell refresh.
// Layer: Web orchestration helper
// Exports: deleteArchivedThreadFromClient, deleteArchivedThreadsFromClient

import type { NativeApi, OrchestrationShellSnapshot, ThreadId } from "@t3tools/contracts";

import { newCommandId } from "./utils";

interface DeleteArchivedThreadFromClientInput {
  api: Pick<NativeApi["orchestration"], "dispatchCommand" | "getShellSnapshot">;
  threadId: ThreadId;
  removeDeletedThreadFromClientState: (threadId: ThreadId) => void;
  syncServerShellSnapshot: (snapshot: OrchestrationShellSnapshot) => void;
}

interface DeleteArchivedThreadsFromClientInput extends Omit<
  DeleteArchivedThreadFromClientInput,
  "threadId"
> {
  threadIds: ReadonlyArray<ThreadId>;
}

// Deletes the archived thread on the server, removes it locally, then reconciles from shell state.
export async function deleteArchivedThreadFromClient(
  input: DeleteArchivedThreadFromClientInput,
): Promise<void> {
  await deleteArchivedThreadsFromClient({
    api: input.api,
    threadIds: [input.threadId],
    removeDeletedThreadFromClientState: input.removeDeletedThreadFromClientState,
    syncServerShellSnapshot: input.syncServerShellSnapshot,
  });
}

// Deletes a group of archived threads while doing only one shell refresh at the end.
export async function deleteArchivedThreadsFromClient(
  input: DeleteArchivedThreadsFromClientInput,
): Promise<void> {
  const threadIds = [...new Set(input.threadIds)];
  if (threadIds.length === 0) {
    return;
  }

  for (const threadId of threadIds) {
    await input.api.dispatchCommand({
      type: "thread.delete",
      commandId: newCommandId(),
      threadId,
    });
    input.removeDeletedThreadFromClientState(threadId);
  }

  const snapshot = await input.api.getShellSnapshot().catch(() => null);
  if (snapshot) {
    input.syncServerShellSnapshot(snapshot);
    for (const threadId of threadIds) {
      input.removeDeletedThreadFromClientState(threadId);
    }
  }
}
