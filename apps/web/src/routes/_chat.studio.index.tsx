import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useAppSettings } from "../appSettings";
import {
  RestoreOrCreateChatRoute,
  type RestoreRouteResolver,
} from "../components/RestoreOrCreateChatRoute";
import { sortThreadsForSidebar } from "../components/Sidebar.logic";
import { readSidebarUiState } from "../components/Sidebar.uiState";
import { resolveRestorableThreadRoute } from "../chatRouteRestore";
import { SplashScreen } from "../components/SplashScreen";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewStudioChat } from "../hooks/useHandleNewStudioChat";
import { collectStudioProjectIds, findStudioDraftThreadId } from "../lib/studioProjects";
import { EMPTY_THREAD_IDS, useStore } from "../store";
import { useWorkspacePathsStore } from "../workspacePathsStore";

const WORKSPACE_PATHS_TIMEOUT_MS = 10_000;

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
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((state) => state.studioWorkspaceRoot);

  const studioProjectIds = collectStudioProjectIds(projects, {
    homeDir,
    chatWorkspaceRoot,
    studioWorkspaceRoot,
  });
  // the stored draft wins over the latest thread when nothing is remembered — the resolver defers to createFreshChat, which reopens it
  const studioDraftThreadId = findStudioDraftThreadId({
    studioProjectIds,
    projectDraftThreadIdByProjectId,
    draftThreadsByThreadId,
  });
  // archived chats are excluded — the landing must not resurrect one; an archived-only Studio opens the draft or a fresh chat
  const studioThreadSummaries = threadIds.flatMap((threadId) => {
    const summary = sidebarThreadSummaryById[threadId];
    return summary &&
      (summary.archivedAt ?? null) === null &&
      !summary.sidechatSourceThreadId &&
      studioProjectIds.has(summary.projectId)
      ? [summary]
      : [];
  });
  const latestStudioThreadId =
    sortThreadsForSidebar(studioThreadSummaries, appSettings.sidebarThreadSortOrder)[0]?.id ?? null;

  const resolveRestoreRoute: RestoreRouteResolver = ({ availableSplitViewIds }) => {
    const availableThreadIds = new Set<string>(studioThreadSummaries.map((thread) => thread.id));
    if (studioDraftThreadId) {
      availableThreadIds.add(studioDraftThreadId);
    }
    const rememberedRoute = resolveRestorableThreadRoute({
      lastThreadRoute: readSidebarUiState().lastThreadRoute,
      availableThreadIds,
      availableSplitViewIds,
    });
    if (rememberedRoute) {
      return rememberedRoute;
    }
    if (studioDraftThreadId || !latestStudioThreadId) {
      return null;
    }
    return { threadId: latestStudioThreadId };
  };

  // deliberately NOT fresh:true — when a stored Studio draft exists, handleNewStudioChat reopens it instead of minting a new draft per visit (which would litter the hidden container)
  const createFreshChat = () => handleNewStudioChat();

  // A hidden Studio tab must never start the restore/create flow: a direct /studio link would otherwise race the sidebar's hidden-section redirect and could mint a hidden Studio draft.
  const navigate = useNavigate();
  const studioSectionVisible = appSettings.showStudioSection;
  useEffect(() => {
    if (!studioSectionVisible) {
      void navigate({ to: "/", replace: true });
    }
  }, [navigate, studioSectionVisible]);

  // don't wait on the splash forever — if the welcome never delivers a Studio root, surface an error + retry that re-arms the wait
  const [pathsWaitTimedOut, setPathsWaitTimedOut] = useState(false);
  useEffect(() => {
    if (studioWorkspaceRoot || pathsWaitTimedOut) {
      return;
    }
    const timer = window.setTimeout(() => setPathsWaitTimedOut(true), WORKSPACE_PATHS_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [pathsWaitTimedOut, studioWorkspaceRoot]);

  if (!studioSectionVisible) {
    return <SplashScreen />;
  }

  // the shared machinery only guards an empty *thread* snapshot — hold the splash until the welcome arrives or hydration makes the resolver miss Studio threads and the create fails on a null root
  if (!studioWorkspaceRoot) {
    return (
      <SplashScreen
        errorMessage={
          pathsWaitTimedOut
            ? "Studio is taking too long to load — the server has not reported its Studio folder yet."
            : null
        }
        onRetry={pathsWaitTimedOut ? () => setPathsWaitTimedOut(false) : null}
      />
    );
  }

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
