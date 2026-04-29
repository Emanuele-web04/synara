// FILE: splitView.logic.ts
// Purpose: Pure helpers for the split-view pane tree (find/replace/collapse leaves, depth caps, panel resets).
// Layer: UI state helpers
// Exports: tree traversal/mutation utilities and migration helpers consumed by the store and route surfaces

import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type {
  LeafPane,
  Pane,
  PaneId,
  SplitDirection,
  SplitNode,
  SplitViewPanePanelState,
} from "./splitViewStore";

export function clearSplitViewPanePanelState(
  panelState: SplitViewPanePanelState,
): SplitViewPanePanelState {
  return {
    ...panelState,
    panel: null,
    diffTurnId: null,
    diffFilePath: null,
  };
}

// --- pane lookup ---

export function findPaneById(root: Pane, paneId: PaneId): Pane | null {
  if (root.id === paneId) {
    return root;
  }
  if (root.kind === "leaf") {
    return null;
  }
  return findPaneById(root.first, paneId) ?? findPaneById(root.second, paneId);
}

export function findLeafPaneById(root: Pane, paneId: PaneId): LeafPane | null {
  const found = findPaneById(root, paneId);
  return found?.kind === "leaf" ? found : null;
}

export function findSplitNodeById(root: Pane, paneId: PaneId): SplitNode | null {
  const found = findPaneById(root, paneId);
  return found?.kind === "split" ? found : null;
}

// Returns the SplitNode that directly contains the pane with paneId, or null if paneId is the root.
export function findParentSplitNode(root: Pane, paneId: PaneId): SplitNode | null {
  if (root.kind === "leaf") {
    return null;
  }
  if (root.first.id === paneId || root.second.id === paneId) {
    return root;
  }
  return findParentSplitNode(root.first, paneId) ?? findParentSplitNode(root.second, paneId);
}

export function findPaneDepth(root: Pane, paneId: PaneId): number | null {
  if (root.id === paneId) {
    return 0;
  }
  if (root.kind === "leaf") {
    return null;
  }
  const firstDepth = findPaneDepth(root.first, paneId);
  if (firstDepth !== null) {
    return firstDepth + 1;
  }
  const secondDepth = findPaneDepth(root.second, paneId);
  return secondDepth === null ? null : secondDepth + 1;
}

export function collectLeaves(root: Pane): LeafPane[] {
  if (root.kind === "leaf") {
    return [root];
  }
  return [...collectLeaves(root.first), ...collectLeaves(root.second)];
}

// --- pane mutation (immutable) ---

// Returns a new tree where the pane with paneId is replaced. Preserves identity when nothing changes.
export function replacePaneInTree(root: Pane, paneId: PaneId, replacement: Pane): Pane {
  if (root.id === paneId) {
    return replacement;
  }
  if (root.kind === "leaf") {
    return root;
  }
  const first = replacePaneInTree(root.first, paneId, replacement);
  const second = replacePaneInTree(root.second, paneId, replacement);
  if (first === root.first && second === root.second) {
    return root;
  }
  return { ...root, first, second };
}

export interface RemoveLeafResult {
  nextRoot: Pane | null;
  removedLeafIds: PaneId[];
}

// Walks the tree, removing every leaf whose threadId matches. SplitNodes whose subtree
// loses every leaf collapse to null; nodes with one surviving subtree collapse to that subtree.
export function removeLeafByThreadId(root: Pane, threadId: ThreadId): RemoveLeafResult {
  if (root.kind === "leaf") {
    if (root.threadId === threadId) {
      return { nextRoot: null, removedLeafIds: [root.id] };
    }
    return { nextRoot: root, removedLeafIds: [] };
  }

  const firstResult = removeLeafByThreadId(root.first, threadId);
  const secondResult = removeLeafByThreadId(root.second, threadId);
  const removedLeafIds = [...firstResult.removedLeafIds, ...secondResult.removedLeafIds];

  if (removedLeafIds.length === 0) {
    return { nextRoot: root, removedLeafIds };
  }

  if (firstResult.nextRoot && secondResult.nextRoot) {
    return {
      nextRoot: { ...root, first: firstResult.nextRoot, second: secondResult.nextRoot },
      removedLeafIds,
    };
  }
  if (firstResult.nextRoot) {
    return { nextRoot: firstResult.nextRoot, removedLeafIds };
  }
  if (secondResult.nextRoot) {
    return { nextRoot: secondResult.nextRoot, removedLeafIds };
  }
  return { nextRoot: null, removedLeafIds };
}

// Removes exactly one leaf by pane id. SplitNodes whose subtree loses every leaf collapse to null;
// nodes with one surviving subtree collapse to that subtree so the remaining panes resize naturally.
export function removeLeafByPaneId(root: Pane, paneId: PaneId): RemoveLeafResult {
  if (root.kind === "leaf") {
    if (root.id === paneId) {
      return { nextRoot: null, removedLeafIds: [root.id] };
    }
    return { nextRoot: root, removedLeafIds: [] };
  }

  const firstResult = removeLeafByPaneId(root.first, paneId);
  const secondResult = removeLeafByPaneId(root.second, paneId);
  const removedLeafIds = [...firstResult.removedLeafIds, ...secondResult.removedLeafIds];

  if (removedLeafIds.length === 0) {
    return { nextRoot: root, removedLeafIds };
  }

  if (firstResult.nextRoot && secondResult.nextRoot) {
    return {
      nextRoot: { ...root, first: firstResult.nextRoot, second: secondResult.nextRoot },
      removedLeafIds,
    };
  }
  if (firstResult.nextRoot) {
    return { nextRoot: firstResult.nextRoot, removedLeafIds };
  }
  if (secondResult.nextRoot) {
    return { nextRoot: secondResult.nextRoot, removedLeafIds };
  }
  return { nextRoot: null, removedLeafIds };
}

// --- structural rules ---

// Returns true if a target leaf can be subdivided in the requested direction without exceeding
// the depth-cap of 2 (root SplitNode + at most one perpendicular SplitNode under each side).
// When parentDirection is null (root-level leaf), any direction is allowed.
export function canSubdivide(
  parentDirection: SplitDirection | null,
  requestedDirection: SplitDirection,
): boolean {
  if (parentDirection === null) {
    return true;
  }
  return parentDirection !== requestedDirection;
}

export function canSubdividePane(
  root: Pane,
  targetPaneId: PaneId,
  requestedDirection: SplitDirection,
): boolean {
  if (!findLeafPaneById(root, targetPaneId)) {
    return false;
  }
  const targetDepth = findPaneDepth(root, targetPaneId);
  if (targetDepth === null || targetDepth >= 2) {
    return false;
  }
  const parent = findParentSplitNode(root, targetPaneId);
  return canSubdivide(parent?.direction ?? null, requestedDirection);
}

// Returns the first leaf id encountered in DFS order; falls back to root id when there are no leaves.
export function resolveDefaultFocusLeafId(root: Pane): PaneId {
  const leaves = collectLeaves(root);
  return leaves[0]?.id ?? root.id;
}

// --- legacy split-view migration ---

export interface LegacySplitViewLike {
  id: string;
  sourceThreadId: ThreadId;
  ownerProjectId: ProjectId;
  leftThreadId: ThreadId | null;
  rightThreadId: ThreadId | null;
  focusedPane: "left" | "right";
  ratio: number;
  leftPanel: SplitViewPanePanelState;
  rightPanel: SplitViewPanePanelState;
  createdAt: string;
  updatedAt: string;
}

export function isLegacySplitViewLike(value: unknown): value is LegacySplitViewLike {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.sourceThreadId === "string" &&
    "leftThreadId" in candidate &&
    "rightThreadId" in candidate &&
    typeof candidate.focusedPane === "string"
  );
}
