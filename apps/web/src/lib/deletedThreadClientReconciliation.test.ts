// FILE: deletedThreadClientReconciliation.test.ts
// Purpose: Verifies immediate thread-delete UI reconciliation without rendering callers.
// Layer: Web orchestration helper tests

import { ThreadId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  reconcileDeletedThreadFromClient,
  reconcileDeletedThreadsFromClient,
} from "./deletedThreadClientReconciliation";

describe("reconcileDeletedThreadFromClient", () => {
  it("removes the local row before shell refresh and again after sync", async () => {
    const threadId = ThreadId.makeUnsafe("thread-delete");
    const snapshot: OrchestrationShellSnapshot = {
      snapshotSequence: 12,
      updatedAt: "2026-02-27T00:06:00.000Z",
      projects: [],
      threads: [],
    };
    const getShellSnapshot = vi.fn().mockResolvedValue(snapshot);
    const removeDeletedThreadFromClientState = vi.fn();
    const syncServerShellSnapshot = vi.fn();

    await reconcileDeletedThreadFromClient({
      api: { getShellSnapshot },
      threadId,
      removeDeletedThreadFromClientState,
      syncServerShellSnapshot,
    });

    expect(removeDeletedThreadFromClientState).toHaveBeenCalledTimes(2);
    expect(removeDeletedThreadFromClientState).toHaveBeenNthCalledWith(1, threadId);
    expect(removeDeletedThreadFromClientState).toHaveBeenNthCalledWith(2, threadId);
    expect(syncServerShellSnapshot).toHaveBeenCalledWith(snapshot);
    const firstRemoveOrder =
      removeDeletedThreadFromClientState.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const syncOrder =
      syncServerShellSnapshot.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const secondRemoveOrder =
      removeDeletedThreadFromClientState.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER;
    expect(firstRemoveOrder).toBeLessThan(syncOrder);
    expect(syncOrder).toBeLessThan(secondRemoveOrder);
  });

  it("keeps the immediate local removal when shell refresh fails", async () => {
    const threadId = ThreadId.makeUnsafe("thread-delete");
    const getShellSnapshot = vi.fn().mockRejectedValue(new Error("offline"));
    const removeDeletedThreadFromClientState = vi.fn();
    const syncServerShellSnapshot = vi.fn();

    await expect(
      reconcileDeletedThreadFromClient({
        api: { getShellSnapshot },
        threadId,
        removeDeletedThreadFromClientState,
        syncServerShellSnapshot,
      }),
    ).resolves.toBeUndefined();

    expect(removeDeletedThreadFromClientState).toHaveBeenCalledOnce();
    expect(removeDeletedThreadFromClientState).toHaveBeenCalledWith(threadId);
    expect(syncServerShellSnapshot).not.toHaveBeenCalled();
  });
});

describe("reconcileDeletedThreadsFromClient", () => {
  it("deduplicates bulk thread removals around one shell refresh", async () => {
    const threadA = ThreadId.makeUnsafe("thread-delete-a");
    const threadB = ThreadId.makeUnsafe("thread-delete-b");
    const snapshot: OrchestrationShellSnapshot = {
      snapshotSequence: 14,
      updatedAt: "2026-02-27T00:07:00.000Z",
      projects: [],
      threads: [],
    };
    const getShellSnapshot = vi.fn().mockResolvedValue(snapshot);
    const removeDeletedThreadFromClientState = vi.fn();
    const syncServerShellSnapshot = vi.fn();

    await reconcileDeletedThreadsFromClient({
      api: { getShellSnapshot },
      threadIds: [threadA, threadA, threadB],
      removeDeletedThreadFromClientState,
      syncServerShellSnapshot,
    });

    expect(getShellSnapshot).toHaveBeenCalledOnce();
    expect(syncServerShellSnapshot).toHaveBeenCalledWith(snapshot);
    expect(removeDeletedThreadFromClientState.mock.calls).toEqual([
      [threadA],
      [threadB],
      [threadA],
      [threadB],
    ]);
  });
});
