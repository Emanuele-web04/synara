// FILE: OpenThreadTabStrip.tsx
// Purpose: Browser-style tabs for the open threads, shown in the chat header in place of
//          the thread title. Owns what is specific to threads: which tabs exist, the close
//          queue, the optimistic selection, and renaming the active thread.
// Layer: Chat header UI
// Depends on: open-thread tab hooks/store and the shared SurfaceContentTabs.

import type { ProjectId, ThreadId } from "@synara/contracts";
import { useState } from "react";

import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import {
  useActivateThreadTab,
  useOpenThreadTabs,
  useReadRouteThreadId,
  useRecordOpenThreadTab,
} from "~/hooks/useOpenThreadTabs";
import { useOptimisticTabSelection } from "~/hooks/useOptimisticTabSelection";
import { TerminalIcon } from "~/lib/icons";
import { createOpenThreadTabCloseQueue, replaceLastTabWithFreshChat } from "~/openThreadTabs.logic";
import { useOpenThreadTabsStore } from "~/openThreadTabsStore";

import { ProviderIcon } from "../ProviderIcon";
import { ThreadRunningSpinner } from "../ThreadRunningSpinner";
import { toastManager } from "../ui/toast";
import { SurfaceContentTabs } from "./SurfaceContentTabs";

export function OpenThreadTabStrip(props: {
  activeThreadId: ThreadId;
  onRenameActiveThread: () => void;
}) {
  const { activeThreadId } = props;
  useRecordOpenThreadTab(activeThreadId);
  const tabs = useOpenThreadTabs({ activeThreadId });
  const closeThreadTab = useOpenThreadTabsStore((state) => state.closeThreadTab);
  const moveThreadTab = useOpenThreadTabsStore((state) => state.moveThreadTab);
  const activateThreadTab = useActivateThreadTab();
  const { handleNewThread, projects } = useHandleNewThread();
  const readRouteThreadId = useReadRouteThreadId();
  const [enqueueClose] = useState(createOpenThreadTabCloseQueue);
  // The clicked tab paints as active at once, like a selected sidebar row; the
  // thread itself (a whole chat to render) follows once that frame is on screen.
  const {
    shownKey: shownThreadId,
    select: selectTab,
    cancel: cancelTabSelection,
  } = useOptimisticTabSelection({
    activeKey: activeThreadId,
    hasTab: (threadId) => tabs.some((tab) => tab.threadId === threadId),
    activate: activateThreadTab,
  });

  const closeTab = (threadId: ThreadId, projectId: ProjectId) => {
    cancelTabSelection();
    void enqueueClose(() => {
      const openThreadIds = useOpenThreadTabsStore.getState().threadIds;
      return {
        // The tabs as clicked, minus any an earlier queued close has since dropped.
        tabs: tabs.filter((tab) => openThreadIds.includes(tab.threadId)),
        closedThreadId: threadId,
        activeThreadId: readRouteThreadId(),
        closeTab: closeThreadTab,
        openTab: activateThreadTab,
        replaceLastTab: replaceLastTabWithFreshChat(() => {
          const project = projects.find((candidate) => candidate.id === projectId);
          return handleNewThread(projectId, {
            fresh: true,
            // Home and Hubs use their container workspace; ordinary projects keep
            // their chosen local/worktree default through handleNewThread.
            ...(project && project.kind !== "project"
              ? { envMode: "local" as const, branch: null, worktreePath: null }
              : {}),
          });
        }),
        readRouteThreadId,
      };
    }).then((result) => {
      if (!result.ok) {
        toastManager.add({
          type: "error",
          title: "Unable to close the tab",
          description: result.error,
        });
      }
    });
  };

  return (
    <SurfaceContentTabs
      ariaLabel="Open threads"
      activeKey={shownThreadId}
      selectionAria="current"
      onMove={moveThreadTab}
      tabs={tabs.map((tab) => {
        const active = tab.threadId === shownThreadId;
        // A lone unsent draft has nowhere to go: closing it would land on a new chat
        // that is the same draft again.
        const closable = tabs.length > 1 || !tab.isDraft;
        return {
          key: tab.threadId,
          title: tab.title,
          icon:
            // A running thread spins in place of its glyph, like its sidebar row.
            tab.isRunning ? (
              <span role="img" aria-label="Working" className="inline-flex">
                <ThreadRunningSpinner className="size-3.5" />
              </span>
            ) : tab.isTerminal ? (
              <TerminalIcon className="size-3.5 text-[var(--color-text-accent)]" />
            ) : (
              <ProviderIcon provider={tab.provider} className="size-3.5" />
            ),
          onSelect: () => {
            if (!active) selectTab(tab.threadId);
          },
          onClose: closable ? () => closeTab(tab.threadId, tab.projectId) : undefined,
          onTitleDoubleClick:
            tab.threadId === activeThreadId ? props.onRenameActiveThread : undefined,
        };
      })}
    />
  );
}
