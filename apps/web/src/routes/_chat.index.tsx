// FILE: _chat.index.tsx
// Purpose: Restores the last chat route on app launch, falling back to a fresh home-chat draft.
// Layer: Routing
// Depends on: the shared restore/create route surface plus the home-chat new-chat handler.

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import {
  RestoreOrCreateChatRoute,
  type RestoreRouteResolver,
} from "../components/RestoreOrCreateChatRoute";
import { readSidebarUiState } from "../components/Sidebar.uiState";
import { resolveRestorableThreadRoute } from "../chatRouteRestore";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { collectStudioProjectIds } from "../lib/studioProjects";
import { EMPTY_THREAD_IDS, useStore } from "../store";
import { useWorkspaceStore } from "../workspaceStore";

function ChatIndexRouteView() {
  const { handleNewChat } = useHandleNewChat();
  const threadIds = useStore((state) => state.threadIds ?? EMPTY_THREAD_IDS);
  const projects = useStore((state) => state.projects);
  const sidebarThreadSummaryById = useStore((state) => state.sidebarThreadSummaryById);
  const homeDir = useWorkspaceStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspaceStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspaceStore((state) => state.studioWorkspaceRoot);
  const createFreshChat = useCallback(() => handleNewChat({ fresh: true }), [handleNewChat]);

  // Home chats restore the last visited route, except Studio threads — those belong to the
  // /studio surface, and restoring one from "/" would silently switch the user into the Studio
  // segment. A Studio lastThreadRoute falls through to a fresh home-chat draft instead.
  const studioProjectIds = useMemo(
    () => collectStudioProjectIds(projects, { homeDir, chatWorkspaceRoot, studioWorkspaceRoot }),
    [chatWorkspaceRoot, homeDir, projects, studioWorkspaceRoot],
  );
  const resolveRestoreRoute = useCallback<RestoreRouteResolver>(
    ({ availableSplitViewIds }) =>
      resolveRestorableThreadRoute({
        lastThreadRoute: readSidebarUiState().lastThreadRoute,
        availableThreadIds: new Set(
          threadIds.filter((threadId) => {
            // Fail closed: a thread we can't classify is not restorable from "/". Summaries are
            // built from the same snapshot as threadIds, so this only ever excludes a thread if
            // that invariant breaks — and then a fresh draft beats restoring into the wrong
            // segment.
            const summary = sidebarThreadSummaryById[threadId];
            return summary !== undefined && !studioProjectIds.has(summary.projectId);
          }),
        ),
        availableSplitViewIds,
      }),
    [sidebarThreadSummaryById, studioProjectIds, threadIds],
  );

  return (
    <RestoreOrCreateChatRoute
      resolveRestoreRoute={resolveRestoreRoute}
      createFreshChat={createFreshChat}
    />
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
