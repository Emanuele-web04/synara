// FILE: useDesktopTopBarGutter.test.ts
// Purpose: Covers the pure top-bar traffic-light gutter decision helper.
// Layer: Hook unit tests
// Depends on: shouldReserveDesktopTopBarTrafficLightGutter and Vitest assertions.

import { describe, expect, it } from "vitest";

import { shouldReserveDesktopTopBarTrafficLightGutter } from "./useDesktopTopBarGutter";

describe("shouldReserveDesktopTopBarTrafficLightGutter", () => {
  it("never reserves a gutter in the browser build", () => {
    expect(
      shouldReserveDesktopTopBarTrafficLightGutter({
        isElectron: false,
        isMacDesktop: true,
        sidebarSide: "left",
        sidebarOpen: false,
        isMobile: false,
      }),
    ).toBe(false);
    expect(
      shouldReserveDesktopTopBarTrafficLightGutter({
        isElectron: false,
        isMacDesktop: true,
        sidebarSide: "right",
        sidebarOpen: true,
        isMobile: false,
      }),
    ).toBe(false);
  });

  it("never reserves a gutter for non-macOS desktop windows", () => {
    expect(
      shouldReserveDesktopTopBarTrafficLightGutter({
        isElectron: true,
        isMacDesktop: false,
        sidebarSide: "right",
        sidebarOpen: true,
        isMobile: false,
      }),
    ).toBe(false);
  });

  it("reserves a gutter whenever the sidebar is on the right", () => {
    for (const sidebarOpen of [true, false]) {
      expect(
        shouldReserveDesktopTopBarTrafficLightGutter({
          isElectron: true,
          isMacDesktop: true,
          sidebarSide: "right",
          sidebarOpen,
          isMobile: false,
        }),
      ).toBe(true);
    }
  });

  it("lets the left sidebar provide the gutter when it is open on desktop", () => {
    expect(
      shouldReserveDesktopTopBarTrafficLightGutter({
        isElectron: true,
        isMacDesktop: true,
        sidebarSide: "left",
        sidebarOpen: true,
        isMobile: false,
      }),
    ).toBe(false);
  });

  it("reserves a gutter when the left sidebar is collapsed on desktop", () => {
    expect(
      shouldReserveDesktopTopBarTrafficLightGutter({
        isElectron: true,
        isMacDesktop: true,
        sidebarSide: "left",
        sidebarOpen: false,
        isMobile: false,
      }),
    ).toBe(true);
  });

  it("reserves a gutter on mobile because the drawer floats over content", () => {
    for (const sidebarOpen of [true, false]) {
      expect(
        shouldReserveDesktopTopBarTrafficLightGutter({
          isElectron: true,
          isMacDesktop: true,
          sidebarSide: "left",
          sidebarOpen,
          isMobile: true,
        }),
      ).toBe(true);
    }
  });
});
