// FILE: workspaceTerminalLayoutPresets.ts
// Purpose: Define reusable workspace terminal layout presets and map them to pane trees.
// Layer: Workspace terminal domain helpers

import {
  DEFAULT_THREAD_TERMINAL_ID,
  type ThreadTerminalGroup,
  type ThreadTerminalLayoutNode,
} from "./types";

export type WorkspaceLayoutPresetId =
  | "single"
  | "two-columns"
  | "two-rows"
  | "top-main"
  | "left-main"
  | "quad";

export interface WorkspaceLayoutPresetDefinition {
  id: WorkspaceLayoutPresetId;
  title: string;
  description: string;
  slotCount: number;
}

export const DEFAULT_WORKSPACE_LAYOUT_PRESET_ID: WorkspaceLayoutPresetId = "single";

export const WORKSPACE_LAYOUT_PRESETS: readonly WorkspaceLayoutPresetDefinition[] = [
  {
    id: "single",
    title: "Single",
    description: "One focused terminal.",
    slotCount: 1,
  },
  {
    id: "two-columns",
    title: "Two Columns",
    description: "Two terminals side by side.",
    slotCount: 2,
  },
  {
    id: "two-rows",
    title: "Two Rows",
    description: "Two terminals stacked vertically.",
    slotCount: 2,
  },
  {
    id: "top-main",
    title: "Top + Bottom",
    description: "One large terminal above two smaller panes.",
    slotCount: 3,
  },
  {
    id: "left-main",
    title: "Left + Stack",
    description: "One large pane on the left and two stacked on the right.",
    slotCount: 3,
  },
  {
    id: "quad",
    title: "Quad",
    description: "Four equally visible terminals.",
    slotCount: 4,
  },
] as const;

function normalizeTerminalIds(terminalIds: readonly string[]): string[] {
  const ids = [...new Set(terminalIds.map((terminalId) => terminalId.trim()).filter(Boolean))];
  return ids.length > 0 ? ids : [DEFAULT_THREAD_TERMINAL_ID];
}

function createTerminalLeaf(
  terminalIds: readonly string[],
  paneId: string,
  activeTerminalId: string,
): ThreadTerminalLayoutNode {
  const normalizedTerminalIds = normalizeTerminalIds(terminalIds);
  const resolvedActiveTerminalId = normalizedTerminalIds.includes(activeTerminalId)
    ? activeTerminalId
    : (normalizedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
  return {
    type: "terminal",
    paneId,
    terminalIds: normalizedTerminalIds,
    activeTerminalId: resolvedActiveTerminalId,
  };
}

function createSplit(
  id: string,
  direction: "horizontal" | "vertical",
  children: readonly ThreadTerminalLayoutNode[],
): ThreadTerminalLayoutNode {
  return {
    type: "split",
    id,
    direction,
    children: [...children],
    weights: children.map(() => 1),
  };
}

function normalizePresetId(presetId: WorkspaceLayoutPresetId | string): WorkspaceLayoutPresetId {
  return (
    WORKSPACE_LAYOUT_PRESETS.find((preset) => preset.id === presetId)?.id ??
    DEFAULT_WORKSPACE_LAYOUT_PRESET_ID
  );
}

export function getWorkspaceLayoutPreset(
  presetId: WorkspaceLayoutPresetId | string,
): WorkspaceLayoutPresetDefinition {
  const normalizedPresetId = normalizePresetId(presetId);
  const preset = WORKSPACE_LAYOUT_PRESETS.find((entry) => entry.id === normalizedPresetId);
  if (preset) {
    return preset;
  }
  return {
    id: DEFAULT_WORKSPACE_LAYOUT_PRESET_ID,
    title: "Single",
    description: "One focused terminal.",
    slotCount: 1,
  };
}

export function getWorkspaceLayoutPresetSlotCount(
  presetId: WorkspaceLayoutPresetId | string,
): number {
  return getWorkspaceLayoutPreset(presetId).slotCount;
}

export function ensureTerminalIdsForPreset(
  terminalIds: readonly string[],
  presetId: WorkspaceLayoutPresetId | string,
  createTerminalId: () => string,
): string[] {
  const normalizedTerminalIds = normalizeTerminalIds(terminalIds);
  const requiredSlotCount = getWorkspaceLayoutPresetSlotCount(presetId);
  const nextTerminalIds = [...normalizedTerminalIds];
  while (nextTerminalIds.length < requiredSlotCount) {
    const nextTerminalId = createTerminalId().trim();
    if (nextTerminalId.length === 0 || nextTerminalIds.includes(nextTerminalId)) {
      continue;
    }
    nextTerminalIds.push(nextTerminalId);
  }
  return nextTerminalIds;
}

function distributeTerminalIdsAcrossSlots(
  terminalIds: readonly string[],
  slotCount: number,
): string[][] {
  const normalizedTerminalIds = normalizeTerminalIds(terminalIds);
  const nextSlots = Array.from({ length: Math.max(1, slotCount) }, () => [] as string[]);

  normalizedTerminalIds.forEach((terminalId, index) => {
    const slotIndex = index < nextSlots.length ? index : index % nextSlots.length;
    nextSlots[slotIndex]?.push(terminalId);
  });

  return nextSlots.map((slotTerminalIds, index) =>
    slotTerminalIds.length > 0
      ? slotTerminalIds
      : [normalizedTerminalIds[index] ?? normalizedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID],
  );
}

function buildPresetLayout(input: {
  presetId: WorkspaceLayoutPresetId;
  terminalIds: readonly string[];
  activeTerminalId: string;
}): ThreadTerminalLayoutNode {
  const slots = distributeTerminalIdsAcrossSlots(
    input.terminalIds,
    getWorkspaceLayoutPresetSlotCount(input.presetId),
  );
  const leaf = (slotIndex: number) =>
    createTerminalLeaf(
      slots[slotIndex] ?? [DEFAULT_THREAD_TERMINAL_ID],
      `pane-${input.presetId}-${slotIndex + 1}`,
      input.activeTerminalId,
    );

  switch (input.presetId) {
    case "two-columns":
      return createSplit(`workspace-${input.presetId}-root`, "horizontal", [leaf(0), leaf(1)]);
    case "two-rows":
      return createSplit(`workspace-${input.presetId}-root`, "vertical", [leaf(0), leaf(1)]);
    case "top-main":
      return createSplit(`workspace-${input.presetId}-root`, "vertical", [
        leaf(0),
        createSplit(`workspace-${input.presetId}-bottom`, "horizontal", [leaf(1), leaf(2)]),
      ]);
    case "left-main":
      return createSplit(`workspace-${input.presetId}-root`, "horizontal", [
        leaf(0),
        createSplit(`workspace-${input.presetId}-right`, "vertical", [leaf(1), leaf(2)]),
      ]);
    case "quad":
      return createSplit(`workspace-${input.presetId}-root`, "vertical", [
        createSplit(`workspace-${input.presetId}-top`, "horizontal", [leaf(0), leaf(1)]),
        createSplit(`workspace-${input.presetId}-bottom`, "horizontal", [leaf(2), leaf(3)]),
      ]);
    case "single":
    default:
      return leaf(0);
  }
}

export function createWorkspaceTerminalGroupFromPreset(input: {
  presetId: WorkspaceLayoutPresetId | string;
  terminalIds: readonly string[];
  activeTerminalId?: string | null | undefined;
}): ThreadTerminalGroup {
  const normalizedPresetId = normalizePresetId(input.presetId);
  const normalizedTerminalIds = normalizeTerminalIds(input.terminalIds);
  const resolvedActiveTerminalId = normalizedTerminalIds.includes(input.activeTerminalId ?? "")
    ? (input.activeTerminalId ?? normalizedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID)
    : (normalizedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);

  return {
    id: `workspace-group-${normalizedPresetId}`,
    activeTerminalId: resolvedActiveTerminalId,
    layout: buildPresetLayout({
      presetId: normalizedPresetId,
      terminalIds: normalizedTerminalIds,
      activeTerminalId: resolvedActiveTerminalId,
    }),
  };
}
