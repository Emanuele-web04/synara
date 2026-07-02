import { describe, expect, it } from "vitest";

import { nextExplorerRowIndex } from "./explorerListNavigation";

describe("nextExplorerRowIndex", () => {
  const ROW_COUNT = 5;

  it("walks down one row at a time and clamps at the last row", () => {
    expect(nextExplorerRowIndex("ArrowDown", 0, ROW_COUNT)).toBe(1);
    expect(nextExplorerRowIndex("ArrowDown", 3, ROW_COUNT)).toBe(4);
    expect(nextExplorerRowIndex("ArrowDown", 4, ROW_COUNT)).toBe(4);
  });

  it("walks up one row at a time and clamps at the first row", () => {
    expect(nextExplorerRowIndex("ArrowUp", 4, ROW_COUNT)).toBe(3);
    expect(nextExplorerRowIndex("ArrowUp", 1, ROW_COUNT)).toBe(0);
    expect(nextExplorerRowIndex("ArrowUp", 0, ROW_COUNT)).toBe(0);
  });

  it("enters the list from outside: Down at the top, Up at the bottom", () => {
    expect(nextExplorerRowIndex("ArrowDown", -1, ROW_COUNT)).toBe(0);
    expect(nextExplorerRowIndex("ArrowUp", -1, ROW_COUNT)).toBe(ROW_COUNT - 1);
  });

  it("jumps to the first/last row on Home/End regardless of position", () => {
    expect(nextExplorerRowIndex("Home", 3, ROW_COUNT)).toBe(0);
    expect(nextExplorerRowIndex("End", 1, ROW_COUNT)).toBe(ROW_COUNT - 1);
  });
});
