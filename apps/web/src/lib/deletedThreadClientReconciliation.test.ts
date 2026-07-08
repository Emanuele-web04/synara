// FILE: deletedThreadClientReconciliation.test.ts
// Purpose: Verifies immediate thread-delete UI reconciliation without rendering callers.
// Layer: Web orchestration helper tests

import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  reconcileDeletedThreadFromClient,
  reconcileDeletedThreadsFromClient,
} from "./deletedThreadClientReconciliation";

describe("reconcileDeletedThreadFromClient", () => {
  it("removes the local row without applying a shell snapshot", async () => {
    const threadId = ThreadId.makeUnsafe("thread-delete");
    const removeDeletedThreadFromClientState = vi.fn();

    await reconcileDeletedThreadFromClient({
      threadId,
      removeDeletedThreadFromClientState,
    });

    expect(removeDeletedThreadFromClientState).toHaveBeenCalledOnce();
    expect(removeDeletedThreadFromClientState).toHaveBeenCalledWith(threadId);
  });
});

describe("reconcileDeletedThreadsFromClient", () => {
  it("deduplicates bulk thread removals without applying a shell snapshot", async () => {
    const threadA = ThreadId.makeUnsafe("thread-delete-a");
    const threadB = ThreadId.makeUnsafe("thread-delete-b");
    const removeDeletedThreadFromClientState = vi.fn();

    await reconcileDeletedThreadsFromClient({
      threadIds: [threadA, threadA, threadB],
      removeDeletedThreadFromClientState,
    });

    expect(removeDeletedThreadFromClientState.mock.calls).toEqual([[threadA], [threadB]]);
  });
});
