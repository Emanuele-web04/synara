import { describe, expect, it } from "vitest";
import {
  drawnRect,
  framesWithBlockedLabels,
  measureDistances,
  sizeBadgeText,
} from "./canvasMeasure";

const values = (lines: ReturnType<typeof measureDistances>) =>
  lines.map((line) => `${line.axis}:${line.value}`);

describe("measureDistances", () => {
  it("measures the four insets when the target holds the selection", () => {
    const lines = measureDistances(
      { x: 20, y: 30, width: 40, height: 10 },
      { x: 0, y: 0, width: 100, height: 100 },
      1,
    );
    expect(values(lines)).toEqual(["y:30", "y:60", "x:20", "x:40"]);
    expect(lines[0]).toMatchObject({ x: 40, from: 0, to: 30 });
  });

  it("measures the insets of a target inside the selection the same way", () => {
    const lines = measureDistances(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 10, y: 10, width: 80, height: 80 },
      1,
    );
    expect(values(lines)).toEqual(["y:10", "y:10", "x:10", "x:10"]);
  });

  it("measures the gap between separate boxes in design pixels", () => {
    // Stacked boxes 18 design px apart at 50% zoom; they overlap horizontally, so the line sits
    // in the middle of the shared span.
    const lines = measureDistances(
      { x: 10, y: 60, width: 100, height: 20 },
      { x: 30, y: 0, width: 100, height: 51 },
      0.5,
    );
    expect(lines).toEqual([{ axis: "y", x: 70, y: 0, from: 51, to: 60, value: 18 }]);
  });

  it("measures both axes for diagonal boxes and drops touching edges", () => {
    expect(
      values(
        measureDistances(
          { x: 0, y: 0, width: 10, height: 10 },
          { x: 30, y: 50, width: 10, height: 10 },
          1,
        ),
      ),
    ).toEqual(["x:20", "y:40"]);
    expect(
      measureDistances(
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 10, y: 0, width: 10, height: 10 },
        1,
      ),
    ).toEqual([]);
  });
});

describe("drawnRect", () => {
  const start = { x: 100, y: 100 };
  const plain = { shift: false, alt: false };

  it("spans the press and the pointer in any direction", () => {
    expect(drawnRect(start, { x: 40, y: 160 }, plain)).toEqual({
      x: 40,
      y: 100,
      width: 60,
      height: 60,
    });
  });

  it("keeps a square with Shift, on the longer side, towards the pointer", () => {
    expect(drawnRect(start, { x: 130, y: 180 }, { shift: true, alt: false })).toEqual({
      x: 100,
      y: 100,
      width: 80,
      height: 80,
    });
    expect(drawnRect(start, { x: 70, y: 150 }, { shift: true, alt: false })).toEqual({
      x: 50,
      y: 100,
      width: 50,
      height: 50,
    });
  });

  it("draws from the centre with Alt, and both together make a centred square", () => {
    expect(drawnRect(start, { x: 130, y: 120 }, { shift: false, alt: true })).toEqual({
      x: 70,
      y: 80,
      width: 60,
      height: 40,
    });
    expect(drawnRect(start, { x: 130, y: 120 }, { shift: true, alt: true })).toEqual({
      x: 70,
      y: 70,
      width: 60,
      height: 60,
    });
  });
});

describe("sizeBadgeText", () => {
  const names = { fit: "Fit", fill: "Fill", relative: "Relative" };

  it("names a size's mode only when it is not fixed", () => {
    expect(sizeBadgeText({ width: 320.4, height: 48 })).toBe("320 × 48");
    expect(sizeBadgeText({ width: 320, height: 48 }, { width: "fit", height: "fill" }, names)).toBe(
      "Fit 320 × Fill 48",
    );
    expect(
      sizeBadgeText({ width: 320, height: 48 }, { width: "fixed", height: "relative" }, names),
    ).toBe("320 × Relative 48");
  });
});

const frame = (id: string, x: number, y: number) => ({ id, x, y, width: 200, height: 100 });

describe("framesWithBlockedLabels", () => {
  it("hides a label that would cover the frame close above it, at the current zoom", () => {
    // 20 design px apart: the 25 px label row fits at 200%, not at 100% or 50%.
    const stacked = [frame("top", 0, 0), frame("below", 0, 120)];
    expect([...framesWithBlockedLabels(stacked, 1, 25)]).toEqual(["below"]);
    expect([...framesWithBlockedLabels(stacked, 2, 25)]).toEqual([]);
    expect([...framesWithBlockedLabels(stacked, 0.5, 25)]).toEqual(["below"]);
  });

  it("leaves labels alone beside a neighbour that starts lower, or across a wide gap", () => {
    expect([...framesWithBlockedLabels([frame("a", 0, 0), frame("b", 210, 0)], 1, 25)]).toEqual([]);
    expect([...framesWithBlockedLabels([frame("a", 0, 0), frame("b", 0, 200)], 1, 25)]).toEqual([]);
    // A taller neighbour reaching up beside the frame covers its label band.
    expect(
      [
        ...framesWithBlockedLabels(
          [frame("a", 0, 100), { id: "tall", x: 150, y: 0, width: 200, height: 300 }],
          1,
          25,
        ),
      ].toSorted(),
    ).toEqual(["a"]);
  });
});
