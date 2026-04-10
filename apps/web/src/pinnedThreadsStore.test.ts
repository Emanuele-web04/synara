// FILE: pinnedThreadsStore.test.ts
// Purpose: Verifies the global pinned-thread store mutates ids predictably.
// Layer: UI state store test

import { beforeEach, describe, expect, it } from "vitest";
import { ThreadId } from "@t3tools/contracts";
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
});
