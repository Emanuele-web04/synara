import { describe, expect, it } from "vitest";

import { findHiddenSurfaceTabIndexes } from "./surfaceContentTabs.logic";

describe("findHiddenSurfaceTabIndexes", () => {
  const strip = { left: 100, right: 500 };

  it("lists tabs scrolled past either edge, including partly visible ones", () => {
    expect(
      findHiddenSurfaceTabIndexes(strip, [
        { left: -60, right: 90 },
        { left: 90, right: 240 },
        { left: 240, right: 390 },
        { left: 390, right: 540 },
        { left: 540, right: 690 },
      ]),
    ).toEqual([0, 1, 3, 4]);
  });

  it("keeps tabs that only overhang by sub-pixel layout", () => {
    expect(
      findHiddenSurfaceTabIndexes(strip, [
        { left: 99.5, right: 300 },
        { left: 300, right: 500.6 },
      ]),
    ).toEqual([]);
  });
});
