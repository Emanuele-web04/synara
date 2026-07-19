import { describe, expect, it } from "vitest";

import {
  getFirstEnabledWorktreeWorkspaceActionId,
  getKeyboardContextMenuPoint,
  getWorktreeWorkspaceActionGroups,
  isContextMenuKeyboardEvent,
} from "./WorktreeWorkspaceContextMenu";

describe("getWorktreeWorkspaceActionGroups", () => {
  it("keeps the canonical group and action order while omitting unavailable actions", () => {
    expect(
      getWorktreeWorkspaceActionGroups({
        "archive-workspace": { label: "Archive workspace" },
        "open-branch-on-github": { label: "Open branch on GitHub" },
        "new-conversation": { label: "New conversation" },
        "start-dev": { label: "Start dev" },
        "copy-path": { label: "Copy path" },
        "rename-workspace": { label: "Rename workspace" },
        "copy-branch-name": { label: "Copy branch name" },
      }),
    ).toEqual([
      ["new-conversation", "copy-path"],
      ["start-dev"],
      ["rename-workspace"],
      ["copy-branch-name", "open-branch-on-github"],
      ["archive-workspace"],
    ]);
  });

  it("does not render empty groups", () => {
    expect(getWorktreeWorkspaceActionGroups({})).toEqual([]);
  });

  it("selects the first enabled action in canonical order", () => {
    expect(
      getFirstEnabledWorktreeWorkspaceActionId({
        "rename-workspace": { label: "Rename workspace" },
        "new-conversation": { label: "New conversation", disabled: true },
        "show-in-folder": { label: "Show in Finder" },
      }),
    ).toBe("show-in-folder");
    expect(
      getFirstEnabledWorktreeWorkspaceActionId({
        "new-conversation": { label: "New conversation", disabled: true },
      }),
    ).toBeUndefined();
  });
});

describe("worktree context-menu keyboard opening", () => {
  it("recognizes both platform context-menu shortcuts", () => {
    expect(isContextMenuKeyboardEvent({ key: "ContextMenu", shiftKey: false })).toBe(true);
    expect(isContextMenuKeyboardEvent({ key: "F10", shiftKey: true })).toBe(true);
    expect(isContextMenuKeyboardEvent({ key: "F10", shiftKey: false })).toBe(false);
  });

  it("anchors keyboard opening near the leading edge and bottom of the row", () => {
    expect(getKeyboardContextMenuPoint({ left: 120, top: 48, width: 260, height: 32 })).toEqual({
      x: 136,
      y: 80,
    });
    expect(getKeyboardContextMenuPoint({ left: 4, top: 8, width: 12, height: 20 })).toEqual({
      x: 10,
      y: 28,
    });
  });
});
