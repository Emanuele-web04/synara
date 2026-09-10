// FILE: pinnedThreadsStore.test.ts
// Purpose: Verifies the global pinned-thread store mutates ids predictably.
// Layer: UI state store test

import { beforeEach, describe, expect, it } from "vitest";
import { ThreadId } from "@synara/contracts";
import { usePinnedThreadsStore } from "./pinnedThreadsStore";

describe("usePinnedThreadsStore", () => {
  beforeEach(() => {
    usePinnedThreadsStore.setState({ pinnedThreadIds: [] });
  });

  it("toggles a pinned thread id on and off", () => {
    usePinnedThreadsStore.getState().togglePinnedThread("thread-1" as ThreadId);
    expect(usePinnedThreadsStore.getState().pinnedThreadIds).toEqual(["thread-1"]);

    usePinnedThreadsStore.getState().togglePinnedThread("thread-1" as ThreadId);
    expect(usePinnedThreadsStore.getState().pinnedThreadIds).toEqual([]);
  });

  it("prunes thread ids that are no longer present", () => {
    usePinnedThreadsStore.setState({
      pinnedThreadIds: ["thread-2" as ThreadId, "thread-1" as ThreadId],
    });

    usePinnedThreadsStore.getState().prunePinnedThreads(["thread-1" as ThreadId]);
    expect(usePinnedThreadsStore.getState().pinnedThreadIds).toEqual(["thread-1"]);
  });

  it("reorders only the pinned ids in the current sidebar surface", () => {
    usePinnedThreadsStore.setState({
      pinnedThreadIds: ["studio-1", "thread-1", "thread-2"].map((id) => ThreadId.makeUnsafe(id)),
    });

    const changed = usePinnedThreadsStore.getState().movePinnedThread({
      scopeThreadIds: ["thread-1", "thread-2"].map((id) => ThreadId.makeUnsafe(id)),
      activeThreadId: ThreadId.makeUnsafe("thread-2"),
      overThreadId: ThreadId.makeUnsafe("thread-1"),
    });

    expect(changed).toBe(true);
    expect(usePinnedThreadsStore.getState().pinnedThreadIds).toEqual([
      "studio-1",
      "thread-2",
      "thread-1",
    ]);
  });
});
