import { describe, expect, it } from "vitest";

import { collectSubagentDescendants } from "./threadHierarchy";

function thread(id: string, parentThreadId?: string | null) {
  return { id, parentThreadId: parentThreadId ?? null };
}

describe("collectSubagentDescendants", () => {
  it("returns an empty list for a thread without children", () => {
    expect(collectSubagentDescendants([thread("root"), thread("other")], "root")).toEqual([]);
  });

  it("collects nested descendants breadth-first and excludes the root", () => {
    const threads = [
      thread("root"),
      thread("child-a", "root"),
      thread("grandchild", "child-a"),
      thread("child-b", "root"),
      thread("unrelated"),
      thread("unrelated-child", "unrelated"),
    ];

    expect(collectSubagentDescendants(threads, "root").map((entry) => entry.id)).toEqual([
      "child-a",
      "child-b",
      "grandchild",
    ]);
  });

  it("survives cyclic and self-referential linkage", () => {
    const threads = [
      thread("root"),
      thread("child", "root"),
      // Corrupted rows: the root claims the child as its parent, and a thread points at itself.
      { id: "root", parentThreadId: "child" },
      thread("self", "self"),
    ];

    expect(collectSubagentDescendants(threads, "root").map((entry) => entry.id)).toEqual(["child"]);
  });
});
