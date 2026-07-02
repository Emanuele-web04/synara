// FILE: _chat.studio.index.tsx
// Purpose: Landing for the Studio surface — restore the latest Studio chat, or open a fresh one.
// Layer: Routing
// Depends on: Studio project lookup plus the Studio new-chat hook.
//
// Studio is a secondary surface reached by clicking the segment (threads are already hydrated),
// so it intentionally skips the cold-start remembered-route recovery dance the primary "/" route
// needs. Keeping it simple and direct avoids the silent-splash hangs that machinery can cause.

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAppSettings } from "../appSettings";
import { sortThreadsForSidebar } from "../components/Sidebar.logic";
import { SplashScreen } from "../components/SplashScreen";
import { useHandleNewStudioChat } from "../hooks/useHandleNewStudioChat";
import { isStudioContainerProject } from "../lib/studioProjects";
import { EMPTY_THREAD_IDS, useStore } from "../store";
import { useWorkspaceStore } from "../workspaceStore";

function StudioIndexRouteView() {
  const { settings: appSettings } = useAppSettings();
  const { handleNewStudioChat } = useHandleNewStudioChat();
  const navigate = useNavigate();
  const threadsHydrated = useStore((store) => store.threadsHydrated);
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
  // The most recent Studio chat (if any), used to restore the surface instead of always opening
  // a brand-new draft.
  const latestStudioThreadId = useMemo(() => {
    const studioThreads = threadIds.flatMap((threadId) => {
      const summary = sidebarThreadSummaryById[threadId];
      return summary && studioProjectIds.has(summary.projectId) ? [summary] : [];
    });
    return sortThreadsForSidebar(studioThreads, appSettings.sidebarThreadSortOrder)[0]?.id ?? null;
  }, [appSettings.sidebarThreadSortOrder, sidebarThreadSummaryById, studioProjectIds, threadIds]);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const initiatedAttemptRef = useRef(-1);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }
    // Run exactly once per attempt (retry bumps `attempt`), even as memoized inputs settle.
    if (initiatedAttemptRef.current === attempt) {
      return;
    }
    initiatedAttemptRef.current = attempt;

    let cancelled = false;
    setErrorMessage(null);

    void (async () => {
      try {
        if (latestStudioThreadId) {
          await navigate({
            to: "/$threadId",
            params: { threadId: latestStudioThreadId },
            replace: true,
          });
          return;
        }
        const result = await handleNewStudioChat({ fresh: true });
        if (!cancelled && !result.ok) {
          setErrorMessage(result.error);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : "Unable to open Studio.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt, handleNewStudioChat, latestStudioThreadId, navigate, threadsHydrated]);

  return (
    <SplashScreen
      errorMessage={errorMessage}
      onRetry={errorMessage ? () => setAttempt((value) => value + 1) : null}
    />
  );
}

export const Route = createFileRoute("/_chat/studio/")({
  component: StudioIndexRouteView,
});
