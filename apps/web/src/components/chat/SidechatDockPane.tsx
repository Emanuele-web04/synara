// FILE: SidechatDockPane.tsx
// Purpose: The right-dock side chat pane, shared by every dock host: the chat thread's dock
//          (forked sidechats) and the GitHub inbox's dock (standalone sidechats about an item).
//          Renders the embedded chat, and prunes panes whose thread disappeared once the
//          creation-sync grace window has passed.
// Layer: Chat right-dock UI
// Exports: SidechatDockPane, useSidechatDockPanePruning

import type { ThreadId } from "@synara/contracts";
import { useEffect, useSyncExternalStore } from "react";

import type { DockPaneRuntimeMode } from "~/lib/dockPaneActivation";
import { dockSidechatPaneScopeId } from "~/lib/chatPaneScope";
import {
  clearSidechatPaneRetention,
  getSidechatPaneRetentionVersion,
  sidechatPaneRetentionRemainingMs,
  subscribeSidechatPaneRetention,
} from "~/lib/sidechatCreation";
import type { RightDockHostId } from "~/rightDockStore.logic";
import {
  findMissingSidechatPaneIds,
  type RightDockPane,
  type RightDockThreadState,
} from "~/rightDockStore.logic";
import type { SplitViewPanePanelState } from "~/splitViewStore";
import { DeferredChatView, noopChatSurfaceAction } from "./ChatThreadSurfacePrimitives";
import { PanelStateMessage } from "./PanelStateMessage";
import { getRightDockPaneMeta } from "./rightDockPaneMeta";

// Embedded dock chats (side chats) manage their own panels through the dock, so the
// nested ChatView always renders with a closed, inert panel state.
const DOCK_EMBEDDED_PANEL_STATE: SplitViewPanePanelState = {
  panel: null,
  diffTurnId: null,
  diffFilePath: null,
  hasOpenedPanel: false,
  lastOpenPanel: "browser",
};

export function SidechatDockPane({
  pane,
  runtimeMode,
  threadExists,
}: {
  pane: RightDockPane;
  runtimeMode: DockPaneRuntimeMode;
  /** Whether the embedded thread has reached the shell projection yet. */
  threadExists: boolean;
}) {
  if (!pane.threadId) {
    return (
      <PanelStateMessage>
        {getRightDockPaneMeta("sidechat").label} panel is coming soon.
      </PanelStateMessage>
    );
  }
  if (!threadExists) {
    return <PanelStateMessage>Loading side chat...</PanelStateMessage>;
  }
  if (runtimeMode === "preview") {
    return null;
  }
  return (
    <DeferredChatView
      threadId={pane.threadId}
      hideHeader
      paneScopeId={dockSidechatPaneScopeId(pane.id)}
      deferMount={false}
      surfaceMode="split"
      isFocusedPane={false}
      panelState={DOCK_EMBEDDED_PANEL_STATE}
      onToggleDiff={noopChatSurfaceAction}
      onToggleBrowser={noopChatSurfaceAction}
      onOpenBrowserUrl={noopChatSurfaceAction}
      onOpenTurnDiff={noopChatSurfaceAction}
    />
  );
}

/**
 * Closes side chat panes whose thread no longer exists (deleted, or never synced). A pane
 * created moments ago stays while its creation is still syncing, and a restored pane gets one
 * bounded grace window before it is removed.
 */
export function useSidechatDockPanePruning(input: {
  hostId: RightDockHostId;
  dockState: RightDockThreadState;
  existingThreadIds: ReadonlySet<ThreadId>;
  threadsHydrated: boolean;
  closePane: (hostId: RightDockHostId, paneId: string) => void;
}) {
  const { hostId, dockState, existingThreadIds, threadsHydrated, closePane } = input;
  const sidechatPaneRetentionVersion = useSyncExternalStore(
    subscribeSidechatPaneRetention,
    getSidechatPaneRetentionVersion,
    getSidechatPaneRetentionVersion,
  );
  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }
    for (const pane of dockState.panes) {
      if (pane.kind === "sidechat" && pane.threadId && existingThreadIds.has(pane.threadId)) {
        clearSidechatPaneRetention(pane.threadId);
      }
    }
    const missingPaneIds = findMissingSidechatPaneIds(dockState, existingThreadIds);
    if (missingPaneIds.length === 0) {
      return;
    }

    const timerIds: number[] = [];
    for (const paneId of missingPaneIds) {
      const pane = dockState.panes.find((candidate) => candidate.id === paneId);
      const remainingGraceMs = pane?.threadId ? sidechatPaneRetentionRemainingMs(pane.threadId) : 0;
      if (remainingGraceMs === null) {
        continue;
      }
      if (remainingGraceMs <= 0) {
        if (pane?.threadId) {
          clearSidechatPaneRetention(pane.threadId);
        }
        closePane(hostId, paneId);
        continue;
      }
      timerIds.push(
        window.setTimeout(() => {
          if (pane?.threadId) {
            clearSidechatPaneRetention(pane.threadId);
          }
          closePane(hostId, paneId);
        }, remainingGraceMs),
      );
    }
    return () => {
      for (const timerId of timerIds) {
        window.clearTimeout(timerId);
      }
    };
  }, [
    closePane,
    dockState,
    existingThreadIds,
    hostId,
    sidechatPaneRetentionVersion,
    threadsHydrated,
  ]);
}
