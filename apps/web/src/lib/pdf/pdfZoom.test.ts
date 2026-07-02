import { describe, expect, it } from "vitest";

import {
  clampPdfScale,
  formatZoomPercent,
  nextZoomScale,
  PDF_MAX_SCALE,
  PDF_MIN_SCALE,
  previousZoomScale,
  resolvePdfScale,
} from "./pdfZoom";

describe("clampPdfScale", () => {
  it("clamps to the min/max bounds", () => {
    expect(clampPdfScale(10)).toBe(PDF_MAX_SCALE);
    expect(clampPdfScale(0.01)).toBe(PDF_MIN_SCALE);
    expect(clampPdfScale(1.5)).toBe(1.5);
  });

  it("falls back to 1 for invalid input", () => {
    expect(clampPdfScale(Number.NaN)).toBe(1);
    expect(clampPdfScale(-3)).toBe(1);
    expect(clampPdfScale(0)).toBe(1);
  });
});

describe("resolvePdfScale", () => {
  const page = { width: 100, height: 200 };

  it("fits width using the usable container width minus margins", () => {
    // usable = 148 - 24*2 = 100; 100 / 100 = 1
    expect(resolvePdfScale({ type: "fit-width" }, page, { width: 148, height: 999 })).toBe(1);
  });

  it("fits page to the smaller of width-fit and height-fit", () => {
    // fit-width = 1; usable height = 148 - 48 = 100; 100/200 = 0.5 -> min = 0.5
    expect(resolvePdfScale({ type: "fit-page" }, page, { width: 148, height: 148 })).toBe(0.5);
  });

  it("uses the explicit (clamped) scale for custom mode regardless of layout", () => {
    expect(resolvePdfScale({ type: "custom", scale: 2 }, null, null)).toBe(2);
    expect(resolvePdfScale({ type: "custom", scale: 99 }, page, { width: 148, height: 148 })).toBe(
      PDF_MAX_SCALE,
    );
  });

  it("returns 1 when layout inputs are missing in a fit mode", () => {
    expect(resolvePdfScale({ type: "fit-width" }, null, null)).toBe(1);
    expect(resolvePdfScale({ type: "fit-page" }, page, null)).toBe(1);
  });
});

describe("zoom stepping", () => {
  it("steps up to the next preset", () => {
    expect(nextZoomScale(1)).toBe(1.25);
    expect(nextZoomScale(0.5)).toBe(0.75);
  });

  it("caps zoom-in at the max scale when above the last preset", () => {
    expect(nextZoomScale(4)).toBe(PDF_MAX_SCALE);
  });

  it("steps down to the previous preset", () => {
    expect(previousZoomScale(1)).toBe(0.75);
    expect(previousZoomScale(4)).toBe(3);
  });

  it("floors zoom-out at the min scale when below the first preset", () => {
    expect(previousZoomScale(0.5)).toBe(PDF_MIN_SCALE);
  });
});

describe("formatZoomPercent", () => {
  it("formats scale as a rounded percentage", () => {
    expect(formatZoomPercent(1)).toBe("100%");
    expect(formatZoomPercent(1.25)).toBe("125%");
    expect(formatZoomPercent(0.5)).toBe("50%");
  });
});
