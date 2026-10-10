// Shared lifecycle and metadata for a single terminal panel.

import { type ThreadId } from "@synara/contracts";
import { type TerminalCliKind } from "@synara/shared/terminalThreads";
import { useState } from "react";

import {
  confirmTerminalTabClose,
  resolveTerminalCloseTitle,
  shouldPromptForTerminalClose,
} from "~/lib/terminalCloseConfirmation";
import { readNativeApi } from "~/nativeApi";
import { selectThreadTerminalState, useTerminalStateStore } from "~/terminalStateStore";
import { disposeAndCloseTerminalSession } from "~/components/terminal/terminalSession";

type TerminalMetadata = { cliKind: TerminalCliKind | null; label: string };
type TerminalActivity = {
  hasRunningSubprocess: boolean;
  agentState: "running" | "attention" | "review" | null;
};

export function useTerminalSurfaceController(threadId: ThreadId) {
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const openTerminalThreadPage = useTerminalStateStore((s) => s.openTerminalThreadPage);
  const closeExitedTerminalStore = useTerminalStateStore((s) => s.closeExitedTerminal);
  const setTerminalMetadataStore = useTerminalStateStore((s) => s.setTerminalMetadata);
  const setTerminalActivityStore = useTerminalStateStore((s) => s.setTerminalActivity);

  const [focusRequestId, setFocusRequestId] = useState(0);
  const bumpFocusRequest = () => setFocusRequestId((value) => value + 1);

  const disposeExitedTerminal = (terminalId: string) => {
    disposeAndCloseTerminalSession({
      api: readNativeApi(),
      threadId,
      terminalId,
      processAlreadyExited: true,
    });
  };

  const handleTerminalSessionExited = (terminalId: string) => {
    disposeExitedTerminal(terminalId);
    closeExitedTerminalStore(threadId, terminalId);
    bumpFocusRequest();
  };

  const handleDockTerminalSessionExited = (terminalId: string) => {
    disposeExitedTerminal(terminalId);
    const disposition = closeExitedTerminalStore(threadId, terminalId);
    bumpFocusRequest();
    return disposition;
  };

  const setTerminalMetadata = (terminalId: string, metadata: TerminalMetadata) =>
    setTerminalMetadataStore(threadId, terminalId, metadata);

  const setTerminalActivity = (terminalId: string, activity: TerminalActivity) =>
    setTerminalActivityStore(threadId, terminalId, activity);

  return {
    terminalState,
    focusRequestId,
    bumpFocusRequest,
    openTerminalThreadPage,
    handleTerminalSessionExited,
    handleDockTerminalSessionExited,
    setTerminalMetadata,
    setTerminalActivity,
  };
}

export async function closeTerminalSurface(
  threadId: ThreadId,
  confirmationEnabled: boolean,
  paneId?: string,
) {
  const store = useTerminalStateStore.getState();
  const terminalState = selectThreadTerminalState(store.terminalStateByThreadId, threadId);
  const terminalId =
    paneId && terminalState.dockTerminalIdsByPaneId
      ? terminalState.dockTerminalIdsByPaneId[paneId]
      : terminalState.activeTerminalId;
  if (!terminalId) return true;
  const api = readNativeApi();
  const confirmed = await confirmTerminalTabClose({
    api,
    enabled: shouldPromptForTerminalClose({
      confirmationEnabled,
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
    return false;
  }
  await disposeAndCloseTerminalSession({ api, threadId, terminalId, requireStructuredClose: true });
  store.closeTerminal(threadId, terminalId);
  return true;
}
