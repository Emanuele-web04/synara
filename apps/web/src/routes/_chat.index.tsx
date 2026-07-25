// FILE: _chat.index.tsx
// Purpose: Restores the last chat route on app launch, falling back to a fresh home-chat draft.
//          Also the landing for a Space that has nothing to open.
// Layer: Routing
// Depends on: the shared restore/create route surface plus the home-chat new-chat handler.

import { SpaceId, type ProjectId } from "@synara/contracts";
import { createFileRoute } from "@tanstack/react-router";

import {
  RestoreOrCreateChatRoute,
  type RestoreRouteResolver,
} from "../components/RestoreOrCreateChatRoute";
import { readSidebarUiState } from "../components/Sidebar.uiState";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { VOID_SPACE_KEY } from "../lib/spaceGrouping";
import { collectStudioProjectIds } from "../lib/studioProjects";
import { resolveSplitViewThreadIds, useSplitViewStore } from "../splitViewStore";
import { EMPTY_THREAD_IDS, useStore } from "../store";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { resolveChatIndexRestoreRoute, type ChatIndexLandingSpace } from "./-chatIndexRoute.logic";

/**
 * Set by the Space switcher when the selected Space has nothing to open (`spaceKey`, so Void
 * survives as a string). It scopes the restore below to that Space — without it this landing
 * happily reopens the *previous* Space's thread, and the route-to-Space sync then writes that
 * Space back over the user's click.
 */
export interface ChatIndexSearch {
  readonly space?: string | undefined;
}

function ChatIndexRouteView() {
  const { handleNewChat } = useHandleNewChat();
  const landingSpaceKey = Route.useSearch({ select: (search) => search.space });
  const threadIds = useStore((state) => state.threadIds ?? EMPTY_THREAD_IDS);
  const projects = useStore((state) => state.projects);
  const sidebarThreadSummaryById = useStore((state) => state.sidebarThreadSummaryById);
  const draftThreadsByThreadId = useComposerDraftStore((state) => state.draftThreadsByThreadId);
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((state) => state.studioWorkspaceRoot);
  // A Space landing reuses the stored home-chat draft instead of minting one (same reasoning as
  // the /studio landing): a fresh draft per visit would litter the Chats container every time
  // someone clicked through their empty Spaces.
  const createFreshChat = () =>
    landingSpaceKey === undefined ? handleNewChat({ fresh: true }) : handleNewChat();

  const workspacePaths = { homeDir, chatWorkspaceRoot, studioWorkspaceRoot };
  // Home chats restore the last visited route, except Studio threads — those belong to the
  // /studio surface, and restoring one from "/" would silently switch the user into the Studio
  // segment. A Studio lastThreadRoute falls through to a fresh home-chat draft instead.
  const studioProjectIds = collectStudioProjectIds(projects, workspacePaths);
  // Only plain, still-unsent chat drafts qualify as restore targets: a non-"chat" entry point
  // isn't a home-chat draft, and `promotedTo` means the draft already became a real thread, so
  // its stale id is no longer valid (matches the filtering findStudioDraftThreadId applies).
  const draftProjectIdByThreadId = new Map<string, ProjectId>();
  for (const [threadId, draft] of Object.entries(draftThreadsByThreadId)) {
    if (draft.entryPoint === "chat" && draft.promotedTo === undefined) {
      draftProjectIdByThreadId.set(threadId, draft.projectId);
    }
  }

  const landingSpace: ChatIndexLandingSpace | null =
    landingSpaceKey === undefined
      ? null
      : {
          spaceId: landingSpaceKey === VOID_SPACE_KEY ? null : SpaceId.makeUnsafe(landingSpaceKey),
          projectById: new Map(projects.map((project) => [project.id, project])),
          workspacePaths,
        };

  const resolveRestoreRoute: RestoreRouteResolver = ({ availableSplitViewIds }) => {
    const lastThreadRoute = readSidebarUiState().lastThreadRoute;
    const rememberedSplitView = lastThreadRoute?.splitViewId
      ? useSplitViewStore.getState().splitViewsById[lastThreadRoute.splitViewId]
      : undefined;
    return resolveChatIndexRestoreRoute({
      lastThreadRoute,
      availableSplitViewIds,
      threadIds,
      sidebarThreadSummaryById,
      studioProjectIds,
      draftProjectIdByThreadId,
      rememberedSplitViewThreadIds: rememberedSplitView
        ? resolveSplitViewThreadIds(rememberedSplitView)
        : undefined,
      landingSpace,
    });
  };

  return (
    <RestoreOrCreateChatRoute
      resolveRestoreRoute={resolveRestoreRoute}
      createFreshChat={createFreshChat}
    />
  );
}

export const Route = createFileRoute("/_chat/")({
  validateSearch: (raw: Record<string, unknown>): ChatIndexSearch =>
    typeof raw.space === "string" && raw.space.length > 0 ? { space: raw.space } : {},
  component: ChatIndexRouteView,
});
