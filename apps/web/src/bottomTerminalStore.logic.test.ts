import { describe, expect, it } from "vitest";

import {
  DEFAULT_BOTTOM_TERMINAL_HEIGHT_PX,
  MAX_BOTTOM_TERMINAL_HEIGHT_PX,
  MIN_BOTTOM_TERMINAL_HEIGHT_PX,
  clampBottomTerminalHeight,
  closeTerminalTileInState,
  collectTerminalTileLeaves,
  createBottomTerminalTab,
  createDefaultBottomTerminalState,
  cycleBottomTerminalTabInState,
  findDirectionalTerminalTile,
  layoutTerminalTiles,
  resizeTerminalTileInTree,
  sanitizeBottomTerminalThreadState,
  setTerminalSplitRatioInTree,
  splitTerminalTileInTree,
} from "./bottomTerminalStore.logic";

describe("bottomTerminalStore.logic", () => {
  it("clamps drawer height within compact bounds", () => {
    expect(clampBottomTerminalHeight(40)).toBe(MIN_BOTTOM_TERMINAL_HEIGHT_PX);
    expect(clampBottomTerminalHeight(9999)).toBe(MAX_BOTTOM_TERMINAL_HEIGHT_PX);
    expect(clampBottomTerminalHeight(Number.NaN)).toBe(DEFAULT_BOTTOM_TERMINAL_HEIGHT_PX);
    expect(clampBottomTerminalHeight(245.4)).toBe(245);
  });

  it("splits tiles horizontally and vertically and computes flat layout rects", () => {
    const initial = createBottomTerminalTab({
      tabId: "tab-1",
      paneId: "pane-a",
      terminalId: "term-a",
    }).root;

    const splitRight = splitTerminalTileInTree({
      root: initial,
      targetPaneId: "pane-a",
      direction: "horizontal",
      splitNodeId: "split-1",
      newPaneId: "pane-b",
      newTerminalId: "term-b",
    });
    expect(splitRight).not.toBeNull();

    const splitDown = splitTerminalTileInTree({
      root: splitRight!,
      targetPaneId: "pane-b",
      direction: "vertical",
      splitNodeId: "split-2",
      newPaneId: "pane-c",
      newTerminalId: "term-c",
    });
    expect(splitDown).not.toBeNull();

    const layout = layoutTerminalTiles(splitDown!);
    expect(layout.leaves.map((entry) => entry.leaf.id)).toEqual(["pane-a", "pane-b", "pane-c"]);
    expect(layout.leaves[0]?.rect).toEqual({ left: 0, top: 0, width: 0.5, height: 1 });
    expect(layout.leaves[1]?.rect).toEqual({ left: 0.5, top: 0, width: 0.5, height: 0.5 });
    expect(layout.leaves[2]?.rect).toEqual({ left: 0.5, top: 0.5, width: 0.5, height: 0.5 });
  });

  it("navigates directionally across nested horizontal and vertical tiles", () => {
    let root = createBottomTerminalTab({
      tabId: "tab-1",
      paneId: "pane-left",
      terminalId: "term-1",
    }).root;
    root = splitTerminalTileInTree({
      root,
      targetPaneId: "pane-left",
      direction: "horizontal",
      splitNodeId: "split-h",
      newPaneId: "pane-top-right",
      newTerminalId: "term-2",
    })!;
    root = splitTerminalTileInTree({
      root,
      targetPaneId: "pane-top-right",
      direction: "vertical",
      splitNodeId: "split-v",
      newPaneId: "pane-bottom-right",
      newTerminalId: "term-3",
    })!;

    expect(findDirectionalTerminalTile(root, "pane-left", "right")).toBe("pane-top-right");
    expect(findDirectionalTerminalTile(root, "pane-top-right", "down")).toBe("pane-bottom-right");
    expect(findDirectionalTerminalTile(root, "pane-bottom-right", "up")).toBe("pane-top-right");
    expect(findDirectionalTerminalTile(root, "pane-bottom-right", "left")).toBe("pane-left");
    expect(findDirectionalTerminalTile(root, "pane-left", "left")).toBeNull();
  });

  it("resizes the nearest matching axis split and clamps ratios", () => {
    let root = createBottomTerminalTab({
      tabId: "tab-1",
      paneId: "pane-1",
      terminalId: "term-1",
    }).root;
    root = splitTerminalTileInTree({
      root,
      targetPaneId: "pane-1",
      direction: "horizontal",
      splitNodeId: "split-h",
      newPaneId: "pane-2",
      newTerminalId: "term-2",
    })!;

    const widened = resizeTerminalTileInTree(root, "pane-1", "right", 0.1);
    expect(widened.kind === "split" ? widened.ratio : 0).toBeCloseTo(0.6);

    const clamped = setTerminalSplitRatioInTree(widened, "split-h", 0.99);
    expect(clamped.kind === "split" ? clamped.ratio : 0).toBeCloseTo(0.82);

    // Perpendicular resize on a horizontal-only tree is a no-op.
    expect(resizeTerminalTileInTree(widened, "pane-1", "down")).toBe(widened);
  });

  it("collapses parent split when closing a tile and closes the drawer when the final tab closes", () => {
    let root = createBottomTerminalTab({
      tabId: "tab-1",
      paneId: "pane-1",
      terminalId: "term-1",
    }).root;
    root = splitTerminalTileInTree({
      root,
      targetPaneId: "pane-1",
      direction: "horizontal",
      splitNodeId: "split-h",
      newPaneId: "pane-2",
      newTerminalId: "term-2",
    })!;

    const state = {
      ...createDefaultBottomTerminalState(),
      open: true,
      tabs: [{ id: "tab-1", root, focusedPaneId: "pane-2", zoomedPaneId: "pane-2" }],
      activeTabId: "tab-1",
    };

    const afterFirstClose = closeTerminalTileInState(state, "tab-1", "pane-2");
    expect(afterFirstClose.removedTerminalId).toBe("term-2");
    expect(afterFirstClose.nextState.open).toBe(true);
    expect(collectTerminalTileLeaves(afterFirstClose.nextState.tabs[0]!.root)).toHaveLength(1);
    expect(afterFirstClose.nextState.tabs[0]?.focusedPaneId).toBe("pane-1");
    expect(afterFirstClose.nextState.tabs[0]?.zoomedPaneId).toBeNull();

    const afterFinalClose = closeTerminalTileInState(afterFirstClose.nextState, "tab-1", "pane-1");
    expect(afterFinalClose.removedTerminalId).toBe("term-1");
    expect(afterFinalClose.nextState.open).toBe(false);
    expect(afterFinalClose.nextState.tabs).toHaveLength(0);
    expect(afterFinalClose.nextState.activeTabId).toBeNull();
  });

  it("cycles through multiple tabs wrapping in both directions", () => {
    const state = {
      ...createDefaultBottomTerminalState(),
      open: true,
      tabs: [
        createBottomTerminalTab({ tabId: "tab-1", paneId: "p1", terminalId: "term-1" }),
        createBottomTerminalTab({ tabId: "tab-2", paneId: "p2", terminalId: "term-2" }),
        createBottomTerminalTab({ tabId: "tab-3", paneId: "p3", terminalId: "term-3" }),
      ],
      activeTabId: "tab-1",
    };

    const next = cycleBottomTerminalTabInState(state, 1);
    expect(next.activeTabId).toBe("tab-2");
    const wrappedBack = cycleBottomTerminalTabInState(state, -1);
    expect(wrappedBack.activeTabId).toBe("tab-3");
  });

  it("enforces max leaves per tab and sanitizes malformed persisted state", () => {
    let root = createBottomTerminalTab({
      tabId: "tab-1",
      paneId: "p1",
      terminalId: "term-1",
    }).root;
    for (let i = 2; i <= 6; i += 1) {
      root = splitTerminalTileInTree({
        root,
        targetPaneId: `p${i - 1}`,
        direction: "horizontal",
        splitNodeId: `s${i}`,
        newPaneId: `p${i}`,
        newTerminalId: `term-${i}`,
      })!;
    }
    expect(
      splitTerminalTileInTree({
        root,
        targetPaneId: "p6",
        direction: "horizontal",
        splitNodeId: "s7",
        newPaneId: "p7",
        newTerminalId: "term-7",
      }),
    ).toBeNull();

    const sanitized = sanitizeBottomTerminalThreadState({
      open: true,
      heightPx: 9999,
      tabs: [{ id: "bad", root: { kind: "unknown" } }],
      activeTabId: "bad",
    });
    expect(sanitized.open).toBe(false);
    expect(sanitized.tabs).toEqual([]);
    expect(sanitized.heightPx).toBe(MAX_BOTTOM_TERMINAL_HEIGHT_PX);
  });
});
