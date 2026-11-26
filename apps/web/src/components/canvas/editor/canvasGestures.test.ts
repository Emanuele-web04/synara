import { describe, expect, it } from "vitest";
import { dragPosition, resizeGeometry } from "./canvasGestures";

const box = { x: 100, y: 50, width: 200, height: 100 };
const plain = { alt: false, shift: false, minSize: 16 };

describe("resizeGeometry", () => {
  it("moves only the dragged edges, in design pixels at the current zoom", () => {
    expect(resizeGeometry(box, "se", { x: 40, y: 20 }, 2, plain)).toEqual({
      x: 100,
      y: 50,
      width: 220,
      height: 110,
      changed: { width: true, height: true },
    });
    expect(resizeGeometry(box, "w", { x: 20, y: 99 }, 1, plain)).toEqual({
      x: 120,
      y: 50,
      width: 180,
      height: 100,
      changed: { width: true, height: false },
    });
  });

  it("keeps the ratio with Shift and resizes from the centre with Alt", () => {
    expect(resizeGeometry(box, "e", { x: 100, y: 0 }, 1, { ...plain, shift: true })).toMatchObject({
      width: 300,
      height: 150,
    });
    expect(resizeGeometry(box, "e", { x: 10, y: 0 }, 1, { ...plain, alt: true })).toMatchObject({
      x: 90,
      width: 220,
    });
  });

  it("never goes under the minimum size", () => {
    expect(resizeGeometry(box, "nw", { x: 500, y: 500 }, 1, plain)).toMatchObject({
      width: 16,
      height: 16,
      x: 284,
      y: 134,
    });
  });
});

it("drags to whole design pixels", () => {
  expect(dragPosition({ x: 10, y: 10 }, { x: 33, y: -7 }, 2)).toEqual({ x: 27, y: 7 });
});
