// FILE: sidebarThreadOrdering.test.ts
// Purpose: Verifies immutable manual sidebar thread-order behavior.
// Layer: UI state logic test

import { describe, expect, it } from "vitest";
import {
  compareSidebarThreadsByManualOrder,
  moveSidebarThreadWithinScope,
  normalizeSidebarThreadOrder,
  pruneSidebarThreadOrder,
} from "./sidebarThreadOrdering";

describe("sidebar thread ordering", () => {
  it("normalizes duplicate and empty ids", () => {
    expect(normalizeSidebarThreadOrder(["a", "", "b", "a"])).toEqual(["a", "b"]);
  });

  it("moves a thread inside its complete scope and preserves other scopes", () => {
    expect(
      moveSidebarThreadWithinScope({
        orderedIds: ["elsewhere-1", "scope-1", "scope-2", "elsewhere-2"],
        scopeIds: ["scope-1", "scope-2", "scope-3"],
        activeId: "scope-3",
        overId: "scope-1",
      }),
    ).toEqual({
      orderedIds: ["elsewhere-1", "elsewhere-2", "scope-3", "scope-1", "scope-2"],
      changed: true,
    });
  });

  it("does not move across scopes or for a cancelled same-position drop", () => {
    const input = { orderedIds: ["a", "b"], scopeIds: ["a", "b"] } as const;
    expect(moveSidebarThreadWithinScope({ ...input, activeId: "a", overId: "outside" })).toEqual({
      orderedIds: ["a", "b"],
      changed: false,
    });
    expect(moveSidebarThreadWithinScope({ ...input, activeId: "a", overId: "a" })).toEqual({
      orderedIds: ["a", "b"],
      changed: false,
    });
  });

  it("prunes deleted ids while retaining manual order", () => {
    expect(pruneSidebarThreadOrder(["c", "a", "b"], ["a", "c"])).toEqual(["c", "a"]);
  });

  it("keeps new ids above ranked ids while preserving fallback order", () => {
    const rankById = new Map([
      ["ranked-a", 0],
      ["ranked-b", 1],
    ]);
    const ids = ["ranked-b", "new-older", "ranked-a", "new-newer"];
    const fallbackRanks = new Map([
      ["new-newer", 0],
      ["new-older", 1],
    ]);
    expect(
      ids.toSorted((leftId, rightId) =>
        compareSidebarThreadsByManualOrder({
          leftId,
          rightId,
          rankById,
          compareFallback: () =>
            (fallbackRanks.get(leftId) ?? 0) - (fallbackRanks.get(rightId) ?? 0),
        }),
      ),
    ).toEqual(["new-newer", "new-older", "ranked-a", "ranked-b"]);
  });
});
