import { describe, expect, it } from "vitest";

import {
  decodeInlineVisualSpec,
  formatVisualNumber,
  niceAxisTicks,
  sortTableRows,
} from "./inlineVisualBlocks.logic";

describe("decodeInlineVisualSpec", () => {
  it("reads a stored spec and rejects one this client cannot draw", () => {
    expect(
      decodeInlineVisualSpec(JSON.stringify({ blocks: [{ type: "markdown", text: "Hi" }] })),
    ).toEqual({ blocks: [{ type: "markdown", text: "Hi" }] });
    expect(decodeInlineVisualSpec(JSON.stringify({ blocks: [{ type: "map" }] }))).toBeNull();
    expect(decodeInlineVisualSpec("<html>")).toBeNull();
  });
});

describe("formatVisualNumber", () => {
  it("groups digits, keeps whole numbers whole, and places units", () => {
    expect(formatVisualNumber(1840, { unit: "KB" })).toBe("1,840 KB");
    expect(formatVisualNumber(14.567, { unit: "%" })).toBe("14.57%");
    expect(formatVisualNumber(-3.5, { prefix: "$", decimals: 2 })).toBe("-$3.50");
    expect(formatVisualNumber(0.01234)).toBe("0.0123");
    expect(formatVisualNumber(Number.NaN)).toBe("—");
  });
});

describe("niceAxisTicks", () => {
  it("covers the range with round steps", () => {
    expect(niceAxisTicks(1.4, 4.8)).toEqual([1, 2, 3, 4, 5]);
    expect(niceAxisTicks(0, 1840)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(niceAxisTicks(5, 5)).toEqual([4.5, 4.75, 5, 5.25, 5.5]);
  });
});

describe("sortTableRows", () => {
  const rows = [
    ["b", 2],
    ["a", null],
    ["c", 10],
  ] as const;

  it("sorts numbers numerically and keeps empty cells last in both directions", () => {
    const order = (column: number, direction: "asc" | "desc") =>
      sortTableRows(rows, { column, direction }).map((row) => row.index);
    expect(order(1, "asc")).toEqual([0, 2, 1]);
    expect(order(1, "desc")).toEqual([2, 0, 1]);
    expect(order(0, "desc")).toEqual([2, 0, 1]);
    expect(sortTableRows(rows, null).map((row) => row.index)).toEqual([0, 1, 2]);
  });
});
