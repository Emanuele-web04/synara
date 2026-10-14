import { describe, expect, it } from "vitest";

import { DEFAULT_UI_DENSITY, getDensityCssVariables, normalizeUiDensity } from "./appDensity";

describe("appDensity", () => {
  it("normalizes unknown values to the default density", () => {
    expect(normalizeUiDensity("spacious")).toBe("spacious");
    expect(normalizeUiDensity("invalid")).toBe(DEFAULT_UI_DENSITY);
    expect(normalizeUiDensity(undefined)).toBe(DEFAULT_UI_DENSITY);
  });

  it("derives scaled spacing variables from the active density", () => {
    const compact = getDensityCssVariables("compact");
    const comfortable = getDensityCssVariables("comfortable");

    expect(compact["--density-scale"]).toBe("0.85");
    expect(comfortable["--density-scale"]).toBe("1");
    expect(compact["--app-density-row-height"]).toBe("1.4875rem");
    expect(comfortable["--app-density-row-height"]).toBe("1.75rem");
    expect(compact["--app-density-composer-editor-min-height"]).toBe("calc(2lh * 0.85)");
    expect(comfortable["--app-density-composer-footer-padding-end"]).toBe("0.5rem");
  });
});
