// FILE: archivedThreadDelete.test.ts
// Purpose: Verifies archived-thread delete coordination without rendering settings UI.
// Layer: Web orchestration helper tests

import { ThreadId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  deleteArchivedThreadFromClient,
  deleteArchivedThreadsFromClient,
} from "./archivedThreadDelete";

describe("deleteArchivedThreadFromClient", () => {
  it("dispatches delete, removes the local row, then reconciles the shell snapshot", async () => {
    const threadId = ThreadId.makeUnsafe("thread-archived");
    const snapshot: OrchestrationShellSnapshot = {
      snapshotSequence: 12,
      updatedAt: "2026-02-27T00:06:00.000Z",
      projects: [],
      threads: [],
    };
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 11 });
    const getShellSnapshot = vi.fn().mockResolvedValue(snapshot);
    const removeDeletedThreadFromClientState = vi.fn();
    const syncServerShellSnapshot = vi.fn();

    await deleteArchivedThreadFromClient({
      api: { dispatchCommand, getShellSnapshot },
      threadId,
      removeDeletedThreadFromClientState,
      syncServerShellSnapshot,
    });

    expect(dispatchCommand).toHaveBeenCalledWith({
      type: "thread.delete",
      commandId: expect.any(String),
      threadId,
    });
    expect(removeDeletedThreadFromClientState).toHaveBeenCalledTimes(2);
    expect(removeDeletedThreadFromClientState).toHaveBeenNthCalledWith(1, threadId);
    expect(removeDeletedThreadFromClientState).toHaveBeenNthCalledWith(2, threadId);
    expect(syncServerShellSnapshot).toHaveBeenCalledWith(snapshot);
    const dispatchOrder = dispatchCommand.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const firstRemoveOrder =
      removeDeletedThreadFromClientState.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const secondRemoveOrder =
      removeDeletedThreadFromClientState.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER;
    const syncOrder =
      syncServerShellSnapshot.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(dispatchOrder).toBeLessThan(firstRemoveOrder);
    expect(firstRemoveOrder).toBeLessThan(syncOrder);
    expect(syncOrder).toBeLessThan(secondRemoveOrder);
  });

  it("keeps the local removal when the follow-up shell refresh fails", async () => {
    const threadId = ThreadId.makeUnsafe("thread-archived");
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 11 });
    const getShellSnapshot = vi.fn().mockRejectedValue(new Error("offline"));
    const removeDeletedThreadFromClientState = vi.fn();
    const syncServerShellSnapshot = vi.fn();

    await expect(
      deleteArchivedThreadFromClient({
        api: { dispatchCommand, getShellSnapshot },
        threadId,
        removeDeletedThreadFromClientState,
        syncServerShellSnapshot,
      }),
    ).resolves.toBeUndefined();

    expect(removeDeletedThreadFromClientState).toHaveBeenCalledWith(threadId);
    expect(syncServerShellSnapshot).not.toHaveBeenCalled();
  });

  it("deletes multiple archived threads with one follow-up shell refresh", async () => {
    const threadA = ThreadId.makeUnsafe("thread-archived-a");
    const threadB = ThreadId.makeUnsafe("thread-archived-b");
    const snapshot: OrchestrationShellSnapshot = {
      snapshotSequence: 14,
      updatedAt: "2026-02-27T00:07:00.000Z",
      projects: [],
      threads: [],
    };
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 11 });
    const getShellSnapshot = vi.fn().mockResolvedValue(snapshot);
    const removeDeletedThreadFromClientState = vi.fn();
    const syncServerShellSnapshot = vi.fn();

    await deleteArchivedThreadsFromClient({
      api: { dispatchCommand, getShellSnapshot },
      threadIds: [threadA, threadA, threadB],
      removeDeletedThreadFromClientState,
      syncServerShellSnapshot,
    });

    expect(dispatchCommand).toHaveBeenCalledTimes(2);
    expect(dispatchCommand).toHaveBeenNthCalledWith(1, {
      type: "thread.delete",
      commandId: expect.any(String),
      threadId: threadA,
    });
    expect(dispatchCommand).toHaveBeenNthCalledWith(2, {
      type: "thread.delete",
      commandId: expect.any(String),
      threadId: threadB,
    });
    expect(getShellSnapshot).toHaveBeenCalledTimes(1);
    expect(syncServerShellSnapshot).toHaveBeenCalledWith(snapshot);
    expect(removeDeletedThreadFromClientState.mock.calls).toEqual([
      [threadA],
      [threadB],
      [threadA],
      [threadB],
    ]);
  });
});
