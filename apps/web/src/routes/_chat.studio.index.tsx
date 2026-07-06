// FILE: _chat.studio.index.tsx
// Purpose: Landing for the Studio surface — restore the latest Studio chat or its draft, falling
//          back to creating a fresh Studio chat. Reuses the shared restore/create route surface so
//          Studio gets the same empty-bootstrap-snapshot recovery machinery as the home route
//          (a hard refresh or deep link can otherwise land on a briefly-empty snapshot and create
//          a duplicate Studio thread).
// Layer: Routing
// Depends on: Studio project lookup, the shared restore/create route surface, and the Studio
//             new-chat hook.

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { useAppSettings } from "../appSettings";
import {
  RestoreOrCreateChatRoute,
  type RestoreRouteResolver,
} from "../components/RestoreOrCreateChatRoute";
import { sortThreadsForSidebar } from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewStudioChat } from "../hooks/useHandleNewStudioChat";
import { findStudioDraftThreadId, isStudioContainerProject } from "../lib/studioProjects";
import { EMPTY_THREAD_IDS, useStore } from "../store";
import { useWorkspaceStore } from "../workspaceStore";

function StudioIndexRouteView() {
  const { settings: appSettings } = useAppSettings();
  const { handleNewStudioChat } = useHandleNewStudioChat();
  const threadIds = useStore((state) => state.threadIds ?? EMPTY_THREAD_IDS);
  const projects = useStore((state) => state.projects);
  const sidebarThreadSummaryById = useStore((state) => state.sidebarThreadSummaryById);
  const draftThreadsByThreadId = useComposerDraftStore((state) => state.draftThreadsByThreadId);
  const projectDraftThreadIdByProjectId = useComposerDraftStore(
    (state) => state.projectDraftThreadIdByProjectId,
  );
  const homeDir = useWorkspaceStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspaceStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspaceStore((state) => state.studioWorkspaceRoot);

  const studioProjectIds = useMemo(
    () =>
      new Set(
        projects
          .filter((project) =>
            isStudioContainerProject(project, { homeDir, chatWorkspaceRoot, studioWorkspaceRoot }),
          )
          .map((project) => project.id),
      ),
    [chatWorkspaceRoot, homeDir, projects, studioWorkspaceRoot],
  );
  // An existing Studio draft (if any) always wins over restoring a prior thread: reopening it is
  // handled by `handleNewStudioChat` itself (it restores the project's stored draft thread), so
  // the resolver below defers to `createFreshChat` in that case.
  const studioDraftThreadId = useMemo(
    () =>
      findStudioDraftThreadId({
        studioProjectIds,
        projectDraftThreadIdByProjectId,
        draftThreadsByThreadId,
      }),
    [draftThreadsByThreadId, projectDraftThreadIdByProjectId, studioProjectIds],
  );
  // The most recent Studio chat (if any), used to restore the surface instead of always opening
  // a brand-new draft.
  const latestStudioThreadId = useMemo(() => {
    const studioThreads = threadIds.flatMap((threadId) => {
      const summary = sidebarThreadSummaryById[threadId];
      return summary && studioProjectIds.has(summary.projectId) ? [summary] : [];
    });
    return sortThreadsForSidebar(studioThreads, appSettings.sidebarThreadSortOrder)[0]?.id ?? null;
  }, [appSettings.sidebarThreadSortOrder, sidebarThreadSummaryById, studioProjectIds, threadIds]);

  const resolveRestoreRoute = useCallback<RestoreRouteResolver>(() => {
    if (studioDraftThreadId || !latestStudioThreadId) {
      return null;
    }
    return { threadId: latestStudioThreadId };
  }, [latestStudioThreadId, studioDraftThreadId]);

  const createFreshChat = useCallback(() => handleNewStudioChat(), [handleNewStudioChat]);

  return (
    <RestoreOrCreateChatRoute
      resolveRestoreRoute={resolveRestoreRoute}
      createFreshChat={createFreshChat}
    />
  );
}

export const Route = createFileRoute("/_chat/studio/")({
  component: StudioIndexRouteView,
});
