// FILE: terminalPaneLayout.ts
// Purpose: Pure helpers for terminal pane-tree normalization and split mutations.
// Layer: Terminal domain helpers
// Depends on: terminal layout types shared by the store and terminal UI.

import {
  DEFAULT_THREAD_TERMINAL_ID,
  type ThreadTerminalGroup,
  type ThreadTerminalLayoutNode,
  type ThreadTerminalSplitDirection,
  type ThreadTerminalSplitNode,
  type ThreadTerminalSplitPosition,
} from "./types";

type RawTerminalGroup = Partial<ThreadTerminalGroup> & {
  terminalIds?: string[] | undefined;
  layout?: ThreadTerminalLayoutNode | undefined;
  activeTerminalId?: string | undefined;
};

type RawTerminalLeafNode = Partial<Extract<ThreadTerminalLayoutNode, { type: "terminal" }>> & {
  terminalId?: string | undefined;
};

function normalizePaneTerminalIds(
  terminalIds: Array<string | undefined> | undefined,
  validTerminalIdSet?: ReadonlySet<string>,
): string[] {
  return [...new Set((terminalIds ?? []).map((terminalId) => terminalId?.trim() ?? ""))]
    .filter((terminalId) => terminalId.length > 0)
    .filter((terminalId) => (validTerminalIdSet ? validTerminalIdSet.has(terminalId) : true));
}

function resolveLeafTerminalIds(
  node: RawTerminalLeafNode | null | undefined,
  validTerminalIdSet?: ReadonlySet<string>,
): string[] {
  const terminalIds = normalizePaneTerminalIds(node?.terminalIds, validTerminalIdSet);
  if (terminalIds.length > 0) {
    return terminalIds;
  }
  return normalizePaneTerminalIds([node?.terminalId], validTerminalIdSet);
}

function createTerminalLeaf(
  terminalId: string,
  paneId = `pane-${terminalId}`,
): ThreadTerminalLayoutNode {
  return {
    type: "terminal",
    paneId,
    terminalIds: [terminalId],
    activeTerminalId: terminalId,
  };
}

export function isTerminalSplitNode(
  node: ThreadTerminalLayoutNode,
): node is ThreadTerminalSplitNode {
  return node.type === "split";
}

function normalizedWeight(weight: number | undefined): number {
  return Number.isFinite(weight) && weight && weight > 0 ? weight : 1;
}

function normalizeSplitWeights(childrenCount: number, weights: number[] | undefined): number[] {
  const nextWeights = Array.from({ length: childrenCount }, (_, index) =>
    normalizedWeight(weights?.[index]),
  );
  return nextWeights.length > 0 ? nextWeights : [1];
}

function flattenSplitChildren(
  direction: ThreadTerminalSplitDirection,
  children: ThreadTerminalLayoutNode[],
  weights: number[],
): { children: ThreadTerminalLayoutNode[]; weights: number[] } {
  const nextChildren: ThreadTerminalLayoutNode[] = [];
  const nextWeights: number[] = [];

  children.forEach((child, index) => {
    const childWeight = normalizedWeight(weights[index]);
    if (isTerminalSplitNode(child) && child.direction === direction) {
      const totalChildWeight = child.weights.reduce(
        (sum, weight) => sum + normalizedWeight(weight),
        0,
      );
      const safeTotal = totalChildWeight > 0 ? totalChildWeight : child.children.length;
      child.children.forEach((nestedChild, nestedIndex) => {
        nextChildren.push(nestedChild);
        nextWeights.push((childWeight * normalizedWeight(child.weights[nestedIndex])) / safeTotal);
      });
      return;
    }
    nextChildren.push(child);
    nextWeights.push(childWeight);
  });

  return { children: nextChildren, weights: nextWeights };
}

function sanitizeLayoutNode(
  node: ThreadTerminalLayoutNode | null | undefined,
  validTerminalIdSet: ReadonlySet<string>,
): ThreadTerminalLayoutNode | null {
  if (!node) return null;
  if (node.type === "terminal") {
    const terminalIds = resolveLeafTerminalIds(node, validTerminalIdSet);
    if (terminalIds.length === 0) {
      return null;
    }
    const activeTerminalId = terminalIds.includes(node.activeTerminalId?.trim() ?? "")
      ? (node.activeTerminalId?.trim() ?? terminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID)
      : (terminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
    return {
      type: "terminal",
      paneId: node.paneId?.trim() || `pane-${activeTerminalId}`,
      terminalIds,
      activeTerminalId,
    };
  }

  const sanitizedChildren = node.children
    .map((child) => sanitizeLayoutNode(child, validTerminalIdSet))
    .filter((child): child is ThreadTerminalLayoutNode => child !== null);

  if (sanitizedChildren.length === 0) return null;
  if (sanitizedChildren.length === 1) return sanitizedChildren[0] ?? null;

  const flattened = flattenSplitChildren(
    node.direction,
    sanitizedChildren,
    normalizeSplitWeights(sanitizedChildren.length, node.weights),
  );

  return {
    type: "split",
    id: node.id,
    direction: node.direction,
    children: flattened.children,
    weights: normalizeSplitWeights(flattened.children.length, flattened.weights),
  };
}

function buildLegacyLayout(terminalIds: string[]): ThreadTerminalLayoutNode {
  if (terminalIds.length <= 1) {
    return createTerminalLeaf(terminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
  }

  return {
    type: "split",
    id: `split-${terminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID}`,
    direction: "horizontal",
    children: terminalIds.map((terminalId) => createTerminalLeaf(terminalId)),
    weights: terminalIds.map(() => 1),
  };
}

export function collectTerminalIdsFromLayout(node: ThreadTerminalLayoutNode): string[] {
  if (node.type === "terminal") {
    const terminalIds = normalizePaneTerminalIds((node as RawTerminalLeafNode).terminalIds);
    if (terminalIds.length > 0) {
      return terminalIds;
    }
    return normalizePaneTerminalIds([(node as RawTerminalLeafNode).terminalId]);
  }
  return node.children.flatMap((child) => collectTerminalIdsFromLayout(child));
}

export function findAdjacentTerminalId(
  node: ThreadTerminalLayoutNode,
  terminalId: string,
): string | null {
  if (node.type === "terminal") {
    return null;
  }
  const ids = collectTerminalIdsFromLayout(node);
  const index = ids.indexOf(terminalId);
  if (index < 0) return null;
  if (index + 1 < ids.length) return ids[index + 1] ?? null;
  if (index - 1 >= 0) return ids[index - 1] ?? null;
  return null;
}

export function findFirstTerminalIdInLayout(node: ThreadTerminalLayoutNode): string {
  if (node.type === "terminal") {
    const terminalIds = collectTerminalIdsFromLayout(node);
    const activeTerminalId =
      "activeTerminalId" in node ? (node.activeTerminalId?.trim() ?? "") : "";
    return terminalIds.includes(activeTerminalId)
      ? activeTerminalId
      : (terminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
  }
  return findFirstTerminalIdInLayout(
    node.children[0] ?? createTerminalLeaf(DEFAULT_THREAD_TERMINAL_ID),
  );
}

export function layoutContainsTerminalId(
  node: ThreadTerminalLayoutNode,
  terminalId: string,
): boolean {
  if (node.type === "terminal") {
    return collectTerminalIdsFromLayout(node).includes(terminalId);
  }
  return node.children.some((child) => layoutContainsTerminalId(child, terminalId));
}

export function normalizeTerminalPaneGroup(
  group: RawTerminalGroup,
  validTerminalIds: string[],
): ThreadTerminalGroup | null {
  const validTerminalIdSet = new Set(validTerminalIds);
  const legacyTerminalIds = [
    ...new Set((group.terminalIds ?? []).map((id) => id.trim()).filter(Boolean)),
  ].filter((terminalId) => validTerminalIdSet.has(terminalId));
  const fallbackLayout = legacyTerminalIds.length > 0 ? buildLegacyLayout(legacyTerminalIds) : null;
  const sanitizedLayout = sanitizeLayoutNode(group.layout ?? fallbackLayout, validTerminalIdSet);
  if (!sanitizedLayout) return null;

  const terminalIds = collectTerminalIdsFromLayout(sanitizedLayout);
  const activeTerminalId = terminalIds.includes(group.activeTerminalId?.trim() ?? "")
    ? (group.activeTerminalId?.trim() ?? terminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID)
    : (terminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);

  return {
    id: group.id?.trim() || `group-${activeTerminalId}`,
    activeTerminalId,
    layout: sanitizedLayout,
  };
}

function splitDirectionForPosition(
  position: ThreadTerminalSplitPosition,
): ThreadTerminalSplitDirection {
  return position === "left" || position === "right" ? "horizontal" : "vertical";
}

function shouldInsertBefore(position: ThreadTerminalSplitPosition): boolean {
  return position === "left" || position === "top";
}

function splitWeightEvenly(weight: number, parts: number): number[] {
  const safeWeight = normalizedWeight(weight);
  return Array.from({ length: parts }, () => safeWeight / parts);
}

function splitLayoutNode(input: {
  node: ThreadTerminalLayoutNode;
  targetTerminalId: string;
  newTerminalId: string;
  position: ThreadTerminalSplitPosition;
  splitId: string;
}): { node: ThreadTerminalLayoutNode; didSplit: boolean; mergeIntoParent: boolean } {
  const direction = splitDirectionForPosition(input.position);
  const insertBefore = shouldInsertBefore(input.position);

  if (input.node.type === "terminal") {
    if (!input.node.terminalIds.includes(input.targetTerminalId)) {
      return { node: input.node, didSplit: false, mergeIntoParent: false };
    }
    return {
      node: {
        type: "split",
        id: input.splitId,
        direction,
        children: insertBefore
          ? [createTerminalLeaf(input.newTerminalId), input.node]
          : [input.node, createTerminalLeaf(input.newTerminalId)],
        weights: [1, 1],
      },
      didSplit: true,
      mergeIntoParent: true,
    };
  }

  const childIndex = input.node.children.findIndex((child) =>
    layoutContainsTerminalId(child, input.targetTerminalId),
  );
  if (childIndex < 0) {
    return { node: input.node, didSplit: false, mergeIntoParent: false };
  }

  const child = input.node.children[childIndex];
  if (!child) {
    return { node: input.node, didSplit: false, mergeIntoParent: false };
  }

  const childResult = splitLayoutNode({
    ...input,
    node: child,
  });
  if (!childResult.didSplit) {
    return { node: input.node, didSplit: false, mergeIntoParent: false };
  }

  const nextChildren = [...input.node.children];
  const nextWeights = normalizeSplitWeights(nextChildren.length, input.node.weights);
  const targetWeight = nextWeights[childIndex] ?? 1;

  if (
    input.node.direction === direction &&
    childResult.mergeIntoParent &&
    isTerminalSplitNode(childResult.node) &&
    childResult.node.direction === direction
  ) {
    const mergedChildren = childResult.node.children;
    const mergedWeights = splitWeightEvenly(targetWeight, mergedChildren.length);
    nextChildren.splice(childIndex, 1, ...mergedChildren);
    nextWeights.splice(childIndex, 1, ...mergedWeights);
    return {
      node: {
        ...input.node,
        children: nextChildren,
        weights: nextWeights,
      },
      didSplit: true,
      mergeIntoParent: false,
    };
  }

  nextChildren[childIndex] = childResult.node;
  return {
    node: {
      ...input.node,
      children: nextChildren,
      weights: nextWeights,
    },
    didSplit: true,
    mergeIntoParent: false,
  };
}

export function splitTerminalGroupLayout(input: {
  group: ThreadTerminalGroup;
  targetTerminalId: string;
  newTerminalId: string;
  position: ThreadTerminalSplitPosition;
  splitId: string;
}): ThreadTerminalGroup {
  const result = splitLayoutNode({
    node: input.group.layout,
    targetTerminalId: input.targetTerminalId,
    newTerminalId: input.newTerminalId,
    position: input.position,
    splitId: input.splitId,
  });
  if (!result.didSplit) {
    return input.group;
  }
  return {
    ...input.group,
    activeTerminalId: input.newTerminalId,
    layout: result.node,
  };
}

function removeTerminalFromLayoutNode(
  node: ThreadTerminalLayoutNode,
  terminalId: string,
): { node: ThreadTerminalLayoutNode | null; removed: boolean } {
  if (node.type === "terminal") {
    if (!node.terminalIds.includes(terminalId)) {
      return { node, removed: false };
    }
    const nextTerminalIds = node.terminalIds.filter(
      (currentTerminalId) => currentTerminalId !== terminalId,
    );
    if (nextTerminalIds.length === 0) {
      return { node: null, removed: true };
    }
    const nextActiveTerminalId = nextTerminalIds.includes(node.activeTerminalId)
      ? node.activeTerminalId
      : (nextTerminalIds[
          Math.min(node.terminalIds.indexOf(terminalId), nextTerminalIds.length - 1)
        ] ??
        nextTerminalIds[0] ??
        DEFAULT_THREAD_TERMINAL_ID);
    return {
      node: {
        ...node,
        terminalIds: nextTerminalIds,
        activeTerminalId: nextActiveTerminalId,
      },
      removed: true,
    };
  }

  let removed = false;
  const nextChildren: ThreadTerminalLayoutNode[] = [];
  const nextWeights: number[] = [];
  const weights = normalizeSplitWeights(node.children.length, node.weights);

  node.children.forEach((child, index) => {
    const result = removeTerminalFromLayoutNode(child, terminalId);
    if (result.removed) {
      removed = true;
    }
    if (result.node) {
      nextChildren.push(result.node);
      nextWeights.push(weights[index] ?? 1);
    }
  });

  if (!removed) {
    return { node, removed: false };
  }
  if (nextChildren.length === 0) {
    return { node: null, removed: true };
  }
  if (nextChildren.length === 1) {
    return { node: nextChildren[0] ?? null, removed: true };
  }
  return {
    node: {
      ...node,
      children: nextChildren,
      weights: normalizeSplitWeights(nextChildren.length, nextWeights),
    },
    removed: true,
  };
}

export function removeTerminalFromGroupLayout(
  group: ThreadTerminalGroup,
  terminalId: string,
): ThreadTerminalGroup | null {
  // Compute the adjacent terminal BEFORE removal so the neighbor lookup uses the original tree.
  const adjacentId = findAdjacentTerminalId(group.layout, terminalId);

  const result = removeTerminalFromLayoutNode(group.layout, terminalId);
  if (!result.removed) {
    return group;
  }
  if (!result.node) {
    return null;
  }
  const terminalIds = collectTerminalIdsFromLayout(result.node);
  return {
    ...group,
    activeTerminalId: terminalIds.includes(group.activeTerminalId)
      ? group.activeTerminalId
      : (adjacentId ?? terminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID),
    layout: result.node,
  };
}

function updateLeafNode(
  node: ThreadTerminalLayoutNode,
  terminalId: string,
  updater: (
    node: Extract<ThreadTerminalLayoutNode, { type: "terminal" }>,
  ) => ThreadTerminalLayoutNode,
): { node: ThreadTerminalLayoutNode; updated: boolean } {
  if (node.type === "terminal") {
    if (!node.terminalIds.includes(terminalId)) {
      return { node, updated: false };
    }
    return { node: updater(node), updated: true };
  }

  let updated = false;
  const nextChildren = node.children.map((child) => {
    const result = updateLeafNode(child, terminalId, updater);
    if (result.updated) {
      updated = true;
    }
    return result.node;
  });

  return updated ? { node: { ...node, children: nextChildren }, updated } : { node, updated };
}

export function addTerminalTabToGroupLayout(
  group: ThreadTerminalGroup,
  targetTerminalId: string,
  newTerminalId: string,
): ThreadTerminalGroup {
  const result = updateLeafNode(group.layout, targetTerminalId, (node) => ({
    ...node,
    terminalIds: [...node.terminalIds, newTerminalId],
    activeTerminalId: newTerminalId,
  }));
  if (!result.updated) {
    return group;
  }
  return {
    ...group,
    activeTerminalId: newTerminalId,
    layout: result.node,
  };
}

export function setActiveTerminalInGroupLayout(
  group: ThreadTerminalGroup,
  terminalId: string,
): ThreadTerminalGroup {
  const result = updateLeafNode(group.layout, terminalId, (node) =>
    node.activeTerminalId === terminalId ? node : { ...node, activeTerminalId: terminalId },
  );
  if (!result.updated) {
    return group;
  }
  return group.activeTerminalId === terminalId && result.node === group.layout
    ? group
    : {
        ...group,
        activeTerminalId: terminalId,
        layout: result.node,
      };
}

function resizeSplitNode(
  node: ThreadTerminalLayoutNode,
  splitId: string,
  weights: number[],
): { node: ThreadTerminalLayoutNode; didResize: boolean } {
  if (node.type === "terminal") {
    return { node, didResize: false };
  }
  if (node.id === splitId) {
    return {
      node: {
        ...node,
        weights: normalizeSplitWeights(node.children.length, weights),
      },
      didResize: true,
    };
  }

  let didResize = false;
  const nextChildren = node.children.map((child) => {
    const result = resizeSplitNode(child, splitId, weights);
    if (result.didResize) {
      didResize = true;
    }
    return result.node;
  });

  return didResize
    ? {
        node: {
          ...node,
          children: nextChildren,
        },
        didResize,
      }
    : { node, didResize };
}

export function resizeTerminalGroupLayout(
  group: ThreadTerminalGroup,
  splitId: string,
  weights: number[],
): ThreadTerminalGroup {
  const result = resizeSplitNode(group.layout, splitId, weights);
  return result.didResize ? { ...group, layout: result.node } : group;
}

function equalizeLayoutNode(node: ThreadTerminalLayoutNode): ThreadTerminalLayoutNode {
  if (node.type === "terminal") {
    return node;
  }
  return {
    ...node,
    children: node.children.map(equalizeLayoutNode),
    weights: node.children.map(() => 1),
  };
}

export function equalizeTerminalGroupLayout(group: ThreadTerminalGroup): ThreadTerminalGroup {
  return { ...group, layout: equalizeLayoutNode(group.layout) };
}

export function createTerminalGroup(groupId: string, terminalId: string): ThreadTerminalGroup {
  return {
    id: groupId,
    activeTerminalId: terminalId,
    layout: createTerminalLeaf(terminalId),
  };
}
