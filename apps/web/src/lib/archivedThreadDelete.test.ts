// FILE: archivedThreadDelete.test.ts
// Purpose: Verifies archived-thread delete coordination without rendering settings UI.
// Layer: Web orchestration helper tests

import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  deleteArchivedThreadFromClient,
  deleteArchivedThreadsFromClient,
} from "./archivedThreadDelete";

describe("deleteArchivedThreadFromClient", () => {
  it("dispatches delete, then removes the local row", async () => {
    const threadId = ThreadId.makeUnsafe("thread-archived");
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 11 });
    const removeDeletedThreadFromClientState = vi.fn();

    await deleteArchivedThreadFromClient({
      api: { dispatchCommand },
      threadId,
      removeDeletedThreadFromClientState,
    });

    expect(dispatchCommand).toHaveBeenCalledWith({
      type: "thread.delete",
      commandId: expect.any(String),
      threadId,
    });
    expect(removeDeletedThreadFromClientState).toHaveBeenCalledOnce();
    expect(removeDeletedThreadFromClientState).toHaveBeenCalledWith(threadId);
    const dispatchOrder = dispatchCommand.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const removeOrder =
      removeDeletedThreadFromClientState.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(dispatchOrder).toBeLessThan(removeOrder);
  });

  it("deletes multiple archived threads and removes each locally once", async () => {
    const threadA = ThreadId.makeUnsafe("thread-archived-a");
    const threadB = ThreadId.makeUnsafe("thread-archived-b");
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 11 });
    const removeDeletedThreadFromClientState = vi.fn();

    await deleteArchivedThreadsFromClient({
      api: { dispatchCommand },
      threadIds: [threadA, threadA, threadB],
      removeDeletedThreadFromClientState,
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
    expect(removeDeletedThreadFromClientState.mock.calls).toEqual([[threadA], [threadB]]);
  });

  it("reconciles successful archived deletes when a later bulk delete fails", async () => {
    const threadA = ThreadId.makeUnsafe("thread-archived-a");
    const threadB = ThreadId.makeUnsafe("thread-archived-b");
    const dispatchError = new Error("delete failed");
    const dispatchCommand = vi
      .fn()
      .mockResolvedValueOnce({ sequence: 11 })
      .mockRejectedValueOnce(dispatchError);
    const removeDeletedThreadFromClientState = vi.fn();

    await expect(
      deleteArchivedThreadsFromClient({
        api: { dispatchCommand },
        threadIds: [threadA, threadB],
        removeDeletedThreadFromClientState,
      }),
    ).rejects.toThrow(dispatchError);

    expect(dispatchCommand).toHaveBeenCalledTimes(2);
    expect(removeDeletedThreadFromClientState.mock.calls).toEqual([[threadA]]);
  });
});
