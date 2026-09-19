import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  COMPUTER_UI_NODE_MAX_CHILDREN,
  COMPUTER_UI_TREE_MAX_DEPTH,
  COMPUTER_UI_TREE_MAX_NODES,
  ComputerUiTree,
  type ComputerUiNode,
} from "@synara/contracts";

import { clampComputerUiTree } from "./uiTreeBudget.ts";

function node(children: readonly ComputerUiNode[] = [], label = "n"): ComputerUiNode {
  return {
    role: "group",
    label,
    value: null,
    description: null,
    frame: { x: 0, y: 0, width: 10, height: 10 },
    activationPoint: null,
    onScreen: true,
    windowId: null,
    children,
  };
}

function chain(depth: number): ComputerUiNode {
  let current = node();
  for (let index = 1; index < depth; index += 1) current = node([current]);
  return current;
}

function countNodes(root: ComputerUiNode): number {
  return 1 + root.children.reduce((sum, child) => sum + countNodes(child), 0);
}

function depthOf(root: ComputerUiNode): number {
  return 1 + Math.max(0, ...root.children.map(depthOf));
}

const encodes = Schema.decodeUnknownSync(ComputerUiTree as never);

describe("clampComputerUiTree", () => {
  it("returns a tree within budget untouched", () => {
    const root = node([node(), node([node()])]);
    expect(clampComputerUiTree(root)).toBe(root);
  });

  it("cuts a node wider than the child budget and says so", () => {
    const wide = node(Array.from({ length: COMPUTER_UI_NODE_MAX_CHILDREN + 5 }, () => node()));
    const clamped = clampComputerUiTree(node([wide]));
    expect(clamped.children[0]?.children).toHaveLength(COMPUTER_UI_NODE_MAX_CHILDREN);
    expect(clamped.children[0]?.truncated).toBe(true);
    expect(clamped.truncated).toBeUndefined();
    expect(() => encodes(clamped)).not.toThrow();
  });

  it("cuts below the depth budget, marking the deepest kept node", () => {
    const clamped = clampComputerUiTree(chain(COMPUTER_UI_TREE_MAX_DEPTH + 3));
    expect(depthOf(clamped)).toBe(COMPUTER_UI_TREE_MAX_DEPTH);
    let deepest = clamped;
    while (deepest.children.length > 0) deepest = deepest.children[0]!;
    expect(deepest.truncated).toBe(true);
    expect(() => encodes(clamped)).not.toThrow();
  });

  it("keeps the top of the tree when the whole exceeds the node budget", () => {
    // Three windows, each with more controls than a third of the budget: the
    // cut must keep every window and trim their controls, not drop a window.
    const perWindow = Math.ceil(COMPUTER_UI_TREE_MAX_NODES / 2);
    const root = node(
      Array.from({ length: 3 }, (_unused, index) =>
        node(
          Array.from({ length: perWindow }, () => node()),
          `window-${index}`,
        ),
      ),
    );
    const clamped = clampComputerUiTree(root);
    expect(countNodes(clamped)).toBeLessThanOrEqual(COMPUTER_UI_TREE_MAX_NODES);
    expect(clamped.children.map((child) => child.label)).toEqual([
      "window-0",
      "window-1",
      "window-2",
    ]);
    expect(clamped.children.some((child) => child.truncated === true)).toBe(true);
    expect(() => encodes(clamped)).not.toThrow();
  });
});
