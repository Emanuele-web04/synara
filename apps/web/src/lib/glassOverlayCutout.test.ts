import { describe, expect, it } from "vitest";

import { buildCutoutClipPath } from "./glassOverlayCutout";

describe("buildCutoutClipPath", () => {
  it("returns null when there is nothing to cut", () => {
    expect(buildCutoutClipPath(800, 600, [])).toBeNull();
    expect(
      buildCutoutClipPath(800, 600, [{ x: 0, y: 0, width: 0, height: 40, radius: 8 }]),
    ).toBeNull();
  });

  it("cuts one rounded hole per overlay out of the full box", () => {
    const path = buildCutoutClipPath(800, 600, [
      { x: 10, y: 20, width: 100, height: 50, radius: 8 },
      { x: 300, y: 40, width: 60, height: 24, radius: 0 },
    ]);
    expect(path).toBe(
      'path(evenodd, "M0 0 H800 V600 H0 Z ' +
        "M18 20 H102 A8 8 0 0 1 110 28 V62 A8 8 0 0 1 102 70 H18 A8 8 0 0 1 10 62 V28 A8 8 0 0 1 18 20 Z " +
        'M300 40 H360 A0 0 0 0 1 360 40 V64 A0 0 0 0 1 360 64 H300 A0 0 0 0 1 300 64 V40 A0 0 0 0 1 300 40 Z")',
    );
  });

  it("clamps the corner radius to half the smaller side", () => {
    const path = buildCutoutClipPath(100, 100, [{ x: 0, y: 0, width: 40, height: 20, radius: 99 }]);
    expect(path).toContain("A10 10 0 0 1 40 10");
  });
});
