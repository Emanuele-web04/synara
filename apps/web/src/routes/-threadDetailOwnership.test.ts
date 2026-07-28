import { describe, expect, it } from "vitest";
import { ThreadId } from "@synara/contracts";
import { canApplyThreadSnapshot, selectOrphanedThreadDetailIds } from "./-threadDetailOwnership";

const threadId = (value: string) => ThreadId.makeUnsafe(value);

describe("canApplyThreadSnapshot", () => {
  it("applies a snapshot for a leased thread", () => {
    const leased = threadId("leased");
    expect(canApplyThreadSnapshot({ threadId: leased, leasedThreadIds: new Set([leased]) })).toBe(
      true,
    );
  });

  it("drops a snapshot whose lease was released while it was in flight", () => {
    // Retention eviction refreshes a thread, then its lease drops before the
    // refreshed snapshot lands. Applying it would restore detail that neither a
    // lease nor a retention entry owns, so nothing could ever free it again.
    expect(
      canApplyThreadSnapshot({ threadId: threadId("released"), leasedThreadIds: new Set() }),
    ).toBe(false);
  });
});

describe("selectOrphanedThreadDetailIds", () => {
  it("frees released threads that retention does not own", () => {
    expect(
      selectOrphanedThreadDetailIds({
        releasedThreadIds: [threadId("a"), threadId("b")],
        isRetained: (candidate) => candidate === threadId("a"),
      }),
    ).toEqual([threadId("b")]);
  });

  it("keeps threads the caller is about to re-lease", () => {
    // Reconnect and effect teardown drop every lease at once and immediately
    // re-lease the visible ones. Freeing those would blank the open chat.
    expect(
      selectOrphanedThreadDetailIds({
        releasedThreadIds: [threadId("visible"), threadId("background")],
        isRetained: () => false,
        keptThreadIds: new Set([threadId("visible")]),
      }),
    ).toEqual([threadId("background")]);
  });

  it("reports each thread once so a batched eviction cannot double-write", () => {
    expect(
      selectOrphanedThreadDetailIds({
        releasedThreadIds: [threadId("dupe"), threadId("dupe")],
        isRetained: () => false,
      }),
    ).toEqual([threadId("dupe")]);
  });

  it("returns nothing when every released thread is still owned", () => {
    expect(
      selectOrphanedThreadDetailIds({
        releasedThreadIds: [threadId("a"), threadId("b")],
        isRetained: () => true,
      }),
    ).toEqual([]);
  });
});
