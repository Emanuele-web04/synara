import { describe, expect, it } from "vitest";

import {
  RIGHT_DOCK_PANE_KINDS,
  SINGLETON_PANE_KINDS,
  createDefaultRightDockState,
  isRightDockPaneKind,
  openPaneInState,
  sanitizeRightDockStateByThreadId,
  sanitizeRightDockThreadState,
  updatePaneInState,
} from "./rightDockStore.logic";

describe("RIGHT_DOCK_PANE_KINDS (single source of truth)", () => {
  it("lists every supported kind", () => {
    expect([...RIGHT_DOCK_PANE_KINDS]).toEqual([
      "browser",
      "diff",
      "explorer",
      "file",
      "terminal",
      "sidechat",
      "git",
    ]);
  });

  it("derives singletons as every kind except the multi-instance ones", () => {
    for (const kind of RIGHT_DOCK_PANE_KINDS) {
      expect(SINGLETON_PANE_KINDS.has(kind)).toBe(kind !== "sidechat" && kind !== "file");
    }
  });
});

describe("isRightDockPaneKind", () => {
  it("accepts the known pane kinds", () => {
    for (const kind of ["browser", "diff", "explorer", "file", "terminal", "sidechat", "git"]) {
      expect(isRightDockPaneKind(kind)).toBe(true);
    }
  });

  it("rejects unknown or malformed kinds", () => {
    expect(isRightDockPaneKind("plan")).toBe(false);
    expect(isRightDockPaneKind(undefined)).toBe(false);
    expect(isRightDockPaneKind(null)).toBe(false);
    expect(isRightDockPaneKind(42)).toBe(false);
  });
});

describe("sanitizeRightDockThreadState", () => {
  it("keeps recognized panes and a valid active tab", () => {
    const state = sanitizeRightDockThreadState({
      open: true,
      activePaneId: "b",
      panes: [
        { id: "a", kind: "diff", threadId: null, diffTurnId: null, diffFilePath: null },
        { id: "b", kind: "terminal", threadId: null, diffTurnId: null, diffFilePath: null },
      ],
    });
    expect(state.panes.map((pane) => pane.id)).toEqual(["a", "b"]);
    expect(state.activePaneId).toBe("b");
    expect(state.open).toBe(true);
  });

  it("drops panes with an unknown kind and repoints the active tab", () => {
    const state = sanitizeRightDockThreadState({
      open: true,
      activePaneId: "legacy",
      panes: [
        { id: "legacy", kind: "scrabble", threadId: null, diffTurnId: null, diffFilePath: null },
        { id: "keep", kind: "git", threadId: null, diffTurnId: null, diffFilePath: null },
      ],
    });
    expect(state.panes.map((pane) => pane.id)).toEqual(["keep"]);
    expect(state.activePaneId).toBe("keep");
    expect(state.open).toBe(true);
  });

  it("forces the dock closed when no valid panes survive", () => {
    const state = sanitizeRightDockThreadState({
      open: true,
      activePaneId: "legacy",
      panes: [
        { id: "legacy", kind: "scrabble", threadId: null, diffTurnId: null, diffFilePath: null },
      ],
    });
    expect(state.panes).toEqual([]);
    expect(state.activePaneId).toBeNull();
    expect(state.open).toBe(false);
  });

  it("returns the default state for malformed input", () => {
    expect(sanitizeRightDockThreadState(null)).toEqual({
      open: false,
      panes: [],
      activePaneId: null,
    });
    expect(sanitizeRightDockThreadState({ panes: "nope" })).toEqual({
      open: false,
      panes: [],
      activePaneId: null,
    });
  });
});

describe("file panes", () => {
  it("opens a file pane carrying the file path", () => {
    const state = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
      filePath: "src/page.tsx",
    });
    expect(state.open).toBe(true);
    expect(state.activePaneId).toBe("f1");
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.filePath).toBe("src/page.tsx");
  });

  it("opens another file in a new tab instead of swapping the existing pane", () => {
    const first = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
      filePath: "src/page.tsx",
    });
    const second = openPaneInState(first, {
      paneId: "f2",
      kind: "file",
      filePath: "README.md",
    });
    expect(second.panes).toHaveLength(2);
    expect(second.panes[0]?.filePath).toBe("src/page.tsx");
    expect(second.panes[1]?.filePath).toBe("README.md");
    expect(second.activePaneId).toBe("f2");
  });

  it("focuses the existing tab when the same file is opened again", () => {
    const first = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
      filePath: "src/page.tsx",
    });
    const second = openPaneInState(first, {
      paneId: "f2",
      kind: "file",
      filePath: "README.md",
    });
    const reopened = openPaneInState(second, {
      paneId: "f3",
      kind: "file",
      filePath: "src/page.tsx",
    });
    expect(reopened.panes).toHaveLength(2);
    expect(reopened.activePaneId).toBe("f1");
  });

  it("reuses an existing empty file pane on a bare open", () => {
    const first = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
    });
    const reopened = openPaneInState({ ...first, open: false }, { paneId: "f2", kind: "file" });
    expect(reopened.open).toBe(true);
    expect(reopened.panes).toHaveLength(1);
    expect(reopened.activePaneId).toBe("f1");
  });

  it("adds a new empty tab on a bare open when every file pane is occupied", () => {
    const first = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
      filePath: "src/page.tsx",
    });
    const second = openPaneInState(first, { paneId: "f2", kind: "file" });
    expect(second.panes).toHaveLength(2);
    expect(second.panes[1]?.filePath).toBeNull();
    expect(second.activePaneId).toBe("f2");
  });

  it("updates the file path through updatePaneInState", () => {
    const state = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
      filePath: "src/page.tsx",
    });
    const updated = updatePaneInState(state, "f1", { filePath: "src/other.tsx" });
    expect(updated.panes[0]?.filePath).toBe("src/other.tsx");
    expect(updatePaneInState(updated, "f1", { filePath: "src/other.tsx" })).toBe(updated);
  });

  it("sanitizes persisted file panes, preserving the file path", () => {
    const state = sanitizeRightDockThreadState({
      open: true,
      activePaneId: "f1",
      panes: [
        {
          id: "f1",
          kind: "file",
          threadId: null,
          diffTurnId: null,
          diffFilePath: null,
          filePath: "src/page.tsx",
        },
      ],
    });
    expect(state.panes[0]?.kind).toBe("file");
    expect(state.panes[0]?.filePath).toBe("src/page.tsx");
  });
});

describe("sanitizeRightDockStateByThreadId", () => {
  it("sanitizes every thread entry and skips undefined values", () => {
    const result = sanitizeRightDockStateByThreadId({
      t1: {
        open: true,
        activePaneId: "x",
        panes: [{ id: "x", kind: "browser", threadId: null, diffTurnId: null, diffFilePath: null }],
      },
      t2: undefined,
    });
    expect(Object.keys(result)).toEqual(["t1"]);
    expect(result.t1?.panes).toHaveLength(1);
  });

  it("returns an empty map for non-object input", () => {
    expect(sanitizeRightDockStateByThreadId(null)).toEqual({});
    expect(sanitizeRightDockStateByThreadId("oops")).toEqual({});
  });
});
