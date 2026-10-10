// FILE: _chat.pull-requests.index.tsx
// Purpose: The Inbox route (`/pull-requests`, kept so links and persisted nav state survive):
//          validates the URL, owns the route shell and header, and hands the page body to
//          GitHubInbox. The shell is a flex row: the Ask side chat docks beside the inset.
// Layer: Route

import { createFileRoute, useNavigate } from "@tanstack/react-router";

import {
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
  CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";
import { GitHubInbox } from "~/components/githubInbox/GitHubInbox";
import { GitHubInboxSidechatDock } from "~/components/githubInbox/GitHubInboxSidechatDock";
import {
  githubInboxSelection,
  mergeGitHubInboxSearch,
  parseGitHubInboxSearch,
  type GitHubInboxSearch,
  type GitHubInboxSearchPatch,
} from "~/components/githubInbox/githubInbox.logic";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { RouteSurfaceHeader } from "~/components/RouteSurface";
import { useGitHubInboxSidechat } from "~/components/githubInbox/useGitHubInboxSidechat";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/_chat/pull-requests/")({
  validateSearch: (raw: Record<string, unknown>): GitHubInboxSearch => parseGitHubInboxSearch(raw),
  component: GitHubInboxRouteView,
});

function GitHubInboxRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const updateSearch = (patch: GitHubInboxSearchPatch) =>
    void navigate({
      search: (previous) => mergeGitHubInboxSearch(previous, patch),
      replace: true,
    });
  const selection = githubInboxSelection(search);
  const sidechat = useGitHubInboxSidechat(selection);

  return (
    <div className={cn(CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME, CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME)}>
      <RouteInsetSurface surfaceClassName="bg-transparent">
        <div
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
            CHAT_BACKGROUND_CLASS_NAME,
          )}
        >
          {/* Like Settings: the title lives at the top of the list column, so this strip only
              holds the sidebar toggle (shown while the sidebar is collapsed) and stays a drag
              region. */}
          <RouteSurfaceHeader
            divider={false}
            className="app-top-bar shrink-0"
            // Keeps the shell band's height even though the strip holds only the toggle.
            rowClassName="h-[var(--app-top-strip-height)]"
          />
          <GitHubInbox
            search={search}
            onSearchChange={updateSearch}
            sidechat={sidechat}
            dockOpen={selection !== null && sidechat.dockState.open}
          />
        </div>
      </RouteInsetSurface>
      {selection ? (
        <GitHubInboxSidechatDock
          dockState={sidechat.dockState}
          selection={selection}
          onAskSelected={sidechat.askSelected}
          onNewSidechat={sidechat.newSidechat}
        />
      ) : null}
    </div>
  );
}
