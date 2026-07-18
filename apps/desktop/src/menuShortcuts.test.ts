// FILE: menuShortcuts.test.ts
// Purpose: Verifies desktop menu accelerator choices that affect native keyboard behavior.

import { describe, expect, it } from "vitest";

import {
  resolveDesktopMenuAccelerator,
  resolveDesktopTabMenuItems,
  resolveKeyboardShortcutsMenuAccelerator,
  shouldUseNativeZoomMenuRoles,
} from "./menuShortcuts";

describe("resolveDesktopTabMenuItems", () => {
  it("routes the native close shortcuts to tab actions on macOS", () => {
    expect(resolveDesktopTabMenuItems("darwin")).toEqual([
      {
        label: "Close Tab",
        action: "close-active-tab",
        accelerator: "CmdOrCtrl+W",
      },
      {
        label: "Reopen Closed Tab",
        action: "reopen-closed-tab",
        accelerator: "CmdOrCtrl+Shift+W",
      },
    ]);
  });

  it("keeps Linux menu actions without native accelerators", () => {
    expect(resolveDesktopTabMenuItems("linux")).toEqual([
      { label: "Close Tab", action: "close-active-tab" },
      { label: "Reopen Closed Tab", action: "reopen-closed-tab" },
    ]);
  });
});

describe("resolveDesktopMenuAccelerator", () => {
  it("disables custom native menu accelerators on Linux", () => {
    expect(resolveDesktopMenuAccelerator("linux", "CmdOrCtrl+B")).toBeUndefined();
  });

  it("keeps custom native menu accelerators on macOS and Windows", () => {
    expect(resolveDesktopMenuAccelerator("darwin", "CmdOrCtrl+B")).toBe("CmdOrCtrl+B");
    expect(resolveDesktopMenuAccelerator("win32", "CmdOrCtrl+B")).toBe("CmdOrCtrl+B");
  });
});

describe("shouldUseNativeZoomMenuRoles", () => {
  it("avoids Electron's role-provided zoom accelerators on Linux", () => {
    expect(shouldUseNativeZoomMenuRoles("linux")).toBe(false);
  });

  it("keeps native zoom roles on macOS and Windows", () => {
    expect(shouldUseNativeZoomMenuRoles("darwin")).toBe(true);
    expect(shouldUseNativeZoomMenuRoles("win32")).toBe(true);
  });
});

describe("resolveKeyboardShortcutsMenuAccelerator", () => {
  it("uses the native shortcuts help accelerator on macOS", () => {
    expect(resolveKeyboardShortcutsMenuAccelerator("darwin")).toBe("Cmd+/");
  });

  it("does not assign a global shortcuts help accelerator outside macOS", () => {
    expect(resolveKeyboardShortcutsMenuAccelerator("win32")).toBeUndefined();
    expect(resolveKeyboardShortcutsMenuAccelerator("linux")).toBeUndefined();
  });
});
