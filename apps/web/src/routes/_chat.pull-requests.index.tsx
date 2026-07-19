import type {
  OrchestrationWorktreeWorkspace,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestState,
} from "@synara/contracts";
import {
  coalescePullRequestListEntries,
  isValidGitHubRepositoryNameWithOwner,
} from "@synara/shared/githubRepository";
import { findWorkspaceForPullRequest } from "@synara/shared/pullRequest";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";

import { useAppSettings } from "~/appSettings";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "~/components/chat/chatHeaderControls";
import {
  CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
  CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";
import {
  RIGHT_DOCK_DEFAULT_WIDTH,
  RIGHT_DOCK_MIN_WIDTH,
  RightDock,
} from "~/components/chat/RightDock";
import { PanelStateMessage } from "~/components/chat/PanelStateMessage";
import { buildReviewPullRequestPrompt } from "~/components/chat/environment/environmentPullRequest.logic";
import { pullRequestPaneTabLabel } from "~/components/pullRequest/pullRequestDetail.logic";
import {
  normalizePullRequestInvolvement,
  normalizePullRequestState,
  PULL_REQUEST_INVOLVEMENT_TABS,
  PULL_REQUEST_STATE_TABS,
} from "~/components/pullRequest/pullRequestBrowser.logic";
import {
  focusPullRequestRow,
  isFocusInsideRightDock,
} from "~/components/pullRequest/pullRequestFocus";
import { PullRequestList } from "~/components/pullRequest/PullRequestList";
import type { PullRequestRowContextMenuActionId } from "~/components/pullRequest/PullRequestRowContextMenu";
import {
  filterPullRequestEntriesByInvolvement,
  groupPullRequestEntriesByInvolvement,
  matchesPullRequestSearchQuery,
  orderPullRequestEntriesPinnedFirst,
  pullRequestPinToggleInputs,
  pullRequestListEntryKey,
  pullRequestWorkspaceAssociation,
  type PullRequestWorkspaceAssociation,
} from "~/components/pullRequest/pullRequestList.logic";
import {
  PullRequestFilterPillGroup,
  PullRequestProjectFilterPopover,
} from "~/components/pullRequest/PullRequestListFilters";
import { PullRequestsUnavailableState } from "~/components/pullRequest/PullRequestsUnavailableState";
import { usePullRequestPaneStateIcon } from "~/components/pullRequest/usePullRequestPaneStateIcon";
import { PullRequestWarningNote } from "~/components/pullRequest/PullRequestWarningNote";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { SearchInput } from "~/components/ui/search-input";
import { Skeleton } from "~/components/ui/skeleton";
import { toastManager } from "~/components/ui/toast";
import { appendComposerPromptText } from "~/lib/chatReferences";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { RefreshCwIcon } from "~/lib/icons";
import { openPullRequestWorkspace, pullRequestWorkspaceMetadata } from "~/lib/pullRequestWorkspace";
import {
  prefetchPullRequestListState,
  pullRequestDetailQueryOptions,
  pullRequestMutationKeys,
  pullRequestQueryErrorState,
  pullRequestsExactInvolvementQueryOptions,
  pullRequestsForceRefreshMutationOptions,
  pullRequestsListQueryOptions,
  pullRequestSetPinnedMutationOptions,
  shouldLoadExactPullRequestInvolvement,
} from "~/lib/pullRequestReactQuery";
import { requestWorkspaceArchive } from "~/lib/workspaceLifecycle";
import { ensureNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import {
  createDefaultRightDockState,
  openPaneInState,
  type RightDockThreadState,
} from "~/rightDockStore.logic";
import { useStore } from "~/store";
import { PR_FINE_TEXT_CLASS_NAME } from "~/components/pullRequest/pullRequestText";

export interface PullRequestsSearch {
  involvement: PullRequestInvolvement;
  state: PullRequestState;
  projectId?: ProjectId;
  selectedProjectId?: ProjectId;
  selectedRepo?: string;
  number?: number;
  q?: string;
}

interface PullRequestsSearchPatch {
  involvement?: PullRequestInvolvement;
  state?: PullRequestState;
  projectId?: ProjectId | undefined;
  selectedProjectId?: ProjectId | undefined;
  selectedRepo?: string | undefined;
  number?: number | undefined;
  q?: string | undefined;
}

// Every filter change and the panel close drop the current selection the same way; keep the
// patch in one place so a new selection field can't be forgotten by one of the call sites.
const CLEARED_SELECTION = {
  selectedProjectId: undefined,
  selectedRepo: undefined,
  number: undefined,
} as const satisfies PullRequestsSearchPatch;

// The route hosts a single dock pane; a stable id keeps the dock tab's identity across pull
// request switches (the detail panel itself remounts via PullRequestDockPane's key).
const PULL_REQUESTS_ROUTE_PANE_ID = "pull-requests-route:pull-request";
const EMPTY_WORKTREE_WORKSPACES: readonly OrchestrationWorktreeWorkspace[] = [];
const PullRequestDockPane = lazy(() => import("~/components/pullRequest/PullRequestDockPane"));

export const Route = createFileRoute("/_chat/pull-requests/")({
  validateSearch: (raw): PullRequestsSearch => ({
    involvement: normalizePullRequestInvolvement(raw.involvement),
    state: normalizePullRequestState(raw.state),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
    ...(typeof raw.selectedProjectId === "string" && raw.selectedProjectId
      ? { selectedProjectId: raw.selectedProjectId as ProjectId }
      : {}),
    ...(typeof raw.selectedRepo === "string" &&
    isValidGitHubRepositoryNameWithOwner(raw.selectedRepo)
      ? { selectedRepo: raw.selectedRepo.trim() }
      : {}),
    ...(typeof raw.number === "number" && Number.isInteger(raw.number) && raw.number > 0
      ? { number: raw.number }
      : {}),
    ...(typeof raw.q === "string" && raw.q ? { q: raw.q.slice(0, 200) } : {}),
  }),
  component: PullRequestsRouteView,
});

function PullRequestsRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const trafficLightGutter = useDesktopTopBarTrafficLightGutterClassName();
  const windowControlsGutter = useDesktopTopBarWindowControlsGutterClassName();
  const { settings } = useAppSettings();
  const projects = useStore((store) => store.projects);
  const worktreeWorkspaces = useStore(
    (store) => store.worktreeWorkspaces ?? EMPTY_WORKTREE_WORKSPACES,
  );
  const syncServerWorkspaceShellSnapshot = useStore(
    (store) => store.syncServerWorkspaceShellSnapshot,
  );
  const queryClient = useQueryClient();
  // One fetch per (state, project): the server returns the "all" involvement superset and the
  // Reviewing/Authored tabs are derived below, so involvement switches never hit the network.
  // Manual memoization kept: this file does not compile under React Compiler (see compile-report).
  const listInput = useMemo(
    () => ({ state: search.state, projectId: search.projectId ?? null }),
    [search.projectId, search.state],
  );
  const listQuery = useQuery(pullRequestsListQueryOptions(listInput));
  const refreshMutation = useMutation(pullRequestsForceRefreshMutationOptions(queryClient));
  const pinMutation = useMutation(pullRequestSetPinnedMutationOptions(queryClient));
  const mutateRefresh = refreshMutation.mutate;
  const mutatePin = pinMutation.mutate;
  const activeActionCount = useIsMutating({ mutationKey: pullRequestMutationKeys.action });
  const updateSearch = useCallback(
    (patch: PullRequestsSearchPatch) =>
      void navigate({
        search: (previous) => {
          const next = { ...previous, ...patch };
          return {
            involvement: next.involvement,
            state: next.state,
            ...(next.projectId ? { projectId: next.projectId } : {}),
            ...(next.selectedProjectId ? { selectedProjectId: next.selectedProjectId } : {}),
            ...(next.selectedRepo ? { selectedRepo: next.selectedRepo } : {}),
            ...(next.number ? { number: next.number } : {}),
            ...(next.q ? { q: next.q } : {}),
          };
        },
        replace: true,
      }),
    [navigate],
  );
  const repositoryProjects = useMemo(
    () =>
      projects
        .filter((project) => project.kind === "project")
        .map((project) => [project.id, project.name] as const)
        .toSorted((left, right) => left[1].localeCompare(right[1])),
    [projects],
  );
  const scopedProjectName = search.projectId
    ? repositoryProjects.find(([projectId]) => projectId === search.projectId)?.[1]
    : undefined;
  // Precise fallback for the filtered tabs: when a repository hit the per-repo entry cap, the
  // client-side involvement filter over the truncated superset can miss older matches, so the
  // active tab additionally fetches the server-filtered list. In the common (untruncated) case
  // this query never runs; the exceptional loading/error states are surfaced explicitly below.
  const supersetTruncated = (listQuery.data?.repositoryBatches ?? []).some(
    (batch) => batch.truncated,
  );
  const needsExactInvolvement = shouldLoadExactPullRequestInvolvement({
    involvement: search.involvement,
    state: search.state,
    supersetTruncated,
  });
  const exactInvolvementQuery = useQuery({
    ...pullRequestsExactInvolvementQueryOptions({
      involvement: search.involvement,
      state: search.state,
      projectId: search.projectId ?? null,
    }),
    enabled: needsExactInvolvement,
  });
  const exactInvolvementPending = needsExactInvolvement && exactInvolvementQuery.isPending;
  const listErrorState = pullRequestQueryErrorState(listQuery);
  const exactInvolvementErrorState = pullRequestQueryErrorState(
    exactInvolvementQuery,
    needsExactInvolvement,
  );
  const initialListError = listErrorState.initialError;
  const initialExactInvolvementError = exactInvolvementErrorState.initialError;
  const backgroundListError =
    listErrorState.backgroundError ?? exactInvolvementErrorState.backgroundError;
  const handleStateIntent = useCallback(
    (state: PullRequestState) => {
      if (state === search.state) return;
      void prefetchPullRequestListState(queryClient, {
        state,
        projectId: search.projectId ?? null,
      });
    },
    [queryClient, search.projectId, search.state],
  );
  const activeListData =
    needsExactInvolvement && exactInvolvementQuery.data
      ? exactInvolvementQuery.data
      : listQuery.data;

  // Multi-project result sets can be large. Keep typing responsive while React catches the
  // filtered rows up in a lower-priority render; virtualization can wait for measured need.
  const normalizedQuery = search.q?.trim().toLowerCase() ?? "";
  const query = useDeferredValue(normalizedQuery);
  const entries = useMemo(
    () =>
      orderPullRequestEntriesPinnedFirst(
        coalescePullRequestListEntries(
          filterPullRequestEntriesByInvolvement(
            activeListData?.entries ?? [],
            activeListData?.viewer ?? listQuery.data?.viewer,
            search.involvement,
          ).filter((entry) => matchesPullRequestSearchQuery(entry, query)),
          { preferredProjectId: search.selectedProjectId },
        ),
      ),
    [activeListData, listQuery.data?.viewer, query, search.involvement, search.selectedProjectId],
  );
  const grouped = useMemo(
    () =>
      search.involvement === "all"
        ? groupPullRequestEntriesByInvolvement(entries, listQuery.data?.viewer)
        : null,
    [entries, listQuery.data?.viewer, search.involvement],
  );
  const workspaceAssociationByEntryKey = useMemo<
    Record<string, PullRequestWorkspaceAssociation>
  >(() => {
    const associations: Record<string, PullRequestWorkspaceAssociation> = {};
    for (const entry of entries) {
      const association = pullRequestWorkspaceAssociation(entry, worktreeWorkspaces);
      if (association) associations[pullRequestListEntryKey(entry)] = association;
    }
    return associations;
  }, [entries, worktreeWorkspaces]);
  const associatedWorkspaceByEntryKey = useMemo(() => {
    const associations = new Map<string, OrchestrationWorktreeWorkspace>();
    for (const entry of entries) {
      const workspace = findWorkspaceForPullRequest(worktreeWorkspaces, entry.projectId, entry);
      if (workspace) associations.set(pullRequestListEntryKey(entry), workspace);
    }
    return associations;
  }, [entries, worktreeWorkspaces]);
  const canArchiveWorkspaceByEntryKey = useMemo<Record<string, boolean>>(() => {
    const archiveable: Record<string, boolean> = {};
    for (const [entryKey, workspace] of associatedWorkspaceByEntryKey) {
      archiveable[entryKey] =
        workspace.kind === "managed" &&
        workspace.state === "ready" &&
        workspace.archivedAt === null;
    }
    return archiveable;
  }, [associatedWorkspaceByEntryKey]);
  // A crafted URL must not show Project A's list while opening Project B's PR: when the list
  // is project-scoped, the selection must belong to that same project.
  const selectionMatchesScope =
    search.projectId === undefined ||
    search.selectedProjectId === undefined ||
    search.selectedProjectId === search.projectId;
  const selectedInput =
    selectionMatchesScope && search.selectedProjectId && search.selectedRepo && search.number
      ? {
          projectId: search.selectedProjectId,
          repository: search.selectedRepo,
          number: search.number,
        }
      : null;
  const detailOpen = selectedInput !== null;
  const [renderedInput, setRenderedInput] = useState(selectedInput);
  useEffect(() => {
    if (!selectedInput) return;
    // Timeout-0 keeps the state write asynchronous (compiler-eligible); the
    // detail panel animates in over 300ms, so one macrotask is invisible.
    const timeout = window.setTimeout(() => setRenderedInput(selectedInput), 0);
    return () => window.clearTimeout(timeout);
    // selectedInput is a fresh object literal every render; depend on its primitive
    // fields instead so this only re-fires when the actual selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.selectedProjectId, search.selectedRepo, search.number]);
  useEffect(() => {
    if (detailOpen) return;
    const timeout = window.setTimeout(() => setRenderedInput(null), 300);
    return () => window.clearTimeout(timeout);
  }, [detailOpen]);

  const closeDetail = useCallback(() => {
    const focusWasInsideDock = isFocusInsideRightDock(document.activeElement);
    const rowToRestore = selectedInput;
    updateSearch(CLEARED_SELECTION);
    if (focusWasInsideDock && rowToRestore) {
      requestAnimationFrame(() => {
        focusPullRequestRow(document, rowToRestore);
      });
    }
  }, [selectedInput, updateSearch]);

  // Ephemeral dock state derived from the URL selection, built with the same pure transitions
  // as the chat thread dock (rightDockStore.logic) so the two hosts can't drift. `open` follows
  // the live selection while the pane sticks around for the slide-out animation.
  const dockState = useMemo<RightDockThreadState>(() => {
    if (!renderedInput) return createDefaultRightDockState();
    const state = openPaneInState(createDefaultRightDockState(), {
      paneId: PULL_REQUESTS_ROUTE_PANE_ID,
      kind: "pullRequest",
      pullRequestProjectId: renderedInput.projectId,
      pullRequestRepository: renderedInput.repository,
      pullRequestNumber: renderedInput.number,
    });
    return detailOpen ? state : { ...state, open: false };
  }, [renderedInput, detailOpen]);
  const paneLabelOverrides = useMemo(
    () =>
      renderedInput
        ? { [PULL_REQUESTS_ROUTE_PANE_ID]: pullRequestPaneTabLabel(renderedInput.number) }
        : undefined,
    [renderedInput],
  );
  const paneStateIcon = usePullRequestPaneStateIcon(renderedInput);
  const paneIconOverrides = useMemo(
    () => (paneStateIcon ? { [PULL_REQUESTS_ROUTE_PANE_ID]: paneStateIcon } : undefined),
    [paneStateIcon],
  );
  const handleSelectPullRequest = useCallback(
    (entry: PullRequestListEntry) =>
      updateSearch({
        selectedProjectId: entry.projectId,
        selectedRepo: entry.repository,
        number: entry.number,
      }),
    [updateSearch],
  );
  const handleTogglePinned = useCallback(
    (entry: PullRequestListEntry) => {
      for (const input of pullRequestPinToggleInputs(entry, search.projectId === undefined)) {
        mutatePin(input, {
          onError: (error) =>
            toastManager.add({
              type: "error",
              title: "Could not update pull request pin",
              description: error instanceof Error ? error.message : "The pin could not be saved.",
            }),
        });
      }
    },
    [mutatePin, search.projectId],
  );
  const handlePullRequestContextMenuAction = useCallback(
    async (actionId: PullRequestRowContextMenuActionId, entry: PullRequestListEntry) => {
      const api = ensureNativeApi();
      try {
        if (actionId === "open-on-github") {
          await api.shell.openExternal(entry.url);
          return;
        }
        if (actionId === "copy-link") {
          await copyTextToClipboard(entry.url);
          return;
        }
        const associatedWorkspace = findWorkspaceForPullRequest(
          worktreeWorkspaces,
          entry.projectId,
          entry,
        );
        if (actionId === "archive-workspace") {
          if (!associatedWorkspace) throw new Error("The associated workspace is unavailable.");
          const result = await requestWorkspaceArchive({ api, workspace: associatedWorkspace });
          if (result === "cancelled") return;
          syncServerWorkspaceShellSnapshot(await api.orchestration.getWorkspaceShellSnapshot());
          toastManager.add({
            type: "success",
            title: "Archiving workspace",
            description: "The branch, pull request, conversations, and history will be retained.",
          });
          return;
        }
        const project = projects.find((candidate) => candidate.id === entry.projectId);
        if (!project) throw new Error("The project for this pull request is unavailable.");
        const newConversation = actionId === "new-review-conversation";
        const needsReviewPrompt = actionId === "review-in-new-workspace" || newConversation;
        const detail = needsReviewPrompt
          ? await queryClient
              .ensureQueryData(
                pullRequestDetailQueryOptions(
                  {
                    projectId: entry.projectId,
                    repository: entry.repository,
                    number: entry.number,
                  },
                  { pollingEnabled: false },
                ),
              )
              .catch(() => null)
          : null;
        const pullRequest = pullRequestWorkspaceMetadata(
          detail ?? {
            number: entry.number,
            title: entry.title,
            url: entry.url,
            baseBranch: entry.baseBranch,
            headBranch: entry.headBranch,
            state: entry.state,
            isDraft: entry.isDraft,
            mergeability: entry.mergeability,
            additions: entry.additions,
            deletions: entry.deletions,
          },
        );
        const result = await openPullRequestWorkspace({
          api,
          project,
          defaultProvider: settings.defaultProvider,
          intent: newConversation ? "new-conversation" : "open",
          title: pullRequest.title,
          conversationTitle: `Review PR #${pullRequest.number}`,
          pullRequest,
          onSnapshot: syncServerWorkspaceShellSnapshot,
        });
        if (needsReviewPrompt) {
          appendComposerPromptText(
            result.threadId,
            buildReviewPullRequestPrompt({
              prNumber: pullRequest.number,
              prTitle: pullRequest.title,
              prUrl: pullRequest.url,
              headBranch: pullRequest.headBranch,
              baseBranch: pullRequest.baseBranch,
              ...(detail
                ? {
                    checks: detail.checks,
                    comments: detail.comments,
                    commentsTruncated: detail.commentsTruncated,
                    commentsIncomplete: detail.commentsIncomplete,
                  }
                : {}),
            }),
          );
        }
        await navigate({ to: "/$threadId", params: { threadId: result.threadId } });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Pull request action failed",
          description: error instanceof Error ? error.message : "The action could not complete.",
        });
      }
    },
    [
      navigate,
      projects,
      queryClient,
      settings.defaultProvider,
      syncServerWorkspaceShellSnapshot,
      worktreeWorkspaces,
    ],
  );
  const refreshBlocked = refreshMutation.isPending || activeActionCount > 0;
  const handleManualRefresh = useCallback(() => {
    if (activeActionCount > 0) return;
    mutateRefresh(listInput, {
      onError: (error) =>
        toastManager.add({
          type: "error",
          title: "Could not refresh pull requests",
          description:
            error instanceof Error
              ? error.message
              : "The pull request list could not be refreshed.",
        }),
    });
  }, [activeActionCount, listInput, mutateRefresh]);

  const truncatedRepositoryCount =
    activeListData?.repositoryBatches.filter((batch) => batch.truncated).length ?? 0;

  return (
    <div className={cn(CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME, CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME)}>
      <RouteInsetSurface surfaceClassName="bg-transparent">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-background-surface)]">
          <header
            className={cn(
              CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
              CHAT_SURFACE_HEADER_PADDING_X_CLASS,
              "drag-region",
              trafficLightGutter,
              windowControlsGutter,
            )}
          >
            <div className={cn("flex items-center gap-2", CHAT_SURFACE_HEADER_HEIGHT_CLASS)}>
              <SidebarHeaderNavigationControls />
              {/* The title rides the surface header like the automations detail route, so the
                  scroll area opens straight onto the filters and the list. */}
              <h1 className="truncate font-heading text-sm font-medium">Pull requests</h1>
              {scopedProjectName ? (
                <>
                  <span aria-hidden className="text-muted-foreground/50">
                    ·
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {scopedProjectName}
                  </span>
                </>
              ) : null}
              <div className="min-w-0 flex-1" />
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh pull requests"
                title={
                  activeActionCount > 0 ? "Wait for the pull request action to finish" : "Refresh"
                }
                disabled={refreshBlocked}
                onClick={handleManualRefresh}
              >
                {/* Spins only for a refresh the user actually asked for. Background refetches
                    (window focus, remount) are constant and unprompted, so animating them
                    turned the header into a fidget rather than a signal. */}
                <RefreshCwIcon
                  className={cn("size-4", refreshMutation.isPending && "animate-spin")}
                />
              </Button>
            </div>
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-5 pb-12 pt-4 sm:px-7">
              {/* Scope first, then search within it: the pills read as the view you are in and
                  the field filters it, which is also the reference layout. */}
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <PullRequestFilterPillGroup
                    value={search.involvement}
                    options={PULL_REQUEST_INVOLVEMENT_TABS}
                    onChange={(involvement) => updateSearch({ involvement, ...CLEARED_SELECTION })}
                  />
                  <PullRequestFilterPillGroup
                    value={search.state}
                    options={PULL_REQUEST_STATE_TABS}
                    onIntent={handleStateIntent}
                    onChange={(state) => updateSearch({ state, ...CLEARED_SELECTION })}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    {/* The long field list belonged in a spec, not a placeholder. */}
                    <SearchInput
                      placeholder="Search pull requests"
                      value={search.q ?? ""}
                      onChange={(event) => updateSearch({ q: event.target.value || undefined })}
                    />
                  </div>
                  <PullRequestProjectFilterPopover
                    projects={repositoryProjects}
                    value={search.projectId}
                    onChange={(projectId) => updateSearch({ projectId, ...CLEARED_SELECTION })}
                  />
                </div>
              </div>

              {listQuery.isPending || exactInvolvementPending ? (
                // Mirrors the loaded list's row height and spacing so the switch doesn't jump.
                <div className="space-y-0.5">
                  {Array.from({ length: 7 }, (_, index) => (
                    <Skeleton key={index} className="h-13 w-full rounded-lg" />
                  ))}
                </div>
              ) : initialListError ? (
                <PullRequestsUnavailableState
                  error={initialListError}
                  onRetry={() => void listQuery.refetch()}
                />
              ) : initialExactInvolvementError ? (
                <PullRequestsUnavailableState
                  error={initialExactInvolvementError}
                  onRetry={() => void exactInvolvementQuery.refetch()}
                />
              ) : entries.length === 0 ? (
                <Empty className="py-16">
                  <EmptyHeader>
                    <EmptyTitle>
                      {search.involvement === "reviewing" && search.state !== "open"
                        ? "Review requests only apply to open pull requests"
                        : "No pull requests found"}
                    </EmptyTitle>
                    <EmptyDescription>
                      {search.involvement === "reviewing" && search.state !== "open"
                        ? "Select Open to see pull requests currently awaiting your review."
                        : "Try another involvement, state, project, or search filter."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <PullRequestList
                  entries={entries}
                  grouped={grouped}
                  selectedProjectId={search.selectedProjectId}
                  selectedRepo={search.selectedRepo}
                  selectedNumber={search.number}
                  showProjectTitle={search.projectId === undefined}
                  workspaceAssociationByEntryKey={workspaceAssociationByEntryKey}
                  canArchiveWorkspaceByEntryKey={canArchiveWorkspaceByEntryKey}
                  onSelect={handleSelectPullRequest}
                  onTogglePinned={handleTogglePinned}
                  onContextMenuAction={(actionId, entry) =>
                    void handlePullRequestContextMenuAction(actionId, entry)
                  }
                />
              )}
              {!exactInvolvementPending &&
              !initialExactInvolvementError &&
              truncatedRepositoryCount > 0 ? (
                <p className={cn(PR_FINE_TEXT_CLASS_NAME, "px-1 text-muted-foreground")}>
                  Showing the first 50 matching pull requests for {truncatedRepositoryCount}{" "}
                  {truncatedRepositoryCount === 1 ? "repository" : "repositories"}.
                </p>
              ) : null}
              {!exactInvolvementPending &&
              !initialExactInvolvementError &&
              activeListData?.errors.length ? (
                <PullRequestWarningNote shape="callout">
                  {activeListData.errors.length} project{" "}
                  {activeListData.errors.length === 1 ? "repository was" : "repositories were"}{" "}
                  unavailable. Healthy repositories are still shown.
                </PullRequestWarningNote>
              ) : null}
              {backgroundListError ? (
                <PullRequestWarningNote shape="callout" role="status">
                  The latest background refresh failed. Showing the last available pull requests.
                </PullRequestWarningNote>
              ) : null}
            </div>
          </main>
        </div>
      </RouteInsetSurface>
      {/* Same offcanvas dock as the chat view: 50/50 split on open, resizable, chip tab strip.
          No add-menu here — this host only ever shows the selected pull request pane. */}
      <RightDock
        state={dockState}
        minWidth={RIGHT_DOCK_MIN_WIDTH}
        defaultWidth={RIGHT_DOCK_DEFAULT_WIDTH}
        shouldAcceptWidth={() => true}
        addMenuKinds={[]}
        {...(paneLabelOverrides ? { paneLabelOverrides } : {})}
        {...(paneIconOverrides ? { paneIconOverrides } : {})}
        onClosePane={closeDetail}
        onCollapse={closeDetail}
        onOpenChange={(open) => {
          if (!open) closeDetail();
        }}
        onAddPane={() => {}}
        renderPane={(pane, context) => (
          <Suspense fallback={<PanelStateMessage>Loading pull request...</PanelStateMessage>}>
            <PullRequestDockPane pane={pane} pollingEnabled={context.isVisible} />
          </Suspense>
        )}
      />
    </div>
  );
}
