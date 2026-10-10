import { describe, expect, it } from "vitest";
import type { ComputerWindow } from "@synara/contracts";

import { topmostWindowAtPoint } from "./computerGeometry.ts";

/**
 * The routing rule an unscoped pointer action follows, reproduced for
 * perception: the observation must photograph the window the compositor
 * delivered the action to, or admit it cannot tell.
 */
describe("topmostWindowAtPoint", () => {
  const stackedWindow = (
    id: string,
    bounds: { x: number; y: number; width: number; height: number },
    overrides: Partial<ComputerWindow> = {},
  ): ComputerWindow =>
    ({
      id,
      title: id,
      bounds,
      focused: false,
      minimized: false,
      visible: true,
      ...overrides,
    }) as ComputerWindow;

  it("returns the only containing window even without a stacking order", () => {
    const windows = [
      stackedWindow("aside", { x: 900, y: 0, width: 200, height: 200 }),
      stackedWindow("hit", { x: 0, y: 0, width: 800, height: 600 }),
    ];
    expect(topmostWindowAtPoint(windows, { x: 400, y: 300 })?.id).toBe("hit");
  });

  it("ranks overlapping candidates by stacking index, topmost first", () => {
    const windows = [
      stackedWindow("under", { x: 0, y: 0, width: 800, height: 600 }, { stackingIndex: 2 }),
      stackedWindow("over", { x: 200, y: 100, width: 400, height: 300 }, { stackingIndex: 0 }),
      stackedWindow("middle", { x: 100, y: 50, width: 600, height: 500 }, { stackingIndex: 1 }),
    ];
    expect(topmostWindowAtPoint(windows, { x: 300, y: 200 })?.id).toBe("over");
  });

  it("refuses to rank an overlap when any candidate lacks a stacking index", () => {
    const windows = [
      stackedWindow("ranked", { x: 0, y: 0, width: 800, height: 600 }, { stackingIndex: 0 }),
      stackedWindow("unranked", { x: 200, y: 100, width: 400, height: 300 }),
    ];
    expect(topmostWindowAtPoint(windows, { x: 300, y: 200 })).toBeUndefined();
  });

  it("skips minimized and invisible windows and misses cleanly", () => {
    const windows = [
      stackedWindow("minimized", { x: 0, y: 0, width: 800, height: 600 }, { minimized: true }),
      stackedWindow("hidden", { x: 0, y: 0, width: 800, height: 600 }, { visible: false }),
    ];
    expect(topmostWindowAtPoint(windows, { x: 400, y: 300 })).toBeUndefined();
    expect(topmostWindowAtPoint([], { x: 400, y: 300 })).toBeUndefined();
  });
});
