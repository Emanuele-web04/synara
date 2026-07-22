import { describe, expect, it } from "vitest";

import {
  appSnapShortcutAccelerator,
  appSnapShortcutLabels,
  appSnapShortcutSystemConflict,
  isAppSnapShortcut,
  isAppSnapShortcutKey,
} from "./appSnapShortcut";

describe("AppSnap shortcuts", () => {
  it("accepts DOM key codes, including Enter", () => {
    expect(isAppSnapShortcutKey("KeyS")).toBe(true);
    expect(isAppSnapShortcutKey("Enter")).toBe(true);
    expect(isAppSnapShortcutKey("Return")).toBe(false);
  });

  it("formats the portable chord for Electron and the UI", () => {
    const shortcut = { kind: "key-chord", modifier: "command", key: "KeyK" } as const;
    expect(appSnapShortcutAccelerator(shortcut)).toBe("Command+K");
    expect(appSnapShortcutLabels(shortcut)).toEqual(["⌘ Command", "K"]);
    expect(
      appSnapShortcutAccelerator({ kind: "key-chord", modifier: "option", key: "Enter" }),
    ).toBe("Alt+Return");
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
