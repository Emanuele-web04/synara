import { describe, expect, it } from "vitest";

import { RIGHT_DOCK_PANE_KINDS } from "~/rightDockStore.logic";
import { RIGHT_DOCK_ADD_MENU_KINDS, getRightDockPaneMeta } from "./rightDockPaneMeta";

describe("RIGHT_DOCK_ADD_MENU_KINDS", () => {
  it("offers the explorer pane but not the chat-driven file pane", () => {
    // The "+" menu surfaces the file-tree explorer; single-file preview tabs are
    // opened by clicking a file reference in chat, not from the add menu.
    expect(RIGHT_DOCK_ADD_MENU_KINDS).toContain("explorer");
    expect(RIGHT_DOCK_ADD_MENU_KINDS).not.toContain("file");
  });

  it("keeps the canonical kind order minus the file pane", () => {
    expect([...RIGHT_DOCK_ADD_MENU_KINDS]).toEqual(
      RIGHT_DOCK_PANE_KINDS.filter((kind) => kind !== "file"),
    );
  });

  it("labels the explorer pane", () => {
    expect(getRightDockPaneMeta("explorer").label).toBe("Explorer");
  });
});
