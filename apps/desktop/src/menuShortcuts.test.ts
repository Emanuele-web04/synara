import { describe, expect, it, vi } from "vitest";

import {
  applyDesktopPhysicalZoomAction,
  DEFAULT_DESKTOP_MENU_ACCELERATORS,
  keybindingShortcutToAccelerator,
  resolveDesktopMenuAccelerator,
  resolveReportedMenuAccelerators,
  sameDesktopMenuAccelerators,
  resolveDesktopPhysicalZoomAction,
  resolveDesktopZoomShortcutAction,
  resolveKeyboardShortcutsMenuAccelerator,
  shouldUseNativeZoomMenuRoles,
} from "./menuShortcuts";

describe("resolveDesktopPhysicalZoomAction", () => {
  const windowsCtrlInput = {
    type: "keyDown",
    key: "",
    control: true,
    meta: false,
    shift: false,
    alt: false,
  };

  it("handles both physical minus keys as zoom-out on Windows", () => {
    expect(resolveDesktopPhysicalZoomAction("win32", { ...windowsCtrlInput, code: "Minus" })).toBe(
      "zoomOut",
    );
    expect(
      resolveDesktopPhysicalZoomAction("win32", {
        ...windowsCtrlInput,
        code: "NumpadSubtract",
      }),
    ).toBe("zoomOut");
  });

  it("uses the translated minus value for Windows layouts whose physical code is Slash", () => {
    expect(
      resolveDesktopPhysicalZoomAction("win32", {
        ...windowsCtrlInput,
        key: "-",
        code: "Slash",
      }),
    ).toBe("zoomOut");
  });

  it("does not intercept slash or modified minus chords", () => {
    expect(
      resolveDesktopPhysicalZoomAction("win32", { ...windowsCtrlInput, code: "Slash" }),
    ).toBeNull();
    expect(
      resolveDesktopPhysicalZoomAction("win32", {
        ...windowsCtrlInput,
        code: "Minus",
        shift: true,
      }),
    ).toBeNull();
    expect(
      resolveDesktopPhysicalZoomAction("win32", {
        ...windowsCtrlInput,
        code: "Minus",
        alt: true,
      }),
    ).toBeNull();
    expect(
      resolveDesktopPhysicalZoomAction("win32", {
        ...windowsCtrlInput,
        code: "Minus",
        meta: true,
      }),
    ).toBeNull();
  });

  it("only handles Windows Ctrl key-down events", () => {
    expect(
      resolveDesktopPhysicalZoomAction("win32", {
        ...windowsCtrlInput,
        type: "keyUp",
        code: "Minus",
      }),
    ).toBeNull();
    expect(
      resolveDesktopPhysicalZoomAction("win32", {
        ...windowsCtrlInput,
        control: false,
        code: "Minus",
      }),
    ).toBeNull();
    expect(
      resolveDesktopPhysicalZoomAction("darwin", { ...windowsCtrlInput, code: "Minus" }),
    ).toBeNull();
    expect(
      resolveDesktopPhysicalZoomAction("linux", { ...windowsCtrlInput, code: "Minus" }),
    ).toBeNull();
  });
});

describe("resolveDesktopZoomShortcutAction", () => {
  const linuxCtrlInput = {
    type: "keyDown",
    key: "",
    control: true,
    meta: false,
    shift: false,
    alt: false,
  };

  it("zooms in on Ctrl+= and Ctrl++ (shifted plus included)", () => {
    expect(
      resolveDesktopZoomShortcutAction("linux", { ...linuxCtrlInput, key: "=", code: "Equal" }),
    ).toBe("zoomIn");
    // Italian and other layouts type "+" with Shift held.
    expect(
      resolveDesktopZoomShortcutAction("linux", {
        ...linuxCtrlInput,
        key: "+",
        code: "BracketRight",
        shift: true,
      }),
    ).toBe("zoomIn");
  });

  it("zooms in on the numpad plus key", () => {
    expect(
      resolveDesktopZoomShortcutAction("linux", {
        ...linuxCtrlInput,
        key: "Add",
        code: "NumpadAdd",
      }),
    ).toBe("zoomIn");
  });

  it("zooms out on Ctrl+- and resets on Ctrl+0", () => {
    expect(
      resolveDesktopZoomShortcutAction("linux", { ...linuxCtrlInput, key: "-", code: "Minus" }),
    ).toBe("zoomOut");
    expect(
      resolveDesktopZoomShortcutAction("linux", { ...linuxCtrlInput, key: "0", code: "Digit0" }),
    ).toBe("resetZoom");
  });

  it("does not steal shifted minus/zero or modified chords", () => {
    expect(
      resolveDesktopZoomShortcutAction("linux", {
        ...linuxCtrlInput,
        key: "_",
        code: "Minus",
        shift: true,
      }),
    ).toBeNull();
    expect(
      resolveDesktopZoomShortcutAction("linux", {
        ...linuxCtrlInput,
        key: "0",
        code: "Digit0",
        shift: true,
      }),
    ).toBeNull();
    expect(
      resolveDesktopZoomShortcutAction("linux", {
        ...linuxCtrlInput,
        key: "+",
        code: "Equal",
        alt: true,
      }),
    ).toBeNull();
    expect(
      resolveDesktopZoomShortcutAction("linux", {
        ...linuxCtrlInput,
        key: "+",
        code: "Equal",
        meta: true,
      }),
    ).toBeNull();
  });

  it("ignores NumLock-off numpad presses that surface as navigation keys", () => {
    expect(
      resolveDesktopZoomShortcutAction("linux", {
        ...linuxCtrlInput,
        key: "Insert",
        code: "Numpad0",
      }),
    ).toBeNull();
  });

  it("only handles Linux Ctrl key-down events", () => {
    expect(
      resolveDesktopZoomShortcutAction("linux", {
        ...linuxCtrlInput,
        type: "keyUp",
        key: "=",
      }),
    ).toBeNull();
    expect(
      resolveDesktopZoomShortcutAction("linux", {
        ...linuxCtrlInput,
        control: false,
        key: "=",
      }),
    ).toBeNull();
    expect(resolveDesktopZoomShortcutAction("win32", { ...linuxCtrlInput, key: "=" })).toBeNull();
    expect(resolveDesktopZoomShortcutAction("darwin", { ...linuxCtrlInput, key: "=" })).toBeNull();
  });
});

describe("applyDesktopPhysicalZoomAction", () => {
  it("uses Electron's native half-level zoom-out step", () => {
    const target = {
      getZoomLevel: vi.fn(() => 1.25),
      setZoomLevel: vi.fn(),
    };

    applyDesktopPhysicalZoomAction(target, "zoomOut");

    expect(target.getZoomLevel).toHaveBeenCalledOnce();
    expect(target.setZoomLevel).toHaveBeenCalledWith(0.75);
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

const shortcut = (
  key: string,
  modifiers: Partial<{
    modKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }> = {},
) => ({
  key,
  modKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

describe("keybindingShortcutToAccelerator", () => {
  it.each([
    [shortcut("b", { modKey: true }), "CmdOrCtrl+B"],
    [shortcut("b", { modKey: true, shiftKey: true }), "CmdOrCtrl+Shift+B"],
    [shortcut("arrowleft", { modKey: true, altKey: true }), "CmdOrCtrl+Alt+Left"],
    [shortcut("arrowdown", { altKey: true }), "Alt+Down"],
    [shortcut(" ", { ctrlKey: true }), "Ctrl+Space"],
    [shortcut("escape", { modKey: true }), "CmdOrCtrl+Escape"],
    [shortcut("+", { modKey: true }), "CmdOrCtrl+Plus"],
    [shortcut("1", { modKey: true }), "CmdOrCtrl+1"],
    [shortcut("\\", { modKey: true }), "CmdOrCtrl+\\"],
    [shortcut("[", { altKey: true }), "Alt+["],
    [shortcut("f5", { modKey: true }), "CmdOrCtrl+F5"],
    [shortcut("f12"), "F12"],
  ])("converts %o to %s", (input, expected) => {
    expect(keybindingShortcutToAccelerator(input, "darwin")).toBe(expected);
  });

  it("maps meta to Cmd on macOS and Super elsewhere without repeating mod", () => {
    expect(keybindingShortcutToAccelerator(shortcut("k", { metaKey: true }), "darwin")).toBe(
      "Cmd+K",
    );
    expect(keybindingShortcutToAccelerator(shortcut("k", { metaKey: true }), "win32")).toBe(
      "Super+K",
    );
    expect(
      keybindingShortcutToAccelerator(shortcut("k", { modKey: true, metaKey: true }), "darwin"),
    ).toBe("CmdOrCtrl+K");
    expect(
      keybindingShortcutToAccelerator(shortcut("k", { modKey: true, ctrlKey: true }), "darwin"),
    ).toBe("CmdOrCtrl+Ctrl+K");
    expect(
      keybindingShortcutToAccelerator(shortcut("k", { modKey: true, ctrlKey: true }), "win32"),
    ).toBe("CmdOrCtrl+K");
  });

  it("returns null for keys Electron cannot express and for unmodified typing keys", () => {
    expect(keybindingShortcutToAccelerator(shortcut("ß", { altKey: true }), "darwin")).toBeNull();
    expect(keybindingShortcutToAccelerator(shortcut("f25", { modKey: true }), "darwin")).toBeNull();
    expect(
      keybindingShortcutToAccelerator(shortcut("unassigned", { modKey: true }), "darwin"),
    ).toBeNull();
    expect(keybindingShortcutToAccelerator(shortcut("b"), "darwin")).toBeNull();
    expect(keybindingShortcutToAccelerator(shortcut("b", { shiftKey: true }), "darwin")).toBeNull();
  });
});

describe("resolveReportedMenuAccelerators", () => {
  const report = {
    "terminal.new": shortcut("t", { modKey: true }),
    "sidebar.toggle": shortcut("j", { modKey: true }),
    "browser.toggle": null,
  };

  it("converts a valid report, leaving unbound commands without an accelerator", () => {
    expect(resolveReportedMenuAccelerators(report, "darwin")).toEqual({
      "terminal.new": "CmdOrCtrl+T",
      "sidebar.toggle": "CmdOrCtrl+J",
      "browser.toggle": null,
    });
  });

  it("rejects malformed reports", () => {
    expect(resolveReportedMenuAccelerators(null, "darwin")).toBeNull();
    expect(resolveReportedMenuAccelerators("CmdOrCtrl+B", "darwin")).toBeNull();
    expect(
      resolveReportedMenuAccelerators({ ...report, "browser.toggle": undefined }, "darwin"),
    ).toBeNull();
    expect(
      resolveReportedMenuAccelerators(
        { ...report, "sidebar.toggle": { ...report["sidebar.toggle"], modKey: "yes" } },
        "darwin",
      ),
    ).toBeNull();
    expect(
      resolveReportedMenuAccelerators(
        { ...report, "sidebar.toggle": shortcut("x".repeat(65), { modKey: true }) },
        "darwin",
      ),
    ).toBeNull();
  });

  it("detects an unchanged report so the menu is not rebuilt", () => {
    const resolved = resolveReportedMenuAccelerators(
      {
        "terminal.new": shortcut("t", { modKey: true }),
        "sidebar.toggle": shortcut("b", { modKey: true }),
        "browser.toggle": shortcut("b", { modKey: true, shiftKey: true }),
      },
      "darwin",
    );
    expect(resolved).not.toBeNull();
    expect(sameDesktopMenuAccelerators(resolved!, DEFAULT_DESKTOP_MENU_ACCELERATORS)).toBe(true);
    expect(
      sameDesktopMenuAccelerators(
        resolveReportedMenuAccelerators(report, "darwin")!,
        DEFAULT_DESKTOP_MENU_ACCELERATORS,
      ),
    ).toBe(false);
  });
});
