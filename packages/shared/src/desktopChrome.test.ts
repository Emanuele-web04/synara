import { describe, expect, it } from "vitest";

import {
  MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX,
  resolveMacDesktopTopBarTrafficLightGutterCssPx,
} from "./desktopChrome";

describe("resolveMacDesktopTopBarTrafficLightGutterCssPx", () => {
  it("returns the base gutter at zoom 1", () => {
    expect(resolveMacDesktopTopBarTrafficLightGutterCssPx(1)).toBe(
      MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX,
    );
  });

  it("inverse-scales the gutter as zoom increases", () => {
    expect(resolveMacDesktopTopBarTrafficLightGutterCssPx(1.1)).toBe(82);
    expect(resolveMacDesktopTopBarTrafficLightGutterCssPx(2)).toBe(45);
  });

  it("inverse-scales the gutter as zoom decreases", () => {
    expect(resolveMacDesktopTopBarTrafficLightGutterCssPx(0.8)).toBe(113);
  });

  it("falls back to zoom 1 for invalid factors", () => {
    expect(resolveMacDesktopTopBarTrafficLightGutterCssPx(0)).toBe(
      MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX,
    );
    expect(resolveMacDesktopTopBarTrafficLightGutterCssPx(Number.NaN)).toBe(
      MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX,
    );
  });
});
