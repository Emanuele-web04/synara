import { describe, expect, it } from "vitest";

import {
  DEFAULT_UI_DENSITY,
  getDensityCssVariables,
  getDensityScale,
  normalizeUiDensity,
} from "./appDensity";

describe("appDensity", () => {
  it("normalizes unknown values to the default density", () => {
    expect(normalizeUiDensity("spacious")).toBe("spacious");
    expect(normalizeUiDensity("invalid")).toBe(DEFAULT_UI_DENSITY);
    expect(normalizeUiDensity(undefined)).toBe(DEFAULT_UI_DENSITY);
  });

  it("maps density modes to scale factors", () => {
    expect(getDensityScale("compact")).toBe(0.85);
    expect(getDensityScale("comfortable")).toBe(1);
    expect(getDensityScale("spacious")).toBe(1.15);
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
