// FILE: useTerminalSurfaceController.ts
// Purpose: Shared terminal-store controller for non-chat terminal surfaces
//          (right-dock terminal pane + workspace page). Owns the store selector
//          slice, the focus-request bump, and the standard create/split/tab/move/
//          activate/close handlers that were duplicated across those surfaces.
// Layer: Web terminal UI hook
// Note: ChatView is intentionally NOT a consumer — it adds split limits, placeholder
//       thread cleanup, and split-view navigation, so it shares only the lower-level
//       terminalSession helpers instead of this controller.

import { type ThreadId } from "@synara/contracts";
import { type TerminalCliKind } from "@synara/shared/terminalThreads";
import { useCallback, useState } from "react";

import { useAppSettings } from "~/appSettings";
import {
  confirmTerminalTabClose,
  resolveTerminalCloseTitle,
  shouldPromptForTerminalClose,
} from "~/lib/terminalCloseConfirmation";
import { readNativeApi } from "~/nativeApi";
import { selectThreadTerminalState, useTerminalStateStore } from "~/terminalStateStore";
import {
  disposeAndCloseTerminalSession,
  randomTerminalId,
} from "~/components/terminal/terminalSession";

type TerminalMetadata = { cliKind: TerminalCliKind | null; label: string };
type TerminalActivity = {
  hasRunningSubprocess: boolean;
  agentState: "running" | "attention" | "review" | null;
};

export function useTerminalSurfaceController(threadId: ThreadId) {
  const { settings } = useAppSettings();
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const openTerminalThreadPage = useTerminalStateStore((s) => s.openTerminalThreadPage);
  const applyWorkspaceLayoutPreset = useTerminalStateStore((s) => s.applyWorkspaceLayoutPreset);
  const newTerminal = useTerminalStateStore((s) => s.newTerminal);
  const newTerminalTab = useTerminalStateStore((s) => s.newTerminalTab);
  const splitTerminalRightStore = useTerminalStateStore((s) => s.splitTerminalRight);
  const splitTerminalDownStore = useTerminalStateStore((s) => s.splitTerminalDown);
  const setActiveTerminalStore = useTerminalStateStore((s) => s.setActiveTerminal);
  const closeTerminalStore = useTerminalStateStore((s) => s.closeTerminal);
  const closeTerminalGroupStore = useTerminalStateStore((s) => s.closeTerminalGroup);
  const setTerminalHeightStore = useTerminalStateStore((s) => s.setTerminalHeight);
  const resizeTerminalSplitStore = useTerminalStateStore((s) => s.resizeTerminalSplit);
  const setTerminalMetadataStore = useTerminalStateStore((s) => s.setTerminalMetadata);
  const setTerminalActivityStore = useTerminalStateStore((s) => s.setTerminalActivity);

  const [focusRequestId, setFocusRequestId] = useState(0);
  const bumpFocusRequest = useCallback(() => setFocusRequestId((value) => value + 1), []);

  const newTerminalGroup = useCallback(() => {
    newTerminal(threadId, randomTerminalId());
    bumpFocusRequest();
  }, [bumpFocusRequest, newTerminal, threadId]);

  const splitRight = useCallback(() => {
    splitTerminalRightStore(threadId, randomTerminalId());
    bumpFocusRequest();
  }, [bumpFocusRequest, splitTerminalRightStore, threadId]);

  const splitDown = useCallback(() => {
    splitTerminalDownStore(threadId, randomTerminalId());
    bumpFocusRequest();
  }, [bumpFocusRequest, splitTerminalDownStore, threadId]);

  const createTerminalTab = useCallback(
    (targetTerminalId: string) => {
      newTerminalTab(threadId, targetTerminalId, randomTerminalId());
      bumpFocusRequest();
    },
    [bumpFocusRequest, newTerminalTab, threadId],
  );

  const moveTerminalToNewGroup = useCallback(
    (terminalId: string) => {
      newTerminal(threadId, terminalId);
      bumpFocusRequest();
    },
    [bumpFocusRequest, newTerminal, threadId],
  );

  const activateTerminal = useCallback(
    (terminalId: string) => {
      setActiveTerminalStore(threadId, terminalId);
      bumpFocusRequest();
    },
    [bumpFocusRequest, setActiveTerminalStore, threadId],
  );

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      const api = readNativeApi();
      const confirmed = await confirmTerminalTabClose({
        api,
        enabled: shouldPromptForTerminalClose({
          confirmationEnabled: settings.confirmTerminalTabClose,
          runningTerminalIds: terminalState.runningTerminalIds,
          terminalAttentionStatesById: terminalState.terminalAttentionStatesById,
          terminalId,
        }),
        terminalTitle: resolveTerminalCloseTitle({
          terminalId,
          terminalLabelsById: terminalState.terminalLabelsById,
          terminalTitleOverridesById: terminalState.terminalTitleOverridesById,
        }),
      });
      if (!confirmed) {
        return;
      }
      disposeAndCloseTerminalSession({ api, threadId, terminalId });
      closeTerminalStore(threadId, terminalId);
      bumpFocusRequest();
    },
    [
      bumpFocusRequest,
      closeTerminalStore,
      settings.confirmTerminalTabClose,
      terminalState.runningTerminalIds,
      terminalState.terminalAttentionStatesById,
      terminalState.terminalLabelsById,
      terminalState.terminalTitleOverridesById,
      threadId,
    ],
  );

  const closeTerminalGroup = useCallback(
    (groupId: string) => closeTerminalGroupStore(threadId, groupId),
    [closeTerminalGroupStore, threadId],
  );

  const setTerminalHeight = useCallback(
    (height: number) => setTerminalHeightStore(threadId, height),
    [setTerminalHeightStore, threadId],
  );

  const resizeTerminalSplit = useCallback(
    (groupId: string, splitId: string, weights: number[]) =>
      resizeTerminalSplitStore(threadId, groupId, splitId, weights),
    [resizeTerminalSplitStore, threadId],
  );

  const setTerminalMetadata = useCallback(
    (terminalId: string, metadata: TerminalMetadata) =>
      setTerminalMetadataStore(threadId, terminalId, metadata),
    [setTerminalMetadataStore, threadId],
  );

  const setTerminalActivity = useCallback(
    (terminalId: string, activity: TerminalActivity) =>
      setTerminalActivityStore(threadId, terminalId, activity),
    [setTerminalActivityStore, threadId],
  );

  return {
    terminalState,
    focusRequestId,
    bumpFocusRequest,
    openTerminalThreadPage,
    applyWorkspaceLayoutPreset,
    newTerminalGroup,
    splitRight,
    splitDown,
    createTerminalTab,
    moveTerminalToNewGroup,
    activateTerminal,
    closeTerminal,
    closeTerminalGroup,
    setTerminalHeight,
    resizeTerminalSplit,
    setTerminalMetadata,
    setTerminalActivity,
  };
}
