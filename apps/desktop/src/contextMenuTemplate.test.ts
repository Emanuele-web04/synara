import { describe, expect, it, vi } from "vitest";

import { buildContextMenuTemplate, CONTEXT_MENU_MAX_DEPTH } from "./contextMenuTemplate";

function build(items: unknown) {
  const onSelect = vi.fn();
  const template = buildContextMenuTemplate(items, {
    decorateLabel: (label) => label,
    resolveIcon: () => undefined,
    onSelect,
  });
  return { template, onSelect };
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
});
