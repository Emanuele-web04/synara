import { describe, expect, it } from "vitest";

import {
  DEFAULT_APP_SNAP_SHORTCUT,
  DEFAULT_APP_SNAP_SHORTCUT_WINDOWS,
  appSnapShortcutAccelerator,
  appSnapShortcutLabels,
  appSnapShortcutSystemConflict,
  defaultAppSnapShortcut,
  isAppSnapShortcut,
  isAppSnapShortcutKey,
} from "./appSnapShortcut";

describe("AppSnap shortcuts", () => {
  it("picks a platform default that Windows can register", () => {
    expect(defaultAppSnapShortcut("Win32")).toEqual(DEFAULT_APP_SNAP_SHORTCUT_WINDOWS);
    expect(defaultAppSnapShortcut("darwin")).toEqual(DEFAULT_APP_SNAP_SHORTCUT);
    expect(defaultAppSnapShortcut("")).toEqual(DEFAULT_APP_SNAP_SHORTCUT);
    expect(DEFAULT_APP_SNAP_SHORTCUT_WINDOWS).toEqual({
      kind: "key-chord",
      modifier: "control",
      key: "KeyY",
    });
    expect(appSnapShortcutSystemConflict(DEFAULT_APP_SNAP_SHORTCUT_WINDOWS, "windows")).toBeNull();
  });

  it("accepts DOM key codes, including Enter", () => {
    expect(isAppSnapShortcutKey("KeyS")).toBe(true);
    expect(isAppSnapShortcutKey("Enter")).toBe(true);
    expect(isAppSnapShortcutKey("Return")).toBe(false);
  });

  it("formats the portable chord for Electron and the UI", () => {
    const shortcut = { kind: "key-chord", modifier: "command", key: "KeyK" } as const;
    expect(appSnapShortcutAccelerator(shortcut)).toBe("Command+K");
    expect(appSnapShortcutLabels(shortcut)).toEqual(["⌘ Command", "K"]);
    expect(appSnapShortcutLabels(shortcut, "windows")).toEqual(["Win", "K"]);
    expect(
      appSnapShortcutLabels({ kind: "key-chord", modifier: "control", key: "KeyY" }, "windows"),
    ).toEqual(["Ctrl", "Y"]);
    expect(
      appSnapShortcutAccelerator({ kind: "key-chord", modifier: "option", key: "Enter" }),
    ).toBe("Alt+Return");
  });

  it("uses Windows-friendly conflict copy off macOS", () => {
    expect(
      appSnapShortcutSystemConflict(
        { kind: "key-chord", modifier: "control", key: "KeyC" },
        "windows",
      ),
    ).toBe("Ctrl C interrupts the running program in every terminal.");
    expect(
      appSnapShortcutSystemConflict(
        { kind: "key-chord", modifier: "command", key: "Space" },
        "windows",
      ),
    ).toBe("Windows uses Win Space to switch keyboard inputs.");
    expect(
      appSnapShortcutSystemConflict(
        { kind: "key-chord", modifier: "shift", key: "KeyS" },
        "windows",
      ),
    ).toMatch(/combine with Ctrl, Alt, or Win/);
  });

  it("rejects unsupported persisted key codes", () => {
    expect(isAppSnapShortcut({ kind: "key-chord", modifier: "option", key: "F13" })).toBe(false);
  });

  it("flags universal command chords macOS would happily hand over", () => {
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "command", key: "KeyC" }),
    ).toBe("⌘ C is Copy in almost every app.");
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "command", key: "Space" }),
    ).toBe("macOS uses ⌘ Space for Spotlight.");
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "option", key: "KeyC" }),
    ).toBeNull();
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "command", key: "KeyK" }),
    ).toBeNull();
  });

  it("flags chords that would break typing or terminals", () => {
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "shift", key: "KeyS" }),
    ).toMatch(/typing and text selection/);
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "control", key: "KeyC" }),
    ).toBe("⌃ C interrupts the running program in every terminal.");
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "control", key: "KeyK" }),
    ).toBeNull();
  });
});
