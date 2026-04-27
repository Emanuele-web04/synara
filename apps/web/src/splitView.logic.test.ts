// FILE: splitView.logic.test.ts
// Purpose: Verify pure pane-tree helpers used by the store and chat surfaces.
// Layer: UI state helpers test
// Targets: tree traversal, immutable replace, leaf removal/collapse, depth-cap rule, legacy migration.

import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  canSubdivide,
  canSubdividePane,
  collectLeaves,
  findLeafPaneById,
  findPaneById,
  findPaneDepth,
  findParentSplitNode,
  findSplitNodeById,
  isLegacySplitViewLike,
  removeLeafByThreadId,
  replacePaneInTree,
  resolveDefaultFocusLeafId,
} from "./splitView.logic";
import type { LeafPane, Pane, SplitNode, SplitViewPanePanelState } from "./splitViewStore";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const THREAD_C = ThreadId.makeUnsafe("thread-c");
const THREAD_D = ThreadId.makeUnsafe("thread-d");
const PROJECT_ID = ProjectId.makeUnsafe("project-1");

function makePanel(): SplitViewPanePanelState {
  return {
    panel: null,
    diffTurnId: null,
    diffFilePath: null,
    hasOpenedPanel: false,
    lastOpenPanel: "browser",
  };
}

function makeLeaf(id: string, threadId: ThreadId | null): LeafPane {
  return { kind: "leaf", id, threadId, panel: makePanel() };
}

function makeSplit(input: {
  id: string;
  direction: "horizontal" | "vertical";
  first: Pane;
  second: Pane;
  ratio?: number;
}): SplitNode {
  return {
    kind: "split",
    id: input.id,
    direction: input.direction,
    first: input.first,
    second: input.second,
    ratio: input.ratio ?? 0.5,
  };
}

describe("findPaneById / findLeafPaneById / findSplitNodeById", () => {
  it("walks the tree and returns the matching node by id", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const root = makeSplit({ id: "root", direction: "horizontal", first: leafA, second: leafB });

    expect(findPaneById(root, "leaf-a")).toBe(leafA);
    expect(findLeafPaneById(root, "leaf-b")).toBe(leafB);
    expect(findSplitNodeById(root, "root")).toBe(root);
    expect(findLeafPaneById(root, "root")).toBeNull();
    expect(findSplitNodeById(root, "leaf-a")).toBeNull();
    expect(findPaneById(root, "missing")).toBeNull();
  });
});

describe("findParentSplitNode", () => {
  it("returns the SplitNode that directly contains a leaf", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const innerSplit = makeSplit({
      id: "inner",
      direction: "vertical",
      first: leafA,
      second: leafB,
    });
    const leafC = makeLeaf("leaf-c", THREAD_C);
    const root = makeSplit({
      id: "root",
      direction: "horizontal",
      first: innerSplit,
      second: leafC,
    });

    expect(findParentSplitNode(root, "leaf-a")).toBe(innerSplit);
    expect(findParentSplitNode(root, "leaf-c")).toBe(root);
    expect(findParentSplitNode(root, "root")).toBeNull();
  });
});

describe("findPaneDepth", () => {
  it("returns the depth of panes in the tree", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const innerSplit = makeSplit({
      id: "inner",
      direction: "vertical",
      first: leafA,
      second: leafB,
    });
    const leafC = makeLeaf("leaf-c", THREAD_C);
    const root = makeSplit({
      id: "root",
      direction: "horizontal",
      first: innerSplit,
      second: leafC,
    });

    expect(findPaneDepth(root, "root")).toBe(0);
    expect(findPaneDepth(root, "inner")).toBe(1);
    expect(findPaneDepth(root, "leaf-a")).toBe(2);
    expect(findPaneDepth(root, "leaf-c")).toBe(1);
    expect(findPaneDepth(root, "missing")).toBeNull();
  });
});

describe("collectLeaves", () => {
  it("returns leaves in left-to-right (depth-first) order", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const inner = makeSplit({
      id: "inner",
      direction: "vertical",
      first: leafA,
      second: leafB,
    });
    const leafC = makeLeaf("leaf-c", THREAD_C);
    const root = makeSplit({ id: "root", direction: "horizontal", first: inner, second: leafC });

    expect(collectLeaves(root).map((leaf) => leaf.id)).toEqual(["leaf-a", "leaf-b", "leaf-c"]);
  });
});

describe("replacePaneInTree", () => {
  it("returns a new tree where the specified pane is replaced", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const root = makeSplit({ id: "root", direction: "horizontal", first: leafA, second: leafB });

    const replacement: LeafPane = makeLeaf("leaf-a", THREAD_C);
    const updated = replacePaneInTree(root, "leaf-a", replacement);

    expect(updated).not.toBe(root);
    expect((updated as SplitNode).first).toBe(replacement);
    expect((updated as SplitNode).second).toBe(leafB);
  });

  it("returns the same root when the pane is not found", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const root = makeSplit({ id: "root", direction: "horizontal", first: leafA, second: leafB });
    expect(replacePaneInTree(root, "missing", makeLeaf("missing", THREAD_C))).toBe(root);
  });
});

describe("removeLeafByThreadId", () => {
  it("collapses a SplitNode to its surviving subtree when one side is removed", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const root = makeSplit({ id: "root", direction: "horizontal", first: leafA, second: leafB });

    const result = removeLeafByThreadId(root, THREAD_A);
    expect(result.removedLeafIds).toEqual(["leaf-a"]);
    expect(result.nextRoot).toBe(leafB);
  });

  it("returns null when the only remaining leaf is removed", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const result = removeLeafByThreadId(leafA, THREAD_A);
    expect(result.removedLeafIds).toEqual(["leaf-a"]);
    expect(result.nextRoot).toBeNull();
  });

  it("removes leaves nested inside a perpendicular subtree", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const inner = makeSplit({
      id: "inner",
      direction: "vertical",
      first: leafA,
      second: leafB,
    });
    const leafC = makeLeaf("leaf-c", THREAD_C);
    const root = makeSplit({ id: "root", direction: "horizontal", first: inner, second: leafC });

    const result = removeLeafByThreadId(root, THREAD_B);
    expect(result.removedLeafIds).toEqual(["leaf-b"]);
    expect(result.nextRoot).not.toBe(root);
    if (result.nextRoot && result.nextRoot.kind === "split") {
      expect(result.nextRoot.first).toBe(leafA);
      expect(result.nextRoot.second).toBe(leafC);
    }
  });

  it("preserves identity when the threadId is not present", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const root = makeSplit({ id: "root", direction: "horizontal", first: leafA, second: leafB });
    expect(removeLeafByThreadId(root, THREAD_C).nextRoot).toBe(root);
  });
});

describe("canSubdivide", () => {
  it("allows any direction when there is no parent split", () => {
    expect(canSubdivide(null, "horizontal")).toBe(true);
    expect(canSubdivide(null, "vertical")).toBe(true);
  });

  it("only allows perpendicular subdivisions", () => {
    expect(canSubdivide("horizontal", "vertical")).toBe(true);
    expect(canSubdivide("vertical", "horizontal")).toBe(true);
    expect(canSubdivide("horizontal", "horizontal")).toBe(false);
    expect(canSubdivide("vertical", "vertical")).toBe(false);
  });
});

describe("canSubdividePane", () => {
  it("allows root children to split perpendicularly but blocks leaves already at 2x2 depth", () => {
    const topLeft = makeLeaf("top-left", THREAD_A);
    const bottomLeft = makeLeaf("bottom-left", THREAD_B);
    const leftSplit = makeSplit({
      id: "left-split",
      direction: "vertical",
      first: topLeft,
      second: bottomLeft,
    });
    const rightLeaf = makeLeaf("right", THREAD_C);
    const root = makeSplit({
      id: "root",
      direction: "horizontal",
      first: leftSplit,
      second: rightLeaf,
    });

    expect(canSubdividePane(root, "right", "vertical")).toBe(true);
    expect(canSubdividePane(root, "right", "horizontal")).toBe(false);
    expect(canSubdividePane(root, "top-left", "horizontal")).toBe(false);
    expect(canSubdividePane(root, "missing", "vertical")).toBe(false);
  });

  it("allows a root leaf to split in either direction", () => {
    const root = makeLeaf("root-leaf", THREAD_D);
    expect(canSubdividePane(root, "root-leaf", "horizontal")).toBe(true);
    expect(canSubdividePane(root, "root-leaf", "vertical")).toBe(true);
  });
});

describe("resolveDefaultFocusLeafId", () => {
  it("returns the first leaf id in DFS order", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const root = makeSplit({ id: "root", direction: "horizontal", first: leafA, second: leafB });
    expect(resolveDefaultFocusLeafId(root)).toBe("leaf-a");
  });
});

describe("isLegacySplitViewLike", () => {
  it("matches the v1 persisted shape", () => {
    const legacy = {
      id: "split-1",
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      leftThreadId: THREAD_A,
      rightThreadId: THREAD_B,
      focusedPane: "left",
      ratio: 0.5,
      leftPanel: makePanel(),
      rightPanel: makePanel(),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(isLegacySplitViewLike(legacy)).toBe(true);
    expect(isLegacySplitViewLike(null)).toBe(false);
    expect(isLegacySplitViewLike({})).toBe(false);
  });
});
