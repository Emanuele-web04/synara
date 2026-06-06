// FILE: pinning.logic.test.ts
// Purpose: Verifies shared sidebar pin normalization, limits, and ordering.
// Layer: UI state logic test

import { describe, expect, it } from "vitest";
import { derivePinnedIds, orderPinnedItemsFirst, pinId, prunePinnedIds } from "./pinning.logic";

describe("pinning.logic", () => {
  it("pins newest ids first and rejects ids beyond the configured cap", () => {
    const existing = ["project-3", "project-2", "project-1"];

    expect(pinId(existing, "project-4", { maxCount: 3 })).toEqual({
      pinnedIds: existing,
      changed: false,
      rejected: true,
    });
    expect(pinId(existing, "project-2", { maxCount: 3 })).toEqual({
      pinnedIds: existing,
      changed: false,
      rejected: false,
    });
    expect(pinId(["project-2"], "project-1", { maxCount: 3 }).pinnedIds).toEqual([
      "project-1",
      "project-2",
    ]);
  });

  it("derives pinned ids from persisted order, server pins, and optimistic overrides", () => {
    const items = [
      { id: "project-1", isPinned: true },
      { id: "project-2", isPinned: true },
      { id: "project-3", isPinned: false },
      { id: "project-4", isPinned: true },
    ];

    expect(
      derivePinnedIds({
        items,
        persistedPinnedIds: ["project-3", "project-missing"],
        optimisticPinnedStateById: new Map([
          ["project-1", false],
          ["project-3", true],
        ]),
        maxCount: 3,
      }),
    ).toEqual(["project-3", "project-2", "project-4"]);
  });

  it("orders pinned items first without changing unpinned item order", () => {
    const items: Array<{ id: string }> = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

    expect(
      orderPinnedItemsFirst<string, { id: string }>(items, ["c", "a"]).map((item) => item.id),
    ).toEqual(["c", "a", "b", "d"]);
  });

  it("prunes missing ids and removes duplicates", () => {
    expect(prunePinnedIds(["a", "b", "a", "c"], ["c", "a"])).toEqual(["a", "c"]);
  });
});
