// FILE: GitHubInboxSidechatDock.tsx
// Purpose: The inbox page's right dock: the selected item's side chat (Ask), rendered by the
//          same side chat pane the chat thread's dock uses. With no side chat for the item yet,
//          an open dock offers "Ask about …" instead.
// Layer: GitHub inbox presentation
// Exports: GitHubInboxSidechatDock

import { useMemo } from "react";

import { RightDock } from "~/components/chat/RightDock";
import {
  buildRightDockPaneLabelOverrides,
  type RightDockLauncherItem,
} from "~/components/chat/rightDockPaneMeta";
import { SidechatDockPane, useSidechatDockPanePruning } from "~/components/chat/SidechatDockPane";
import { ChatBubbleIcon } from "~/lib/icons";
import { useRightDockStore } from "~/rightDockStore";
import { GITHUB_INBOX_DOCK_HOST_ID, type RightDockThreadState } from "~/rightDockStore.logic";
import { useStore } from "~/store";
import { createSidebarThreadSummariesSelector } from "~/storeSelectors";
import type { GitHubInboxSelection } from "./githubInbox.logic";

const acceptAnyDockWidth = () => true;

// With Ask open the page is three even columns: list, detail, and this dock each take a third
// (GitHubInbox keeps the list at half of what the dock leaves). The floor is the narrowest width
// at which the side chat's composer footer still fits without clipping its controls.
const CODE_REVIEW_DOCK_OPEN_FRACTION = 1 / 3;
const CODE_REVIEW_DOCK_MIN_WIDTH = 18 * 16;
const CODE_REVIEW_DOCK_DEFAULT_WIDTH = "max(18rem, calc(100vw / 3))";

export function GitHubInboxSidechatDock({
  dockState,
  selection,
  onAskSelected,
  onNewSidechat,
}: {
  dockState: RightDockThreadState;
  selection: GitHubInboxSelection;
  onAskSelected: () => void;
  /** A new side chat about the selected item, beside the one shown. */
  onNewSidechat: () => void;
}) {
  const closePane = useRightDockStore((store) => store.closePane);
  const setDockOpen = useRightDockStore((store) => store.setDockOpen);
  // Tab labels need only titles, so the coarse summary selector keeps streaming tokens in the
  // side chat from re-rendering the whole inbox.
  const threadSummaries = useStore(useMemo(() => createSidebarThreadSummariesSelector(), []));
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const existingThreadIds = useMemo(
    () => new Set(threadSummaries.map((thread) => thread.id)),
    [threadSummaries],
  );
  useSidechatDockPanePruning({
    hostId: GITHUB_INBOX_DOCK_HOST_ID,
    dockState,
    existingThreadIds,
    threadsHydrated,
    closePane,
  });
  const paneLabelOverrides = useMemo(
    () => buildRightDockPaneLabelOverrides(dockState.panes, threadSummaries),
    [dockState.panes, threadSummaries],
  );
  const launcherItems: readonly RightDockLauncherItem[] = [
    {
      kind: "sidechat",
      Icon: ChatBubbleIcon,
      label: `Ask about ${selection.kind === "issue" ? "issue" : "PR"} #${selection.number}`,
    },
  ];

  return (
    <RightDock
      state={dockState}
      minWidth={CODE_REVIEW_DOCK_MIN_WIDTH}
      defaultWidth={CODE_REVIEW_DOCK_DEFAULT_WIDTH}
      openWidthFraction={CODE_REVIEW_DOCK_OPEN_FRACTION}
      shouldAcceptWidth={acceptAnyDockWidth}
      addMenuKinds={[]}
      launcherItems={launcherItems}
      addAction={{ label: "New side chat", onClick: onNewSidechat }}
      motionKey={GITHUB_INBOX_DOCK_HOST_ID}
      {...(paneLabelOverrides ? { paneLabelOverrides } : {})}
      onClosePane={(paneId) => closePane(GITHUB_INBOX_DOCK_HOST_ID, paneId)}
      onCollapse={() => setDockOpen(GITHUB_INBOX_DOCK_HOST_ID, false)}
      onOpenChange={(open) => setDockOpen(GITHUB_INBOX_DOCK_HOST_ID, open)}
      onAddPane={onAskSelected}
      renderPane={(pane, context) =>
        pane.kind === "sidechat" ? (
          <SidechatDockPane
            pane={pane}
            runtimeMode={context.runtimeMode}
            threadExists={pane.threadId !== null && existingThreadIds.has(pane.threadId)}
          />
        ) : null
      }
    />
  );
}
