// FILE: _chat.groups.index.tsx
// Purpose: Landing for the Groups surface — restore the last group chat or its draft, falling
//          back to a fresh group chat in the active/first group. Reuses the shared
//          restore/create route surface so Groups gets the same empty-bootstrap-snapshot
//          recovery machinery as the home route (a hard refresh or deep link can otherwise land
//          on a briefly-empty snapshot and create a duplicate group thread). With no groups at
//          all the Groups empty state renders — groups are explicit, never auto-created.
// Layer: Routing
// Depends on: group project lookup, the shared restore/create route surface, and the group
//             new-chat hook.

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useAppSettings } from "../appSettings";
import {
  RestoreOrCreateChatRoute,
  type RestoreRouteResolver,
} from "../components/RestoreOrCreateChatRoute";
import { resolveGroupsListEmptyState } from "../components/SidebarGroupsSurface.logic";
import { sortThreadsForSidebar } from "../components/Sidebar.logic";
import { readSidebarUiState } from "../components/Sidebar.uiState";
import { resolveRestorableThreadRoute } from "../chatRouteRestore";
import { SplashScreen } from "../components/SplashScreen";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewGroupChat } from "../hooks/useHandleNewGroupChat";
import { collectGroupProjectIds, findGroupDraftThreadId } from "../lib/groupProjects";
import { EMPTY_THREAD_IDS, useStore } from "../store";
import { useWorkspacePathsStore } from "../workspacePathsStore";

// How long the splash below waits for the welcome's Groups root before surfacing an error —
// generous next to a normal welcome round-trip, mirroring the home route's eventual error+retry.
const WORKSPACE_PATHS_TIMEOUT_MS = 10_000;

function GroupsIndexRouteView() {
  const { settings: appSettings } = useAppSettings();
  const { handleNewGroupChat } = useHandleNewGroupChat();
  const threadIds = useStore((state) => state.threadIds ?? EMPTY_THREAD_IDS);
  const threadsHydrated = useStore((state) => state.threadsHydrated);
  const projects = useStore((state) => state.projects);
  const sidebarThreadSummaryById = useStore((state) => state.sidebarThreadSummaryById);
  const draftThreadsByThreadId = useComposerDraftStore((state) => state.draftThreadsByThreadId);
  const projectDraftThreadIdByProjectId = useComposerDraftStore(
    (state) => state.projectDraftThreadIdByProjectId,
  );
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((state) => state.studioWorkspaceRoot);
  const groupsWorkspaceRoot = useWorkspacePathsStore((state) => state.groupsWorkspaceRoot);

  const groupProjectIds = collectGroupProjectIds(projects, {
    homeDir,
    chatWorkspaceRoot,
    studioWorkspaceRoot,
    groupsWorkspaceRoot,
  });
  const firstGroupProjectId = projects.find((project) => groupProjectIds.has(project.id))?.id;
  // A group's stored draft (if any). It's a valid remembered-route target below, and when
  // nothing is remembered it wins over the latest thread: the resolver defers to
  // `createFreshChat`, whose `handleNewGroupChat` reopens the stored draft.
  const groupDraftThreadId = findGroupDraftThreadId({
    groupProjectIds,
    projectDraftThreadIdByProjectId,
    draftThreadsByThreadId,
  });
  // Group threads (sidebar summaries) backing both the remembered-route scope and the
  // latest-thread fallback below. Archived chats are excluded — the sidebar hides them, so the
  // landing must not resurrect one; an archived-only group opens the draft or a fresh chat.
  const groupThreadSummaries = threadIds.flatMap((threadId) => {
    const summary = sidebarThreadSummaryById[threadId];
    return summary &&
      (summary.archivedAt ?? null) === null &&
      !summary.sidechatSourceThreadId &&
      groupProjectIds.has(summary.projectId)
      ? [summary]
      : [];
  });
  // The most recent group chat (if any), used to restore the surface instead of always opening
  // a brand-new draft.
  const latestGroupThreadId =
    sortThreadsForSidebar(groupThreadSummaries, appSettings.sidebarThreadSortOrder)[0]?.id ?? null;

  // Same landing policy as the Groups segment switch and settings back: remembered route first
  // (scoped to group threads plus the stored draft), then the stored draft, then the latest
  // group chat — so a refresh or deep link on /groups returns to the chat you last had open.
  const resolveRestoreRoute: RestoreRouteResolver = ({ availableSplitViewIds }) => {
    const availableThreadIds = new Set<string>(groupThreadSummaries.map((thread) => thread.id));
    if (groupDraftThreadId) {
      availableThreadIds.add(groupDraftThreadId);
    }
    const rememberedRoute = resolveRestorableThreadRoute({
      lastThreadRoute: readSidebarUiState().lastThreadRoute,
      availableThreadIds,
      availableSplitViewIds,
    });
    if (rememberedRoute) {
      return rememberedRoute;
    }
    if (groupDraftThreadId || !latestGroupThreadId) {
      return null;
    }
    return { threadId: latestGroupThreadId };
  };

  // Deliberately NOT `{ fresh: true }` (unlike the "/" route): when the resolver returns null
  // because a group draft exists, handleNewGroupChat reopens that stored draft instead of
  // minting a new one per visit — a fresh draft each landing would litter the container.
  const createFreshChat = () => {
    if (!firstGroupProjectId) {
      // No implicit group creation — the Groups empty state below covers this.
      return Promise.resolve({ ok: true as const, threadId: null });
    }
    return handleNewGroupChat(firstGroupProjectId);
  };

  // A hidden Groups tab must never start the restore/create flow: a direct /groups link would
  // otherwise mint a hidden group draft. This route owns the redirect — the sidebar does not
  // also bounce hidden-section views, which could mint a stray home draft.
  const navigate = useNavigate();
  const groupsSectionVisible = appSettings.showGroupsSection;
  useEffect(() => {
    if (!groupsSectionVisible) {
      void navigate({ to: "/", replace: true });
    }
  }, [navigate, groupsSectionVisible]);

  // Don't wait on the splash below forever: if the welcome never delivers a Groups root
  // (connection trouble, or a server that doesn't report one), surface an error with a retry
  // that re-arms the wait — matching how the home route eventually surfaces failures.
  const [pathsWaitTimedOut, setPathsWaitTimedOut] = useState(false);
  useEffect(() => {
    if (groupsWorkspaceRoot || pathsWaitTimedOut) {
      return;
    }
    const timer = window.setTimeout(() => setPathsWaitTimedOut(true), WORKSPACE_PATHS_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [pathsWaitTimedOut, groupsWorkspaceRoot]);

  if (!groupsSectionVisible) {
    return <SplashScreen />;
  }

  const groupsEmptyState = resolveGroupsListEmptyState({
    threadsHydrated,
    groupCount: groupProjectIds.size,
  });
  if (groupsEmptyState === "no-groups") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-sm font-medium text-foreground">No groups yet</p>
        <p className="text-xs text-muted-foreground">
          Create one from the sidebar to coordinate work across repos.
        </p>
      </div>
    );
  }

  // The resolver and `handleNewGroupChat` both read the server welcome's workspace paths.
  // The shared restore/create machinery only guards against an empty *thread* snapshot, so hold
  // the splash until the welcome arrives — otherwise a snapshot that hydrates first would make
  // the resolver miss existing group threads and the fallback create fail against a null root.
  // With no groups at all the empty state above renders regardless of the root.
  if (!groupsWorkspaceRoot) {
    return (
      <SplashScreen
        errorMessage={
          pathsWaitTimedOut
            ? "Groups is taking too long to load — the server has not reported its Groups folder yet."
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

export const Route = createFileRoute("/_chat/groups/")({
  component: GroupsIndexRouteView,
});
