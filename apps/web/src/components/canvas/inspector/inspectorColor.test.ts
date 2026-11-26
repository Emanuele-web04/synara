import { describe, expect, it } from "vitest";
import {
  colorChannels,
  formatColor,
  isOutOfSrgb,
  linearToRgba,
  nudgeNumberAt,
  okhsvToLinear,
  parseWideColor,
  pickerToRgba,
  rgbaToHsl,
  rgbaToHsv,
  rgbaToOkhsv,
  rgbaToOklch,
  rgbaToPicker,
} from "./inspectorColor";

const red = { r: 255, g: 0, b: 0, a: 1 };

describe("colour spaces", () => {
  it("converts sRGB to OKLCH, HSL and HSV", () => {
    const oklch = rgbaToOklch(red);
    expect(oklch.l).toBeCloseTo(0.628, 3);
    expect(oklch.c).toBeCloseTo(0.2577, 3);
    expect(oklch.h).toBeCloseTo(29.23, 1);
    expect(rgbaToHsl({ r: 0, g: 128, b: 255, a: 1 })).toMatchObject({
      h: expect.closeTo(209.9, 1),
      s: 1,
    });
    expect(rgbaToHsv({ r: 128, g: 128, b: 128, a: 1 })).toEqual({ h: 0, s: 0, v: 128 / 255 });
  });

  it("round-trips OKHSV, the picker's default space, and classic HSV", () => {
    for (const color of [red, { r: 30, g: 200, b: 120, a: 1 }, { r: 12, g: 34, b: 250, a: 0.5 }]) {
      for (const space of ["okhsv", "hsv"] as const) {
        const back = pickerToRgba(space, rgbaToPicker(space, color, 0), color.a);
        expect(Math.abs(back.r - color.r)).toBeLessThanOrEqual(1);
        expect(Math.abs(back.g - color.g)).toBeLessThanOrEqual(1);
        expect(Math.abs(back.b - color.b)).toBeLessThanOrEqual(1);
        expect(back.a).toBe(color.a);
      }
    }
    // White and black sit at the area's corners; greys keep the picker's hue.
    expect(rgbaToOkhsv({ r: 255, g: 255, b: 255, a: 1 }, 120)).toEqual({
      h: 120,
      s: 0,
      v: expect.closeTo(1, 4),
    });
    expect(rgbaToOkhsv({ r: 0, g: 0, b: 0, a: 1 }, 40)).toEqual({ h: 40, s: 0, v: 0 });
    expect(linearToRgba(okhsvToLinear({ h: 0, s: 0, v: 1 }))).toEqual({
      r: 255,
      g: 255,
      b: 255,
      a: 1,
    });
  });

  it("detects colours outside sRGB for the Clipped badge", () => {
    const p3 = parseWideColor("color(display-p3 1 0 0)")!;
    expect(isOutOfSrgb(p3.linear)).toBe(true);
    expect(isOutOfSrgb(parseWideColor("oklch(0.7 0.35 150 / 50%)")!.linear)).toBe(true);
    expect(parseWideColor("oklch(0.7 0.35 150 / 50%)")!.alpha).toBe(0.5);
    expect(isOutOfSrgb(parseWideColor("oklch(0.628 0.2577 29.23)")!.linear)).toBe(false);
    expect(isOutOfSrgb(parseWideColor("color(srgb 0.5 0.2 1)")!.linear)).toBe(false);
    expect(parseWideColor("#ff0000")).toBeNull();
  });

  it("writes each text format and the channel rows", () => {
    expect(formatColor(red, "hex")).toBe("#FF0000");
    expect(formatColor({ ...red, a: 0.5 }, "rgb")).toBe("rgb(255 0 0 / 50%)");
    expect(formatColor(red, "hsl")).toBe("hsl(0 100% 50%)");
    expect(formatColor(red, "oklch")).toBe("oklch(0.628 0.258 29.2)");
    expect(colorChannels(red)).toEqual({
      oklch: ["0.628", "0.258", "29.2"],
      hsl: ["0", "100%", "50%"],
      rgb: ["255", "0", "0"],
    });
  });

  it("nudges the number under the caret", () => {
    expect(nudgeNumberAt("rgb(10 20 30)", 8, 1, false)).toEqual({
      text: "rgb(10 21 30)",
      caret: 9,
    });
    expect(nudgeNumberAt("oklch(0.62 0.2 30)", 8, -1, false)).toEqual({
      text: "oklch(0.61 0.2 30)",
      caret: 10,
    });
    expect(nudgeNumberAt("rgb(10 20 30)", 4, 1, true)?.text).toBe("rgb(20 20 30)");
    expect(nudgeNumberAt("red", 1, 1, false)).toBeNull();
  });
});
