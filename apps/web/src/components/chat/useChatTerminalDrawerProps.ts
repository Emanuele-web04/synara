import { useMemo } from "react";
import { type ThreadId } from "@t3tools/contracts";
import { type TerminalActivityState, type TerminalCliKind } from "@t3tools/shared/terminalThreads";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { selectThreadTerminalState } from "../../terminalStateStore";

type ThreadTerminalState = ReturnType<typeof selectThreadTerminalState>;

interface UseChatTerminalDrawerPropsParams {
  threadId: ThreadId;
  gitCwd: string | null;
  activeProject: { cwd: string } | null | undefined;
  threadTerminalRuntimeEnv: Record<string, string>;
  terminalState: ThreadTerminalState;
  terminalFocusRequestId: number;
  splitTerminalRight: () => void;
  splitTerminalDown: () => void;
  createNewTerminal: () => void;
  createNewTerminalTab: (terminalId: string) => void;
  moveTerminalToNewGroup: (terminalId: string) => void;
  splitTerminalShortcutLabel: string | null;
  splitTerminalDownShortcutLabel: string | null;
  newTerminalShortcutLabel: string | null;
  closeTerminalShortcutLabel: string | null;
  closeWorkspaceShortcutLabel: string | null;
  activateTerminal: (terminalId: string) => void;
  closeTerminal: (terminalId: string) => void;
  activeThreadId: ThreadId | null;
  storeCloseTerminalGroup: (threadId: ThreadId, groupId: string) => void;
  setTerminalHeight: (height: number) => void;
  storeResizeTerminalSplit: (
    threadId: ThreadId,
    groupId: string,
    splitId: string,
    weights: number[],
  ) => void;
  storeSetTerminalMetadata: (
    threadId: ThreadId,
    terminalId: string,
    metadata: { cliKind: TerminalCliKind | null; label: string },
  ) => void;
  storeSetTerminalActivity: (
    threadId: ThreadId,
    terminalId: string,
    activity: { hasRunningSubprocess: boolean; agentState: TerminalActivityState | null },
  ) => void;
  addTerminalContextToDraft: (selection: TerminalContextSelection) => void;
}

export function useChatTerminalDrawerProps({
  threadId,
  gitCwd,
  activeProject,
  threadTerminalRuntimeEnv,
  terminalState,
  terminalFocusRequestId,
  splitTerminalRight,
  splitTerminalDown,
  createNewTerminal,
  createNewTerminalTab,
  moveTerminalToNewGroup,
  splitTerminalShortcutLabel,
  splitTerminalDownShortcutLabel,
  newTerminalShortcutLabel,
  closeTerminalShortcutLabel,
  closeWorkspaceShortcutLabel,
  activateTerminal,
  closeTerminal,
  activeThreadId,
  storeCloseTerminalGroup,
  setTerminalHeight,
  storeResizeTerminalSplit,
  storeSetTerminalMetadata,
  storeSetTerminalActivity,
  addTerminalContextToDraft,
}: UseChatTerminalDrawerPropsParams) {
  return useMemo(
    () => ({
      threadId,
      cwd: gitCwd ?? activeProject?.cwd ?? "",
      runtimeEnv: threadTerminalRuntimeEnv,
      height: terminalState.terminalHeight,
      terminalIds: terminalState.terminalIds,
      terminalLabelsById: terminalState.terminalLabelsById,
      terminalTitleOverridesById: terminalState.terminalTitleOverridesById,
      terminalCliKindsById: terminalState.terminalCliKindsById,
      terminalAttentionStatesById: terminalState.terminalAttentionStatesById ?? {},
      runningTerminalIds: terminalState.runningTerminalIds,
      activeTerminalId: terminalState.activeTerminalId,
      terminalGroups: terminalState.terminalGroups,
      activeTerminalGroupId: terminalState.activeTerminalGroupId,
      focusRequestId: terminalFocusRequestId,
      onSplitTerminal: splitTerminalRight,
      onSplitTerminalDown: splitTerminalDown,
      onNewTerminal: createNewTerminal,
      onNewTerminalTab: createNewTerminalTab,
      onMoveTerminalToGroup: moveTerminalToNewGroup,
      splitShortcutLabel: splitTerminalShortcutLabel ?? undefined,
      splitDownShortcutLabel: splitTerminalDownShortcutLabel ?? undefined,
      newShortcutLabel: newTerminalShortcutLabel ?? undefined,
      closeShortcutLabel: closeTerminalShortcutLabel ?? undefined,
      workspaceCloseShortcutLabel: closeWorkspaceShortcutLabel ?? undefined,
      onActiveTerminalChange: activateTerminal,
      onCloseTerminal: closeTerminal,
      onCloseTerminalGroup: (groupId: string) => {
        if (!activeThreadId) return;
        storeCloseTerminalGroup(activeThreadId, groupId);
      },
      onHeightChange: setTerminalHeight,
      onResizeTerminalSplit: (groupId: string, splitId: string, weights: number[]) => {
        if (!activeThreadId) return;
        storeResizeTerminalSplit(activeThreadId, groupId, splitId, weights);
      },
      onTerminalMetadataChange: (
        terminalId: string,
        metadata: { cliKind: "codex" | "claude" | null; label: string },
      ) => {
        if (!activeThreadId) return;
        storeSetTerminalMetadata(activeThreadId, terminalId, metadata);
      },
      onTerminalActivityChange: (
        terminalId: string,
        activity: {
          hasRunningSubprocess: boolean;
          agentState: "running" | "attention" | "review" | null;
        },
      ) => {
        if (!activeThreadId) return;
        storeSetTerminalActivity(activeThreadId, terminalId, activity);
      },
      onAddTerminalContext: addTerminalContextToDraft,
    }),
    [
      activeProject?.cwd,
      activateTerminal,
      addTerminalContextToDraft,
      closeTerminal,
      closeTerminalShortcutLabel,
      closeWorkspaceShortcutLabel,
      createNewTerminal,
      createNewTerminalTab,
      moveTerminalToNewGroup,
      gitCwd,
      activeThreadId,
      newTerminalShortcutLabel,
      setTerminalHeight,
      splitTerminalRight,
      splitTerminalDown,
      splitTerminalShortcutLabel,
      splitTerminalDownShortcutLabel,
      storeCloseTerminalGroup,
      storeResizeTerminalSplit,
      storeSetTerminalActivity,
      storeSetTerminalMetadata,
      terminalFocusRequestId,
      terminalState.activeTerminalGroupId,
      terminalState.activeTerminalId,
      terminalState.terminalAttentionStatesById,
      terminalState.terminalCliKindsById,
      terminalState.terminalGroups,
      terminalState.terminalHeight,
      terminalState.terminalIds,
      terminalState.terminalLabelsById,
      terminalState.terminalTitleOverridesById,
      terminalState.runningTerminalIds,
      threadId,
      threadTerminalRuntimeEnv,
    ],
  );
}
