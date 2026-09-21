import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { detachedThreadIdSet, useSidebarSubagentDetachStore } from "./sidebarSubagentDetachStore";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

describe("sidebarSubagentDetachStore", () => {
  beforeEach(() => {
    useSidebarSubagentDetachStore.setState({ detachedThreadIds: {} });
  });

  it("detaches and re-attaches a subagent thread", () => {
    const store = useSidebarSubagentDetachStore.getState();
    store.detachSubagent(THREAD_A);

    expect(useSidebarSubagentDetachStore.getState().detachedThreadIds).toEqual({
      [THREAD_A]: true,
    });

    useSidebarSubagentDetachStore.getState().attachSubagent(THREAD_A);
    expect(useSidebarSubagentDetachStore.getState().detachedThreadIds).toEqual({});
  });

  it("keeps other detachments when one thread re-attaches", () => {
    const store = useSidebarSubagentDetachStore.getState();
    store.detachSubagent(THREAD_A);
    store.detachSubagent(THREAD_B);
    useSidebarSubagentDetachStore.getState().attachSubagent(THREAD_A);

    expect(detachedThreadIdSet(useSidebarSubagentDetachStore.getState().detachedThreadIds)).toEqual(
      new Set([THREAD_B]),
    );
  });

  it("is a no-op when the thread was never detached", () => {
    const before = useSidebarSubagentDetachStore.getState().detachedThreadIds;
    useSidebarSubagentDetachStore.getState().attachSubagent(THREAD_A);

    expect(useSidebarSubagentDetachStore.getState().detachedThreadIds).toBe(before);
  });
});
