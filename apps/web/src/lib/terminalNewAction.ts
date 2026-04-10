import { collectTerminalIdsFromLayout } from "../terminalPaneLayout";
import type { ThreadTerminalGroup } from "../types";

export interface ResolveTerminalNewActionInput {
  terminalOpen: boolean;
  activeTerminalId: string;
  activeTerminalGroupId: string;
  terminalGroups: ThreadTerminalGroup[];
}

export type TerminalNewAction =
  | { kind: "new-group" }
  | { kind: "new-tab"; targetTerminalId: string };

function resolveActiveTerminalGroup(
  input: ResolveTerminalNewActionInput,
): ThreadTerminalGroup | null {
  return (
    input.terminalGroups.find((group) => group.id === input.activeTerminalGroupId) ??
    input.terminalGroups.find((group) =>
      collectTerminalIdsFromLayout(group.layout).includes(input.activeTerminalId),
    ) ??
    input.terminalGroups[0] ??
    null
  );
}

export function resolveTerminalNewAction(input: ResolveTerminalNewActionInput): TerminalNewAction {
  if (!input.terminalOpen) {
    return { kind: "new-group" };
  }

  const activeGroup = resolveActiveTerminalGroup(input);
  const activeGroupTerminalIds = activeGroup
    ? collectTerminalIdsFromLayout(activeGroup.layout)
    : [];
  const normalizedActiveTerminalId = input.activeTerminalId.trim();

  if (activeGroup && activeGroupTerminalIds.includes(activeGroup.activeTerminalId)) {
    return {
      kind: "new-tab",
      targetTerminalId: activeGroup.activeTerminalId,
    };
  }

  if (activeGroupTerminalIds.includes(normalizedActiveTerminalId)) {
    return {
      kind: "new-tab",
      targetTerminalId: normalizedActiveTerminalId,
    };
  }

  if (activeGroupTerminalIds[0]) {
    return {
      kind: "new-tab",
      targetTerminalId: activeGroupTerminalIds[0],
    };
  }

  if (normalizedActiveTerminalId.length > 0) {
    return {
      kind: "new-tab",
      targetTerminalId: normalizedActiveTerminalId,
    };
  }

  return { kind: "new-group" };
}
