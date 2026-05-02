// FILE: menuShortcuts.test.ts
// Purpose: Verifies desktop menu accelerator choices that affect native keyboard behavior.

import { describe, expect, it } from "vitest";

import { resolveKeyboardShortcutsMenuAccelerator } from "./menuShortcuts";

describe("resolveKeyboardShortcutsMenuAccelerator", () => {
  it("uses the native shortcuts help accelerator on macOS", () => {
    expect(resolveKeyboardShortcutsMenuAccelerator("darwin")).toBe("Cmd+/");
  });

  it("leaves Windows and Linux zoom shortcuts to Electron's native View menu roles", () => {
    expect(resolveKeyboardShortcutsMenuAccelerator("win32")).toBeUndefined();
    expect(resolveKeyboardShortcutsMenuAccelerator("linux")).toBeUndefined();
  });
});
