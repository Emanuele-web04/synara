// FILE: OpenThreadTabStrip.tsx
// Purpose: Browser-style tabs for the open threads, shown in the chat header in place of
//          the thread title. Owns what is specific to threads: which tabs exist, the close
//          queue, the optimistic selection, renaming the active thread, and the tab's
//          context menu (the sidebar's thread menu plus the tab's own close actions).
// Layer: Chat header UI
// Depends on: open-thread tab hooks/store, the shared SurfaceContentTabs, and the sidebar's
//             thread context menu.

import type { ProjectId, ResolvedKeybindingsConfig, ThreadId } from "@synara/contracts";
import { useEffect, useState } from "react";

import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import {
  useActivateThreadTab,
  useOpenThreadTabs,
  useReadRouteThreadId,
  useRecordOpenThreadTab,
} from "~/hooks/useOpenThreadTabs";
import { useOptimisticTabSelection } from "~/hooks/useOptimisticTabSelection";
import { useStableCallback } from "~/hooks/useStableCallback";
import { resolveShortcutCommand } from "~/keybindings";
import { TerminalIcon } from "~/lib/icons";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { showThreadContextMenu } from "~/lib/threadContextMenu";
import { readNativeApi } from "~/nativeApi";
import {
  closeOpenThreadTab,
  closeOpenThreadTabs,
  createOpenThreadTabCloseQueue,
  type OpenThreadTab,
  type OpenThreadTabCloseScope,
  replaceLastTabWithFreshChat,
  resolveOpenThreadTabsInCloseScope,
} from "~/openThreadTabs.logic";
import { useOpenThreadTabsStore } from "~/openThreadTabsStore";

import { ProviderIcon } from "../ProviderIcon";
import { getNextVisibleSidebarThreadId } from "../Sidebar.logic";
import { ThreadRunningSpinner } from "../ThreadRunningSpinner";
import { toastManager } from "../ui/toast";
import { SurfaceContentTabs } from "./SurfaceContentTabs";

const CLOSE_TABS_MENU_ID_PREFIX = "close-tabs:";
const CLOSE_TABS_MENU_ROWS: readonly { scope: OpenThreadTabCloseScope; label: string }[] = [
  { scope: "left", label: "Close Tabs to the Left" },
  { scope: "right", label: "Close Tabs to the Right" },
  { scope: "others", label: "Close Other Tabs" },
];

export function OpenThreadTabStrip(props: {
  activeThreadId: ThreadId;
  keybindings: ResolvedKeybindingsConfig;
  onRenameActiveThread: () => void;
}) {
  const { activeThreadId, keybindings } = props;
  useRecordOpenThreadTab(activeThreadId);
  const tabs = useOpenThreadTabs({ activeThreadId });
  const closeThreadTab = useOpenThreadTabsStore((state) => state.closeThreadTab);
  const pruneThreadTabs = useOpenThreadTabsStore((state) => state.pruneThreadTabs);
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

  // Previous/next tab, wrapping at either end like a browser. Steps from the tab painted
  // as active, so a quick run of presses walks the strip before each thread renders.
  const onKeyDown = useStableCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat) return;
    const command = resolveShortcutCommand(event, keybindings, {
      context: { terminalFocus: isTerminalFocused() },
    });
    if (command !== "threadTab.next" && command !== "threadTab.previous") return;
    event.preventDefault();
    event.stopPropagation();
    const nextThreadId = getNextVisibleSidebarThreadId({
      visibleThreadIds: tabs.map((tab) => tab.threadId),
      activeThreadId: shownThreadId,
      direction: command === "threadTab.previous" ? "backward" : "forward",
    });
    if (nextThreadId && nextThreadId !== shownThreadId) selectTab(nextThreadId);
  });
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  const closeTab = (threadId: ThreadId, projectId: ProjectId) => {
    cancelTabSelection();
    void enqueueClose(() => {
      const openThreadIds = useOpenThreadTabsStore.getState().threadIds;
      return closeOpenThreadTab({
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
      });
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

  const closeTabsInScope = (anchorThreadId: ThreadId, scope: OpenThreadTabCloseScope) => {
    cancelTabSelection();
    void enqueueClose(() => {
      const openThreadIds = useOpenThreadTabsStore.getState().threadIds;
      return closeOpenThreadTabs({
        closedThreadIds: resolveOpenThreadTabsInCloseScope(
          // The tabs as right-clicked, minus any an earlier queued close has since dropped.
          tabs.filter((tab) => openThreadIds.includes(tab.threadId)),
          anchorThreadId,
          scope,
        ),
        keptThreadId: anchorThreadId,
        activeThreadId: readRouteThreadId(),
        closeTabs: (threadIds) => pruneThreadTabs((threadId) => !threadIds.includes(threadId)),
        openTab: activateThreadTab,
        readRouteThreadId,
      });
    });
  };

  const openTabContextMenu = (tab: OpenThreadTab, position: { x: number; y: number }) => {
    // Plain rows in a group of their own, like a browser's tab menu. Only the scopes that
    // have tabs in them are listed: none on a lone tab, and no left (or right) row on the
    // first (or last) tab.
    const closeItems = CLOSE_TABS_MENU_ROWS.filter(
      (row) => resolveOpenThreadTabsInCloseScope(tabs, tab.threadId, row.scope).length > 0,
    ).map((row, index) => ({
      id: `${CLOSE_TABS_MENU_ID_PREFIX}${row.scope}`,
      label: row.label,
      separatorBefore: index === 0,
    }));
    const onCloseAction = (itemId: string) => {
      const row = CLOSE_TABS_MENU_ROWS.find(
        (candidate) => itemId === `${CLOSE_TABS_MENU_ID_PREFIX}${candidate.scope}`,
      );
      if (row) closeTabsInScope(tab.threadId, row.scope);
    };
    if (
      showThreadContextMenu(tab.threadId, position, {
        extraItems: closeItems,
        onExtraAction: onCloseAction,
      })
    ) {
      return;
    }
    // A phone's closed sidebar sheet cannot show thread actions; keep the tab's close rows available.
    const api = readNativeApi();
    if (!api || closeItems.length === 0) return;
    void api.contextMenu.show(closeItems, position).then((itemId) => {
      if (itemId) onCloseAction(itemId);
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
          onClose: () => closeTab(tab.threadId, tab.projectId),
          onTitleDoubleClick:
            tab.threadId === activeThreadId ? props.onRenameActiveThread : undefined,
          onContextMenu: (position) => openTabContextMenu(tab, position),
        };
      })}
    />
  );
}
