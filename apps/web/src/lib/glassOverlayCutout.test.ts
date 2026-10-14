import { describe, expect, it } from "vitest";

import { computedColorAlpha } from "./glassOverlayCutout";

describe("computedColorAlpha", () => {
  it("reads the alpha of every computed color form", () => {
    expect(computedColorAlpha("transparent")).toBe(0);
    expect(computedColorAlpha("rgba(0, 0, 0, 0)")).toBe(0);
    expect(computedColorAlpha("rgba(0, 0, 0, 0.6)")).toBe(0.6);
    expect(computedColorAlpha("rgb(255, 255, 255)")).toBe(1);
    expect(computedColorAlpha("color(srgb 1 1 1 / 0.15)")).toBe(0.15);
    expect(computedColorAlpha("color(srgb 0.09 0.09 0.09)")).toBe(1);
    expect(computedColorAlpha("oklab(0.2 0 0 / 0.96)")).toBe(0.96);
  });
});
