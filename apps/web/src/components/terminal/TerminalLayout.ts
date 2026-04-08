// FILE: TerminalLayout.ts
// Purpose: Pure layout resolution for terminal tabs, groups, and visual identities.
// Layer: Terminal view-model helpers
// Depends on: shared terminal identity logic plus thread terminal group types.

import {
  resolveTerminalVisualIdentity,
  type ResolvedTerminalVisualIdentity,
  type TerminalCliKind,
} from "@t3tools/shared/terminalThreads";

import {
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "../../types";

export interface ResolvedThreadTerminalLayout {
  normalizedTerminalIds: string[];
  resolvedActiveTerminalId: string;
  resolvedTerminalGroups: ThreadTerminalGroup[];
  visibleTerminalIds: string[];
  workspaceTerminalIds: string[];
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
  activeTerminalId: string;
  normalizedTerminalIds: string[];
  terminalGroups: ThreadTerminalGroup[];
}): ThreadTerminalGroup[] {
  const validTerminalIdSet = new Set(input.normalizedTerminalIds);
  const assignedTerminalIds = new Set<string>();
  const usedGroupIds = new Set<string>();
  const nextGroups: ThreadTerminalGroup[] = [];

  for (const terminalGroup of input.terminalGroups) {
    const nextTerminalIds = [
      ...new Set(terminalGroup.terminalIds.map((id) => id.trim()).filter((id) => id.length > 0)),
    ].filter((terminalId) => {
      if (!validTerminalIdSet.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (nextTerminalIds.length === 0) continue;

    for (const terminalId of nextTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }

    const baseGroupId =
      terminalGroup.id.trim().length > 0
        ? terminalGroup.id.trim()
        : `group-${nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID}`;
    nextGroups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: nextTerminalIds,
    });
  }

  for (const terminalId of input.normalizedTerminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    nextGroups.push({
      id: assignUniqueGroupId(`group-${terminalId}`, usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  if (nextGroups.length > 0) {
    return nextGroups;
  }

  return [
    {
      id: `group-${input.activeTerminalId}`,
      terminalIds: [input.activeTerminalId],
    },
  ];
}

function resolveActiveGroupIndex(input: {
  activeTerminalGroupId: string;
  resolvedActiveTerminalId: string;
  resolvedTerminalGroups: ThreadTerminalGroup[];
}): number {
  const indexById = input.resolvedTerminalGroups.findIndex(
    (terminalGroup) => terminalGroup.id === input.activeTerminalGroupId,
  );
  if (indexById >= 0) return indexById;
  const indexByTerminal = input.resolvedTerminalGroups.findIndex((terminalGroup) =>
    terminalGroup.terminalIds.includes(input.resolvedActiveTerminalId),
  );
  return indexByTerminal >= 0 ? indexByTerminal : 0;
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
  const resolvedActiveTerminalId = normalizedTerminalIds.includes(input.activeTerminalId)
    ? input.activeTerminalId
    : (normalizedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
  const resolvedTerminalGroups = resolveTerminalGroups({
    activeTerminalId: resolvedActiveTerminalId,
    normalizedTerminalIds,
    terminalGroups: input.terminalGroups,
  });
  const resolvedActiveGroupIndex = resolveActiveGroupIndex({
    activeTerminalGroupId: input.activeTerminalGroupId,
    resolvedActiveTerminalId,
    resolvedTerminalGroups,
  });
  const visibleTerminalIds = resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ?? [
    resolvedActiveTerminalId,
  ];
  const workspaceTerminalIds = normalizedTerminalIds;
  const hasTerminalSidebar = normalizedTerminalIds.length > 1;
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
    resolvedTerminalGroups,
    visibleTerminalIds,
    workspaceTerminalIds,
    hasTerminalSidebar,
    isSplitView,
    showGroupHeaders,
    hasReachedSplitLimit,
    terminalVisualIdentityById,
  };
}
