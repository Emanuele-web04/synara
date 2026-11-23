// FILE: dither.test.ts
// Purpose: The backdrop's band (ported from HoloBot's packages/ui src/dither.test.ts): flat
//          colors only, transparent between the dots, whole square dots, none along the top,
//          the share of dots growing to `coverage` at the bottom; with an edge, exactly the
//          pixels beside a dot are the darker grey.
// Layer: SynBot kit tests

import { describe, expect, it } from "vitest";

import { DITHER, ditherBand } from "./dither";

const look = { luminance: DITHER.luminance, dot: 2, coverage: DITHER.coverage, edge: null };
const width = 640;
const height = 400;
const rgba = ditherBand(width, height, look);
const pixel = (data: Uint8ClampedArray, x: number, y: number) => [
  ...data.slice((y * width + x) * 4, (y * width + x) * 4 + 4),
];
const grey = Math.round(look.luminance * 255);
const isDot = (x: number, y: number) => pixel(rgba, x, y)[3] === 255;
/** Share of dots on row `y`. */
const share = (y: number) =>
  Array.from({ length: width }, (_, x) => isDot(x, y)).filter(Boolean).length / width;
/** Share of dots over the 16 rows (one Bayer period of 2 px dots) from `y`. */
const band = (y: number) =>
  Array.from({ length: 16 }, (_, i) => share(y + i)).reduce((a, b) => a + b) / 16;

describe("the dithered band", () => {
  it("is a neutral grey dot or transparent, nothing in between", () => {
    for (let i = 0; i < rgba.length; i += 4) {
      const color = [...rgba.slice(i, i + 4)];
      expect([
        [0, 0, 0, 0],
        [grey, grey, grey, 255],
      ]).toContainEqual(color);
    }
  });

  it("has no dots along its top, and `coverage` of them along its bottom, growing between", () => {
    expect(band(0)).toBe(0);
    expect(band(height - 16)).toBeCloseTo(look.coverage, 1);
    expect(band(height / 4)).toBeLessThan(band(height / 2));
    expect(band(height / 2)).toBeLessThan(band((height * 3) / 4));
  });

  it("draws every dot as a whole square of `dot` device pixels", () => {
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const on = isDot(x, y);
        expect([isDot(x + 1, y), isDot(x, y + 1), isDot(x + 1, y + 1)]).toEqual([on, on, on]);
      }
    }
  });

  it("darkens exactly the pixels beside a dot when there is an edge", () => {
    const withEdge = ditherBand(width, height, { ...look, dot: 1, edge: DITHER.edge });
    const edge = Math.round((DITHER.edge ?? 0) * 255);
    const dotAt = (x: number, y: number) => pixel(withEdge, x, y)[0] === grey;
    for (let y = 1; y < height - 1; y += 7) {
      for (let x = 1; x < width - 1; x += 5) {
        const [value, , , alpha] = pixel(withEdge, x, y);
        if (dotAt(x, y)) continue;
        const nextToDot = dotAt(x - 1, y) || dotAt(x + 1, y) || dotAt(x, y - 1) || dotAt(x, y + 1);
        expect(alpha === 255 && value === edge).toBe(nextToDot);
      }
    }
  });
});
