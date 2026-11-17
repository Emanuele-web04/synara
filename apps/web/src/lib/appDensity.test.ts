import { describe, expect, it } from "vitest";

import { DEFAULT_UI_DENSITY, normalizeUiDensity } from "./appDensity";

describe("appDensity", () => {
  it("normalizes unknown values to the default density", () => {
    expect(normalizeUiDensity("spacious")).toBe("spacious");
    expect(normalizeUiDensity("invalid")).toBe(DEFAULT_UI_DENSITY);
    expect(normalizeUiDensity(undefined)).toBe(DEFAULT_UI_DENSITY);
  });
});
