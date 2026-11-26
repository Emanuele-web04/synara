import { describe, expect, it } from "vitest";
import { canvasPageList, canvasPageListParts, moveCanvasPageListItem } from "./designCanvasPages";

const pages = [{ id: "a" }, { id: "b" }, { id: "c" }];
const ids = (items: ReturnType<typeof canvasPageList>) =>
  items.map((item) => (item.kind === "page" ? item.id : `|${item.id}`));

describe("canvas page list", () => {
  it("puts each divider above its page, keeps their order and sends unknown anchors last", () => {
    const list = canvasPageList({
      pages,
      dividers: [
        { id: "x", beforePageId: "b" },
        { id: "end", beforePageId: null },
        { id: "y", beforePageId: "b" },
        { id: "lost", beforePageId: "gone" },
      ],
    });
    expect(ids(list)).toEqual(["a", "|x", "|y", "b", "c", "|end", "|lost"]);
    expect(ids(canvasPageList({ pages }))).toEqual(["a", "b", "c"]);
  });

  it("round-trips through pages and anchors", () => {
    const dividers = [
      { id: "x", beforePageId: "a" },
      { id: "end", beforePageId: null },
    ];
    expect(canvasPageListParts(canvasPageList({ pages, dividers }))).toEqual({ pages, dividers });
  });

  it("moves pages and dividers through one order", () => {
    const list = canvasPageList({ pages, dividers: [{ id: "x", beforePageId: "b" }] });
    // A page moved away leaves the divider above whatever follows it.
    const moved = moveCanvasPageListItem(list, "b", null);
    expect(ids(moved)).toEqual(["a", "|x", "c", "b"]);
    expect(canvasPageListParts(moved).dividers).toEqual([{ id: "x", beforePageId: "c" }]);
    expect(ids(moveCanvasPageListItem(list, "x", "a"))).toEqual(["|x", "a", "b", "c"]);
    expect(ids(moveCanvasPageListItem(list, "x", "x"))).toEqual(ids(list));
    expect(() => moveCanvasPageListItem(list, "nope", null)).toThrow("page not found");
    expect(() => moveCanvasPageListItem(list, "a", "nope")).toThrow("Destination");
  });
});
