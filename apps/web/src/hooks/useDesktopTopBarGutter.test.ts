// FILE: useDesktopTopBarGutter.test.ts
// Purpose: Covers pure desktop top-bar gutter decision helpers.
// Layer: Hook unit tests
// Depends on: useDesktopTopBarGutter pure helpers and Vitest assertions.

import { describe, expect, it } from "vitest";

import {
  DESKTOP_TOP_BAR_NATIVE_WINDOW_CONTROLS_GUTTER_CLASS,
  DESKTOP_TOP_BAR_WINDOW_CONTROLS_GUTTER_CLASS,
  resolveDesktopTopBarWindowControlsGutterClass,
  shouldReserveDesktopTopBarTrafficLightGutter,
} from "./useDesktopTopBarGutter";

describe("shouldReserveDesktopTopBarTrafficLightGutter", () => {
  it("never reserves a gutter in the browser build", () => {
    expect(
      shouldReserveDesktopTopBarTrafficLightGutter({
        isElectron: false,
        isMacDesktop: true,
        sidebarOpen: false,
        isMobile: false,
      }),
    ).toBe(false);
  });

  it("never reserves a gutter for non-macOS desktop windows", () => {
    expect(
      shouldReserveDesktopTopBarTrafficLightGutter({
        isElectron: true,
        isMacDesktop: false,
        sidebarOpen: false,
        isMobile: false,
      }),
    ).toBe(false);
  });

  it("lets the sidebar provide the gutter when it is open on desktop", () => {
    expect(
      shouldReserveDesktopTopBarTrafficLightGutter({
        isElectron: true,
        isMacDesktop: true,
        sidebarOpen: true,
        isMobile: false,
      }),
    ).toBe(false);
  });

  it("reserves a gutter when the sidebar is collapsed on desktop", () => {
    expect(
      shouldReserveDesktopTopBarTrafficLightGutter({
        isElectron: true,
        isMacDesktop: true,
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
          sidebarOpen,
          isMobile: true,
        }),
      ).toBe(true);
    }
  });
});

describe("resolveDesktopTopBarWindowControlsGutterClass", () => {
  it("never reserves a gutter outside Electron", () => {
    expect(
      resolveDesktopTopBarWindowControlsGutterClass({
        isElectron: false,
        customTitleBarMode: "native-overlay",
      }),
    ).toBeNull();
  });

  it("never reserves a gutter when the live window still has a native frame", () => {
    expect(
      resolveDesktopTopBarWindowControlsGutterClass({
        isElectron: true,
        customTitleBarMode: "native-frame",
      }),
    ).toBeNull();
  });

  it("uses OS geometry for native overlay controls", () => {
    expect(
      resolveDesktopTopBarWindowControlsGutterClass({
        isElectron: true,
        customTitleBarMode: "native-overlay",
      }),
    ).toBe(DESKTOP_TOP_BAR_NATIVE_WINDOW_CONTROLS_GUTTER_CLASS);
  });

  it("keeps the fixed renderer-control gutter on Linux", () => {
    expect(
      resolveDesktopTopBarWindowControlsGutterClass({
        isElectron: true,
        customTitleBarMode: "renderer",
      }),
    ).toBe(DESKTOP_TOP_BAR_WINDOW_CONTROLS_GUTTER_CLASS);
  });
});
