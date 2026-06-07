// FILE: menuShortcuts.test.ts
// Purpose: Verifies desktop menu accelerator choices that affect native keyboard behavior.

import { describe, expect, it } from "vitest";

import {
  resolveDesktopMenuAccelerator,
  resolveKeyboardShortcutsMenuAccelerator,
  shouldUseNativeZoomMenuRoles,
} from "./menuShortcuts";

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
