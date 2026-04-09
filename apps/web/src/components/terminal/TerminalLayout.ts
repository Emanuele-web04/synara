// FILE: TerminalLayout.ts
// Purpose: Pure layout resolution for terminal pane tabs, pane trees, and visual identities.
// Layer: Terminal view-model helpers
// Depends on: shared terminal identity logic plus terminal pane-tree helpers.

import {
  resolveTerminalVisualIdentity,
  type ResolvedTerminalVisualIdentity,
  type TerminalCliKind,
} from "@t3tools/shared/terminalThreads";

import {
  collectTerminalIdsFromLayout,
  findFirstTerminalIdInLayout,
  normalizeTerminalPaneGroup,
} from "../../terminalPaneLayout";
import {
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
  type ThreadTerminalLayoutNode,
} from "../../types";

export interface ResolvedTerminalGroupLayout {
  id: string;
  activeTerminalId: string;
  layout: ThreadTerminalLayoutNode;
  terminalIds: string[];
}

export interface ResolvedThreadTerminalLayout {
  normalizedTerminalIds: string[];
  resolvedActiveTerminalId: string;
  resolvedActiveGroupId: string;
  resolvedTerminalGroups: ResolvedTerminalGroupLayout[];
  activeGroupLayout: ThreadTerminalLayoutNode;
  visibleTerminalIds: string[];
  hasTerminalSidebar: boolean;
  isSplitView: boolean;
  showGroupHeaders: boolean;
  hasReachedSplitLimit: boolean;
  terminalVisualIdentityById: ReadonlyMap<string, ResolvedTerminalVisualIdentity>;
}

function assignUniqueGroupId(groupId: string, usedGroupIds: Set<string>): string {
  if (!usedGroupIds.has(groupId)) {
    usedGroupIds.add(groupId);
    return groupId;
  }
  let suffix = 2;
  while (usedGroupIds.has(`${groupId}-${suffix}`)) {
    suffix += 1;
  }
  const uniqueGroupId = `${groupId}-${suffix}`;
  usedGroupIds.add(uniqueGroupId);
  return uniqueGroupId;
}

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const cleaned = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  return cleaned.length > 0 ? cleaned : [DEFAULT_THREAD_TERMINAL_ID];
}

function resolveTerminalGroups(input: {
  normalizedTerminalIds: string[];
  terminalGroups: ThreadTerminalGroup[];
}): ResolvedTerminalGroupLayout[] {
  const assignedTerminalIds = new Set<string>();
  const usedGroupIds = new Set<string>();
  const nextGroups: ResolvedTerminalGroupLayout[] = [];

  for (const terminalGroup of input.terminalGroups) {
    const normalizedGroup = normalizeTerminalPaneGroup(terminalGroup, input.normalizedTerminalIds);
    if (!normalizedGroup) continue;
    const groupTerminalIds = collectTerminalIdsFromLayout(normalizedGroup.layout).filter(
      (terminalId) => {
        if (assignedTerminalIds.has(terminalId)) return false;
        return true;
      },
    );
    if (groupTerminalIds.length === 0) continue;
    const filteredGroup = normalizeTerminalPaneGroup(normalizedGroup, groupTerminalIds);
    if (!filteredGroup) continue;
    const groupId = assignUniqueGroupId(filteredGroup.id, usedGroupIds);
    collectTerminalIdsFromLayout(filteredGroup.layout).forEach((terminalId) => {
      assignedTerminalIds.add(terminalId);
    });
    nextGroups.push({
      ...filteredGroup,
      id: groupId,
      terminalIds: collectTerminalIdsFromLayout(filteredGroup.layout),
    });
  }

  for (const terminalId of input.normalizedTerminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    const id = assignUniqueGroupId(`group-${terminalId}`, usedGroupIds);
    nextGroups.push({
      id,
      activeTerminalId: terminalId,
      layout: {
        type: "terminal",
        paneId: `pane-${terminalId}`,
        terminalIds: [terminalId],
        activeTerminalId: terminalId,
      },
      terminalIds: [terminalId],
    });
  }

  if (nextGroups.length > 0) {
    return nextGroups;
  }

  return [
    {
      id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
      activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
      layout: {
        type: "terminal",
        paneId: `pane-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
        activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
      },
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    },
  ];
}

function resolveActiveGroup(input: {
  activeTerminalGroupId: string;
  activeTerminalId: string;
  resolvedTerminalGroups: ResolvedTerminalGroupLayout[];
}): ResolvedTerminalGroupLayout {
  return (
    input.resolvedTerminalGroups.find(
      (terminalGroup) => terminalGroup.id === input.activeTerminalGroupId,
    ) ??
    input.resolvedTerminalGroups.find((terminalGroup) =>
      terminalGroup.terminalIds.includes(input.activeTerminalId),
    ) ??
    input.resolvedTerminalGroups[0] ?? {
      id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
      activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
      layout: {
        type: "terminal",
        paneId: `pane-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
        activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
      },
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    }
  );
}

function resolveTerminalVisualIdentityMap(input: {
  normalizedTerminalIds: string[];
  runningTerminalIds: string[];
  terminalCliKindsById: Record<string, TerminalCliKind>;
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
}): ReadonlyMap<string, ResolvedTerminalVisualIdentity> {
  const terminalLabelsById = input.terminalLabelsById ?? {};
  const terminalTitleOverridesById = input.terminalTitleOverridesById ?? {};
  const runningTerminalIdSet = new Set(
    input.runningTerminalIds.map((id) => id.trim()).filter((id) => id.length > 0),
  );

  return new Map(
    input.normalizedTerminalIds.map((terminalId, index) => [
      terminalId,
      resolveTerminalVisualIdentity({
        cliKind: input.terminalCliKindsById[terminalId] ?? null,
        fallbackTitle: `Terminal ${index + 1}`,
        isRunning: runningTerminalIdSet.has(terminalId),
        title: terminalTitleOverridesById[terminalId] ?? terminalLabelsById[terminalId],
      }),
    ]),
  );
}

export function resolveThreadTerminalLayout(input: {
  activeTerminalGroupId: string;
  activeTerminalId: string;
  runningTerminalIds: string[];
  terminalCliKindsById: Record<string, TerminalCliKind>;
  terminalGroups: ThreadTerminalGroup[];
  terminalIds: string[];
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
}): ResolvedThreadTerminalLayout {
  const normalizedTerminalIds = normalizeTerminalIds(input.terminalIds);
  const resolvedTerminalGroups = resolveTerminalGroups({
    normalizedTerminalIds,
    terminalGroups: input.terminalGroups,
  });
  const activeGroup = resolveActiveGroup({
    activeTerminalGroupId: input.activeTerminalGroupId,
    activeTerminalId: input.activeTerminalId,
    resolvedTerminalGroups,
  });
  const resolvedActiveTerminalId = activeGroup.terminalIds.includes(input.activeTerminalId)
    ? input.activeTerminalId
    : activeGroup.terminalIds.includes(activeGroup.activeTerminalId)
      ? activeGroup.activeTerminalId
      : findFirstTerminalIdInLayout(activeGroup.layout);
  const visibleTerminalIds = activeGroup.terminalIds;
  const hasTerminalSidebar = false;
  const isSplitView = visibleTerminalIds.length > 1;
  const showGroupHeaders =
    resolvedTerminalGroups.length > 1 ||
    resolvedTerminalGroups.some((terminalGroup) => terminalGroup.terminalIds.length > 1);
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const terminalVisualIdentityById = resolveTerminalVisualIdentityMap({
    normalizedTerminalIds,
    runningTerminalIds: input.runningTerminalIds,
    terminalCliKindsById: input.terminalCliKindsById,
    terminalLabelsById: input.terminalLabelsById,
    terminalTitleOverridesById: input.terminalTitleOverridesById,
  });

  return {
    normalizedTerminalIds,
    resolvedActiveTerminalId,
    resolvedActiveGroupId: activeGroup.id,
    resolvedTerminalGroups,
    activeGroupLayout: activeGroup.layout,
    visibleTerminalIds,
    hasTerminalSidebar,
    isSplitView,
    showGroupHeaders,
    hasReachedSplitLimit,
    terminalVisualIdentityById,
  };
}
