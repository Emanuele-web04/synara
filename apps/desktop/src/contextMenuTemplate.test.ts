import { describe, expect, it, vi } from "vitest";

import { buildContextMenuTemplate, CONTEXT_MENU_MAX_DEPTH } from "./contextMenuTemplate";

function build(items: unknown, platform: NodeJS.Platform = "darwin") {
  const onSelect = vi.fn();
  const template = buildContextMenuTemplate(items, {
    platform,
    decorateLabel: (label) => label,
    resolveIcon: () => undefined,
    onSelect,
  });
  return { template, onSelect };
}

/** A keybinding shortcut: `key` with only the named modifiers held. */
function shortcut(key: string, modifiers: Record<string, boolean> = {}) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: false,
    ...modifiers,
  };
}

describe("buildContextMenuTemplate", () => {
  it("turns children into a native submenu whose leaves resolve their own id", () => {
    const { template, onSelect } = build([
      { id: "rename", label: "Rename" },
      {
        id: "copy",
        label: "Copy",
        separatorBefore: true,
        children: [
          { id: "copy-path", label: "Path" },
          { id: "copy-thread-id", label: "Thread ID", separatorBefore: true },
        ],
      },
    ]);

    expect(template.map((entry) => entry.type ?? entry.label)).toEqual([
      "Rename",
      "separator",
      "Copy",
    ]);
    const parent = template[2]!;
    // The parent only opens the submenu; selecting it must not resolve the menu.
    expect(parent.click).toBeUndefined();
    const submenu = parent.submenu as Electron.MenuItemConstructorOptions[];
    expect(submenu.map((entry) => entry.type ?? entry.label)).toEqual([
      "Path",
      "separator",
      "Thread ID",
    ]);
    (submenu[2]!.click as () => void)();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("copy-thread-id");
  });

  it("drops malformed rows and parents left without usable children", () => {
    const { template } = build([
      { id: "ok", label: "Ok" },
      { id: 1, label: "Bad id" },
      null,
      { id: "empty", label: "Empty", children: [] },
      { id: "junk", label: "Junk", children: "nope" },
    ]);

    expect(template.map((entry) => entry.label)).toEqual(["Ok"]);
    expect(build("not-an-array").template).toEqual([]);
  });

  it("stops nesting at the depth limit", () => {
    let nested: Record<string, unknown> = { id: "leaf", label: "Leaf" };
    for (let depth = 0; depth < CONTEXT_MENU_MAX_DEPTH; depth++) {
      nested = { id: `level-${depth}`, label: "Level", children: [nested] };
    }

    expect(build([nested]).template).toEqual([]);
  });

  it("shows a row's shortcut as an accelerator it never registers", () => {
    const items = [
      { id: "duplicate", label: "Duplicate", shortcut: shortcut("d", { modKey: true }) },
      { id: "delete", label: "Delete", shortcut: shortcut("backspace") },
      {
        id: "paste",
        label: "Paste",
        // A parent row only opens its submenu: no accelerator of its own.
        shortcut: shortcut("v", { modKey: true }),
        children: [
          {
            id: "paste-on-top",
            label: "Paste on top",
            shortcut: shortcut("v", { modKey: true, shiftKey: true }),
          },
        ],
      },
      // Untrusted input: a malformed shortcut is left out, the row kept.
      { id: "rename", label: "Rename", shortcut: { key: 7 } },
      { id: "plain", label: "Plain" },
    ];

    for (const platform of ["darwin", "win32", "linux"] as const) {
      const { template } = build(items, platform);
      const row = (label: string) => template.find((entry) => entry.label === label)!;
      expect(row("Duplicate")).toMatchObject({
        accelerator: "CmdOrCtrl+D",
        registerAccelerator: false,
      });
      expect(row("Delete")).toMatchObject({
        accelerator: "Backspace",
        registerAccelerator: false,
      });
      expect(row("Paste").accelerator).toBeUndefined();
      expect((row("Paste").submenu as Electron.MenuItemConstructorOptions[])[0]).toMatchObject({
        accelerator: "CmdOrCtrl+Shift+V",
        registerAccelerator: false,
      });
      expect(row("Rename").accelerator).toBeUndefined();
      expect(row("Rename").click).toBeTypeOf("function");
      expect(row("Plain")).not.toHaveProperty("accelerator");
      expect(row("Plain")).not.toHaveProperty("registerAccelerator");
    }
  });
});
