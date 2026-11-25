// FILE: windowClosePolicy.test.ts
// Purpose: Guards the macOS hide-on-close boundary: an ordinary close hides,
//          while a quit or updater-owned close is allowed through.

import { describe, expect, it } from "vitest";

import { shouldHideMainWindowOnClose, type DesktopWindowCloseState } from "./windowClosePolicy";

const idle: DesktopWindowCloseState = {
  platform: "darwin",
  quitting: false,
  shutdownComplete: false,
  updaterHandoffActive: false,
  updaterInstallPreparing: false,
};

describe("shouldHideMainWindowOnClose", () => {
  it("hides an ordinary close on macOS", () => {
    expect(shouldHideMainWindowOnClose(idle)).toBe(true);
  });

  it("lets a quit, shutdown, or updater-owned close pass through", () => {
    expect(shouldHideMainWindowOnClose({ ...idle, quitting: true })).toBe(false);
    expect(shouldHideMainWindowOnClose({ ...idle, shutdownComplete: true })).toBe(false);
    expect(shouldHideMainWindowOnClose({ ...idle, updaterHandoffActive: true })).toBe(false);
    expect(shouldHideMainWindowOnClose({ ...idle, updaterInstallPreparing: true })).toBe(false);
  });

  it("closes on platforms that have nowhere to reopen the window", () => {
    expect(shouldHideMainWindowOnClose({ ...idle, platform: "win32" })).toBe(false);
    expect(shouldHideMainWindowOnClose({ ...idle, platform: "linux" })).toBe(false);
  });
});
