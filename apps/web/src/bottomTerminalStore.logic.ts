// FILE: bottomTerminalStore.logic.ts
// Purpose: Pure, testable state and binary-tree tiling helpers for the compact bottom terminal.
// Layer: UI state helpers
// Exports: tile tree types, flat rect layout, directional focus/resize, split/remove, and sanitization.

import { resolveTabAfterClose } from "./lib/tabStrip";
import { isPlainObject, sanitizeStringKeyedRecord } from "./persistedRecord";

export type TerminalTileDirection = "horizontal" | "vertical";
export type TerminalTileNavigationDirection = "left" | "right" | "up" | "down";

export interface TerminalTileLeaf {
  kind: "leaf";
  id: string;
  terminalId: string;
}

export interface TerminalTileSplit {
  kind: "split";
  id: string;
  direction: TerminalTileDirection;
  ratio: number;
  first: TerminalTileNode;
  second: TerminalTileNode;
}

export type TerminalTileNode = TerminalTileLeaf | TerminalTileSplit;

export interface BottomTerminalTab {
  id: string;
  root: TerminalTileNode;
  focusedPaneId: string;
  zoomedPaneId: string | null;
}

export interface BottomTerminalThreadState {
  open: boolean;
  maximized: boolean;
  heightPx: number;
  tabs: BottomTerminalTab[];
  activeTabId: string | null;
}

export interface TerminalTileRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TerminalTileLayout {
  leaves: Array<{ leaf: TerminalTileLeaf; rect: TerminalTileRect }>;
  splits: Array<{ node: TerminalTileSplit; rect: TerminalTileRect }>;
}

export const DEFAULT_BOTTOM_TERMINAL_HEIGHT_PX = 220;
export const MIN_BOTTOM_TERMINAL_HEIGHT_PX = 128;
export const MAX_BOTTOM_TERMINAL_HEIGHT_PX = 640;
export const MAX_TILES_PER_BOTTOM_TERMINAL_TAB = 6;
export const TERMINAL_TILE_RATIO_MIN = 0.18;
export const TERMINAL_TILE_RATIO_MAX = 0.82;
export const DEFAULT_TERMINAL_TILE_RESIZE_STEP = 0.06;

export function clampBottomTerminalHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BOTTOM_TERMINAL_HEIGHT_PX;
  return Math.round(
    Math.min(MAX_BOTTOM_TERMINAL_HEIGHT_PX, Math.max(MIN_BOTTOM_TERMINAL_HEIGHT_PX, value)),
  );
}

export function clampTerminalTileRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(TERMINAL_TILE_RATIO_MAX, Math.max(TERMINAL_TILE_RATIO_MIN, value));
}

export function createDefaultBottomTerminalState(): BottomTerminalThreadState {
  return {
    open: false,
    maximized: false,
    heightPx: DEFAULT_BOTTOM_TERMINAL_HEIGHT_PX,
    tabs: [],
    activeTabId: null,
  };
}

export function createTerminalTileLeaf(id: string, terminalId: string): TerminalTileLeaf {
  return { kind: "leaf", id, terminalId };
}

export function createBottomTerminalTab(input: {
  tabId: string;
  paneId: string;
  terminalId: string;
}): BottomTerminalTab {
  return {
    id: input.tabId,
    root: createTerminalTileLeaf(input.paneId, input.terminalId),
    focusedPaneId: input.paneId,
    zoomedPaneId: null,
  };
}

export function collectTerminalTileLeaves(root: TerminalTileNode): TerminalTileLeaf[] {
  if (root.kind === "leaf") {
    return [root];
  }
  return [...collectTerminalTileLeaves(root.first), ...collectTerminalTileLeaves(root.second)];
}

export function findTerminalTileById(
  root: TerminalTileNode,
  nodeId: string,
): TerminalTileNode | null {
  if (root.id === nodeId) return root;
  if (root.kind === "leaf") return null;
  return findTerminalTileById(root.first, nodeId) ?? findTerminalTileById(root.second, nodeId);
}

export function findTerminalTileLeafById(
  root: TerminalTileNode,
  paneId: string,
): TerminalTileLeaf | null {
  const found = findTerminalTileById(root, paneId);
  return found?.kind === "leaf" ? found : null;
}

export function findTerminalTileLeafByTerminalId(
  root: TerminalTileNode,
  terminalId: string,
): TerminalTileLeaf | null {
  if (root.kind === "leaf") {
    return root.terminalId === terminalId ? root : null;
  }
  return (
    findTerminalTileLeafByTerminalId(root.first, terminalId) ??
    findTerminalTileLeafByTerminalId(root.second, terminalId)
  );
}

export function layoutTerminalTiles(root: TerminalTileNode): TerminalTileLayout {
  const layout: TerminalTileLayout = { leaves: [], splits: [] };
  const visit = (node: TerminalTileNode, rect: TerminalTileRect) => {
    if (node.kind === "leaf") {
      layout.leaves.push({ leaf: node, rect });
      return;
    }
    layout.splits.push({ node, rect });
    if (node.direction === "horizontal") {
      const firstWidth = rect.width * node.ratio;
      visit(node.first, { ...rect, width: firstWidth });
      visit(node.second, {
        ...rect,
        left: rect.left + firstWidth,
        width: rect.width - firstWidth,
      });
      return;
    }
    const firstHeight = rect.height * node.ratio;
    visit(node.first, { ...rect, height: firstHeight });
    visit(node.second, {
      ...rect,
      top: rect.top + firstHeight,
      height: rect.height - firstHeight,
    });
  };
  visit(root, { left: 0, top: 0, width: 1, height: 1 });
  return layout;
}

export function replaceTerminalTileNode(
  root: TerminalTileNode,
  targetId: string,
  replacement: TerminalTileNode,
): TerminalTileNode {
  if (root.id === targetId) return replacement;
  if (root.kind === "leaf") return root;
  const first = replaceTerminalTileNode(root.first, targetId, replacement);
  const second = replaceTerminalTileNode(root.second, targetId, replacement);
  if (first === root.first && second === root.second) return root;
  return { ...root, first, second };
}

export function splitTerminalTileInTree(input: {
  root: TerminalTileNode;
  targetPaneId: string;
  direction: TerminalTileDirection;
  splitNodeId: string;
  newPaneId: string;
  newTerminalId: string;
  maxLeaves?: number;
}): TerminalTileNode | null {
  const maxLeaves = input.maxLeaves ?? MAX_TILES_PER_BOTTOM_TERMINAL_TAB;
  const leaves = collectTerminalTileLeaves(input.root);
  if (leaves.length >= maxLeaves) {
    return null;
  }
  const target = findTerminalTileLeafById(input.root, input.targetPaneId);
  if (!target) {
    return null;
  }
  const splitNode: TerminalTileSplit = {
    kind: "split",
    id: input.splitNodeId,
    direction: input.direction,
    ratio: 0.5,
    first: target,
    second: createTerminalTileLeaf(input.newPaneId, input.newTerminalId),
  };
  return replaceTerminalTileNode(input.root, target.id, splitNode);
}

export function removeTerminalTileFromTree(
  root: TerminalTileNode,
  paneId: string,
): {
  nextRoot: TerminalTileNode | null;
  removedTerminalId: string | null;
} {
  if (root.kind === "leaf") {
    if (root.id === paneId) {
      return { nextRoot: null, removedTerminalId: root.terminalId };
    }
    return { nextRoot: root, removedTerminalId: null };
  }
  const firstResult = removeTerminalTileFromTree(root.first, paneId);
  if (firstResult.removedTerminalId !== null) {
    return {
      nextRoot: firstResult.nextRoot ? { ...root, first: firstResult.nextRoot } : root.second,
      removedTerminalId: firstResult.removedTerminalId,
    };
  }
  const secondResult = removeTerminalTileFromTree(root.second, paneId);
  if (secondResult.removedTerminalId !== null) {
    return {
      nextRoot: secondResult.nextRoot ? { ...root, second: secondResult.nextRoot } : root.first,
      removedTerminalId: secondResult.removedTerminalId,
    };
  }
  return { nextRoot: root, removedTerminalId: null };
}

export function setTerminalSplitRatioInTree(
  root: TerminalTileNode,
  splitNodeId: string,
  ratio: number,
): TerminalTileNode {
  const node = findTerminalTileById(root, splitNodeId);
  if (!node || node.kind !== "split") return root;
  const clamped = clampTerminalTileRatio(ratio);
  if (Math.abs(node.ratio - clamped) < 0.0001) return root;
  return replaceTerminalTileNode(root, splitNodeId, { ...node, ratio: clamped });
}

function overlapAmount(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * Geometric directional neighbor lookup across the tiled layout (i3 / Hyprland / Ghostty style).
 * Prefers panes directly adjacent along the requested edge with the strongest perpendicular overlap.
 */
export function findDirectionalTerminalTile(
  root: TerminalTileNode,
  focusedPaneId: string,
  direction: TerminalTileNavigationDirection,
): string | null {
  const { leaves } = layoutTerminalTiles(root);
  if (leaves.length <= 1) return null;

  const current = leaves.find((entry) => entry.leaf.id === focusedPaneId);
  if (!current) return leaves[0]?.leaf.id ?? null;

  const cur = current.rect;
  const curCenterX = cur.left + cur.width / 2;
  const curCenterY = cur.top + cur.height / 2;
  const EPS = 0.001;

  let bestId: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of leaves) {
    if (candidate.leaf.id === focusedPaneId) continue;
    const rect = candidate.rect;
    let primaryGap = -1;
    let perpOverlap = 0;
    let perpCenterDist = 0;

    if (direction === "left") {
      if (rect.left + rect.width > cur.left + EPS) continue;
      primaryGap = Math.max(0, cur.left - (rect.left + rect.width));
      perpOverlap = overlapAmount(cur.top, cur.top + cur.height, rect.top, rect.top + rect.height);
      perpCenterDist = Math.abs(curCenterY - (rect.top + rect.height / 2));
    } else if (direction === "right") {
      if (rect.left < cur.left + cur.width - EPS) continue;
      primaryGap = Math.max(0, rect.left - (cur.left + cur.width));
      perpOverlap = overlapAmount(cur.top, cur.top + cur.height, rect.top, rect.top + rect.height);
      perpCenterDist = Math.abs(curCenterY - (rect.top + rect.height / 2));
    } else if (direction === "up") {
      if (rect.top + rect.height > cur.top + EPS) continue;
      primaryGap = Math.max(0, cur.top - (rect.top + rect.height));
      perpOverlap = overlapAmount(
        cur.left,
        cur.left + cur.width,
        rect.left,
        rect.left + rect.width,
      );
      perpCenterDist = Math.abs(curCenterX - (rect.left + rect.width / 2));
    } else {
      if (rect.top < cur.top + cur.height - EPS) continue;
      primaryGap = Math.max(0, rect.top - (cur.top + cur.height));
      perpOverlap = overlapAmount(
        cur.left,
        cur.left + cur.width,
        rect.left,
        rect.left + rect.width,
      );
      perpCenterDist = Math.abs(curCenterX - (rect.left + rect.width / 2));
    }

    // Strongly prefer panes sharing an edge and perpendicular overlap.
    const overlapPenalty = perpOverlap > EPS ? 0 : 10;
    const score = primaryGap * 100 + overlapPenalty + perpCenterDist - perpOverlap * 0.5;
    if (score < bestScore) {
      bestScore = score;
      bestId = candidate.leaf.id;
    }
  }

  return bestId;
}

/**
 * Resize the nearest ancestor split along the requested axis for `focusedPaneId`.
 * Moving left/up decreases the split ratio; moving right/down increases it.
 */
export function resizeTerminalTileInTree(
  root: TerminalTileNode,
  focusedPaneId: string,
  direction: TerminalTileNavigationDirection,
  step = DEFAULT_TERMINAL_TILE_RESIZE_STEP,
): TerminalTileNode {
  const targetAxis: TerminalTileDirection =
    direction === "left" || direction === "right" ? "horizontal" : "vertical";
  const delta = direction === "right" || direction === "down" ? step : -step;

  // Walk down to `focusedPaneId` and find the deepest ancestor split on `targetAxis`.
  const findNearestAxisSplit = (node: TerminalTileNode): TerminalTileSplit | null => {
    if (node.kind === "leaf") {
      return null;
    }
    const inFirst = findTerminalTileLeafById(node.first, focusedPaneId) !== null;
    const inSecond = !inFirst && findTerminalTileLeafById(node.second, focusedPaneId) !== null;
    if (!inFirst && !inSecond) return null;

    const deeper = findNearestAxisSplit(inFirst ? node.first : node.second);
    if (deeper) return deeper;
    return node.direction === targetAxis ? node : null;
  };

  const split = findNearestAxisSplit(root);
  if (!split) return root;
  return setTerminalSplitRatioInTree(root, split.id, split.ratio + delta);
}

export function resolveActiveBottomTerminalTab(
  state: BottomTerminalThreadState,
): BottomTerminalTab | null {
  if (state.tabs.length === 0) return null;
  if (state.activeTabId) {
    const matched = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (matched) return matched;
  }
  return state.tabs[0] ?? null;
}

export function resolveFocusedTerminalId(state: BottomTerminalThreadState): string | null {
  const activeTab = resolveActiveBottomTerminalTab(state);
  if (!activeTab) return null;
  const leaf =
    findTerminalTileLeafById(activeTab.root, activeTab.focusedPaneId) ??
    collectTerminalTileLeaves(activeTab.root)[0];
  return leaf?.terminalId ?? null;
}

export function closeTerminalTileInState(
  state: BottomTerminalThreadState,
  tabId: string,
  paneId: string,
): { nextState: BottomTerminalThreadState; removedTerminalId: string | null } {
  const tabIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (tabIndex === -1) {
    return { nextState: state, removedTerminalId: null };
  }
  const tab = state.tabs[tabIndex]!;
  const previousLeaves = collectTerminalTileLeaves(tab.root);
  const removedLeafIndex = previousLeaves.findIndex((leaf) => leaf.id === paneId);
  const { nextRoot, removedTerminalId } = removeTerminalTileFromTree(tab.root, paneId);
  if (removedTerminalId === null) {
    return { nextState: state, removedTerminalId: null };
  }

  if (nextRoot === null) {
    const nextTabs = state.tabs.filter((candidate) => candidate.id !== tabId);
    const nextActiveTabId =
      state.activeTabId === tabId
        ? (resolveTabAfterClose(nextTabs, tabIndex)?.id ?? null)
        : state.activeTabId;
    return {
      nextState: {
        ...state,
        open: nextTabs.length > 0 ? state.open : false,
        maximized: nextTabs.length > 0 ? state.maximized : false,
        tabs: nextTabs,
        activeTabId: nextActiveTabId,
      },
      removedTerminalId,
    };
  }

  const survivingLeaves = collectTerminalTileLeaves(nextRoot);
  const nextFocusedPaneId =
    tab.focusedPaneId === paneId
      ? (survivingLeaves[Math.min(Math.max(0, removedLeafIndex - 1), survivingLeaves.length - 1)]
          ?.id ??
        survivingLeaves[0]?.id ??
        tab.focusedPaneId)
      : tab.focusedPaneId;
  const nextZoomedPaneId =
    tab.zoomedPaneId === paneId || survivingLeaves.length <= 1 ? null : tab.zoomedPaneId;

  const nextTabs = state.tabs.map((candidate) =>
    candidate.id === tabId
      ? {
          ...candidate,
          root: nextRoot,
          focusedPaneId: nextFocusedPaneId,
          zoomedPaneId: nextZoomedPaneId,
        }
      : candidate,
  );
  return {
    nextState: { ...state, tabs: nextTabs },
    removedTerminalId,
  };
}

export function cycleBottomTerminalTabInState(
  state: BottomTerminalThreadState,
  delta: 1 | -1,
): BottomTerminalThreadState {
  if (state.tabs.length <= 1) return state;
  const activeTab = resolveActiveBottomTerminalTab(state);
  const currentIndex = activeTab ? state.tabs.findIndex((tab) => tab.id === activeTab.id) : 0;
  const nextIndex = (currentIndex + delta + state.tabs.length) % state.tabs.length;
  const nextTab = state.tabs[nextIndex];
  if (!nextTab || nextTab.id === state.activeTabId) return state;
  return { ...state, activeTabId: nextTab.id };
}

function sanitizeTerminalTileNode(value: unknown, depth = 0): TerminalTileNode | null {
  if (depth > 12 || !isPlainObject(value)) return null;
  if (value.kind === "leaf") {
    if (
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      typeof value.terminalId !== "string" ||
      value.terminalId.length === 0
    ) {
      return null;
    }
    return { kind: "leaf", id: value.id, terminalId: value.terminalId };
  }
  if (value.kind === "split") {
    if (
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      (value.direction !== "horizontal" && value.direction !== "vertical")
    ) {
      return null;
    }
    const first = sanitizeTerminalTileNode(value.first, depth + 1);
    const second = sanitizeTerminalTileNode(value.second, depth + 1);
    if (!first && !second) return null;
    if (!first) return second;
    if (!second) return first;
    return {
      kind: "split",
      id: value.id,
      direction: value.direction,
      ratio: clampTerminalTileRatio(typeof value.ratio === "number" ? value.ratio : 0.5),
      first,
      second,
    };
  }
  return null;
}

function sanitizeBottomTerminalTab(value: unknown): BottomTerminalTab | null {
  if (!isPlainObject(value) || typeof value.id !== "string" || value.id.length === 0) {
    return null;
  }
  const root = sanitizeTerminalTileNode(value.root);
  if (!root) return null;
  const leaves = collectTerminalTileLeaves(root);
  const leafIds = new Set(leaves.map((leaf) => leaf.id));
  const focusedPaneId =
    typeof value.focusedPaneId === "string" && leafIds.has(value.focusedPaneId)
      ? value.focusedPaneId
      : (leaves[0]?.id ?? "");
  const zoomedPaneId =
    typeof value.zoomedPaneId === "string" && leafIds.has(value.zoomedPaneId) && leaves.length > 1
      ? value.zoomedPaneId
      : null;
  return {
    id: value.id,
    root,
    focusedPaneId,
    zoomedPaneId,
  };
}

export function sanitizeBottomTerminalThreadState(value: unknown): BottomTerminalThreadState {
  if (!isPlainObject(value)) {
    return createDefaultBottomTerminalState();
  }
  const tabs = Array.isArray(value.tabs)
    ? value.tabs
        .map(sanitizeBottomTerminalTab)
        .filter((tab): tab is BottomTerminalTab => tab !== null)
    : [];
  const activeTabId =
    typeof value.activeTabId === "string" && tabs.some((tab) => tab.id === value.activeTabId)
      ? value.activeTabId
      : (tabs[0]?.id ?? null);
  return {
    open: value.open === true && tabs.length > 0,
    maximized: value.maximized === true && tabs.length > 0,
    heightPx: clampBottomTerminalHeight(
      typeof value.heightPx === "number" ? value.heightPx : DEFAULT_BOTTOM_TERMINAL_HEIGHT_PX,
    ),
    tabs,
    activeTabId,
  };
}

export function sanitizeBottomTerminalStateByThreadId(
  value: unknown,
): Record<string, BottomTerminalThreadState> {
  return sanitizeStringKeyedRecord(value, (raw) =>
    raw === undefined ? null : sanitizeBottomTerminalThreadState(raw),
  );
}
