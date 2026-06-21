// FILE: _chat.studio.index.tsx
// Purpose: Restores or creates the current Studio chat while reusing the shared chat route surface.
// Layer: Routing
// Depends on: Studio project lookup plus the shared restore/create route surface.

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { RestoreOrCreateChatRoute } from "../components/RestoreOrCreateChatRoute";
import { useHandleNewStudioChat } from "../hooks/useHandleNewStudioChat";
import { isStudioContainerProject } from "../lib/studioProjects";
import { EMPTY_THREAD_IDS, useStore } from "../store";
import { useWorkspaceStore } from "../workspaceStore";

function StudioIndexRouteView() {
  const { handleNewStudioChat } = useHandleNewStudioChat();
  const threadIds = useStore((state) => state.threadIds ?? EMPTY_THREAD_IDS);
  const projects = useStore((state) => state.projects);
  const sidebarThreadSummaryById = useStore((state) => state.sidebarThreadSummaryById);
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
  // Studio can only restore threads that belong to a Studio container project.
  const studioThreadIds = useMemo(
    () =>
      threadIds.filter((threadId) => {
        const summary = sidebarThreadSummaryById[threadId];
        return summary ? studioProjectIds.has(summary.projectId) : false;
      }),
    [sidebarThreadSummaryById, studioProjectIds, threadIds],
  );
  const createFreshChat = useCallback(
    () => handleNewStudioChat({ fresh: true }),
    [handleNewStudioChat],
  );

  return (
    <RestoreOrCreateChatRoute
      restorableThreadIds={studioThreadIds}
      createFreshChat={createFreshChat}
    />
  );
}

export const Route = createFileRoute("/_chat/studio/")({
  component: StudioIndexRouteView,
});
