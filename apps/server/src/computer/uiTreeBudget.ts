import {
  COMPUTER_UI_NODE_MAX_CHILDREN,
  COMPUTER_UI_TREE_MAX_DEPTH,
  COMPUTER_UI_TREE_MAX_NODES,
  type ComputerUiNode,
} from "@synara/contracts";

/**
 * A tree cut down to the contract's shape budget, or the same tree when it
 * already fits.
 *
 * Backends bound their own accessibility walks, but the contract's ceiling is
 * what the state payload is encoded against, and a tree that overflows it
 * would fail the encode of a perception read that otherwise succeeded. Cut
 * breadth-first so what survives is the top of the desktop — the windows and
 * their first controls — rather than whichever deep leaves happened to come
 * first, and every node that lost children says so with `truncated`, the same
 * flag a backend sets when its own walk stopped short.
 */
export function clampComputerUiTree(root: ComputerUiNode): ComputerUiNode {
  if (withinBudget(root)) return root;
  let nodes = 1;
  const copy = (node: ComputerUiNode, depth: number): ComputerUiNode => {
    const budget = Math.min(
      COMPUTER_UI_NODE_MAX_CHILDREN,
      depth >= COMPUTER_UI_TREE_MAX_DEPTH ? 0 : COMPUTER_UI_TREE_MAX_NODES - nodes,
    );
    const kept = node.children.slice(0, Math.max(0, budget));
    nodes += kept.length;
    const children = kept.map((child) => copy(child, depth + 1));
    const truncated = node.truncated === true || kept.length < node.children.length;
    return { ...node, ...(truncated ? { truncated: true } : {}), children };
  };
  return copy(root, 1);
}

function withinBudget(root: ComputerUiNode): boolean {
  let nodes = 0;
  const stack: Array<{ readonly node: ComputerUiNode; readonly depth: number }> = [
    { node: root, depth: 1 },
  ];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    nodes += 1;
    if (
      nodes > COMPUTER_UI_TREE_MAX_NODES ||
      depth > COMPUTER_UI_TREE_MAX_DEPTH ||
      node.children.length > COMPUTER_UI_NODE_MAX_CHILDREN
    ) {
      return false;
    }
    for (const child of node.children) stack.push({ node: child, depth: depth + 1 });
  }
  return true;
}
