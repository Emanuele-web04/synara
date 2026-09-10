// FILE: sidebarThreadOrderStore.test.ts
// Purpose: Verifies the persisted manual sidebar thread-order store.
// Layer: UI state store test

import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { useSidebarThreadOrderStore } from "./sidebarThreadOrderStore";

describe("useSidebarThreadOrderStore", () => {
  beforeEach(() => {
    useSidebarThreadOrderStore.setState({ orderedThreadIds: [] });
  });

  it("snapshots a scope and moves a thread", () => {
    const changed = useSidebarThreadOrderStore.getState().moveThread({
      scopeThreadIds: ["thread-1", "thread-2", "thread-3"].map((id) => ThreadId.makeUnsafe(id)),
      activeThreadId: ThreadId.makeUnsafe("thread-3"),
      overThreadId: ThreadId.makeUnsafe("thread-1"),
    });

    expect(changed).toBe(true);
    expect(useSidebarThreadOrderStore.getState().orderedThreadIds).toEqual([
      "thread-3",
      "thread-1",
      "thread-2",
    ]);
  });

  it("prunes threads that no longer exist", () => {
    useSidebarThreadOrderStore.setState({
      orderedThreadIds: ["thread-2", "thread-1"].map((id) => ThreadId.makeUnsafe(id)),
    });
    useSidebarThreadOrderStore.getState().pruneThreads([ThreadId.makeUnsafe("thread-1")]);
    expect(useSidebarThreadOrderStore.getState().orderedThreadIds).toEqual(["thread-1"]);
  });
});
