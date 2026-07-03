import { describe, expect, it } from "vitest";

import { cssColorToHexInput, hexColorWithAlpha, parseCssColor } from "./cssColor";

// Canvas-backed normalization (named colors, hsl(), ...) is unavailable in
// jsdom, so these tests cover the direct hex paths plus fallback behavior.
describe("parseCssColor", () => {
  it("parses 3/4/6/8-digit hex", () => {
    expect(parseCssColor("#abc")).toEqual({ hex: "#aabbcc", alpha: 1 });
    expect(parseCssColor("#abcd")?.hex).toBe("#aabbcc");
    expect(parseCssColor("#abcd")?.alpha).toBeCloseTo(0.867, 2);
    expect(parseCssColor("#1A2B3C")).toEqual({ hex: "#1a2b3c", alpha: 1 });
    expect(parseCssColor("#1a2b3c80")?.alpha).toBeCloseTo(0.502, 2);
  });

  it("rejects malformed hex lengths and empty values", () => {
    expect(parseCssColor("#abcde")).toBeNull();
    expect(parseCssColor("")).toBeNull();
    expect(parseCssColor(undefined)).toBeNull();
  });
});

describe("cssColorToHexInput", () => {
  it("always yields a 6-digit hex for the native color input", () => {
    expect(cssColorToHexInput("#abc")).toBe("#aabbcc");
    expect(cssColorToHexInput("definitely-not-a-color")).toBe("#000000");
  });
});

describe("hexColorWithAlpha", () => {
  it("keeps opaque colors as 6-digit hex", () => {
    expect(hexColorWithAlpha("#aabbcc", 1)).toBe("#aabbcc");
  });

  it("appends the alpha channel for translucent colors", () => {
    expect(hexColorWithAlpha("#aabbcc", 0.5)).toBe("#aabbcc80");
  });
});
