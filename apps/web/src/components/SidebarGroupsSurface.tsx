// FILE: SidebarGroupsSurface.tsx
// Purpose: Groups sidebar surface — a "New group" action plus one expandable row per
//          group container (coordinator row first, then the group's chats). Threads in a
//          group are started by its coordinator. Replaces the old flat Studio list.
// Layer: Web component
// Exports: SidebarGroupsSurface

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProjectId, ThreadId } from "@synara/contracts";

import { createGroupProject, findLegacyStudioContainerForAdoption } from "../lib/groupProjects";
import { NewThreadIcon, SettingsIcon } from "../lib/icons";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { usePinnedProjectAgentsStore } from "../pinnedProjectAgentsStore";
import { useStore } from "../store";
import type { SidebarThreadSummary } from "../types";
import { cn } from "../lib/utils";
import { useWorkspacePathsStore } from "../workspacePathsStore";

import { resolveSidebarProjectRowLabel, type SidebarDerivedProjectData } from "./Sidebar.logic";
import { ChatSortMenu } from "./Sidebar";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import { SidebarCollapsibleSection } from "./SidebarListSection";
import { SidebarPrimaryAction } from "./SidebarPrimaryAction";
import { SidebarSectionToolbar } from "./SidebarSectionToolbar";
import { ThreadPinToggleButton } from "./ThreadPinToggleButton";
import {
  resolveGroupCoordinatorRowLabel,
  resolveGroupsListEmptyState,
} from "./SidebarGroupsSurface.logic";
import { resolveCoordinatorAppearance } from "./chat/group/coordinatorAppearance";
import {
  createGroupNeedsAttentionSelector,
  type GroupNeedsAttentionGroup,
} from "./chat/project/groupOverview.logic";
import {
  useProjectAgentSummaries,
  useProjectAgentSummariesStore,
} from "./chat/project/useProjectAgentSummaries";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "./ui/sidebar";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import { RenameDialog } from "./RenameDialog";
import { toastManager } from "./ui/toast";
import type { Project } from "../types";
import {
  sidebarHoverRevealHideClassName,
  SIDEBAR_HEADER_LEADING_ACTION_CLASS_NAME,
  SIDEBAR_HEADER_LEADING_ACTION_REVEAL_CLASS_NAME,
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME,
  SIDEBAR_PROJECT_NAME_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
} from "../sidebarRowStyles";
import type { SidebarThreadSortOrder } from "../appSettings";

// The hub row's hover toolbar holds two actions (pin, settings); only the truncating
// name yields to it, so the trailing status fades in place instead of sliding.
const HUB_ROW_TOOLBAR_RESERVE_CLASS_NAME =
  "group-hover/project-header:pr-[3.25rem] group-has-[:focus-visible]/project-header:pr-[3.25rem]";

// Rename fires once per project per session; the effect re-runs on every snapshot
// while the server has not yet echoed the new title. `inFlight` only dedupes the
// outstanding call — an id moves into the done set once the dispatch resolves, so a
// transient failure retries on the next snapshot instead of being swallowed.
const studioAdoptionDispatchedIds = new Set<string>();
const studioAdoptionInFlightIds = new Set<string>();

// Browser tests remount the surface inside one test and must start from a clean
// slate — the module-level set otherwise leaks "already dispatched" across mounts.
export function resetStudioAdoptionDispatchedIdsForTests(): void {
  studioAdoptionDispatchedIds.clear();
  studioAdoptionInFlightIds.clear();
}

export function SidebarGroupsSurface({
  groupProjects,
  projectSidebarDataById,
  threadsHydrated,
  visualActiveThreadId,
  threadSortOrder,
  onThreadSortOrderChange,
  renderThreadRow,
  renderListSectionHeader,
  renderPinnedThreadsSection,
  onOpenThread,
  onOpenGroupSettings,
  onProjectContextMenu,
}: {
  readonly groupProjects: readonly Project[];
  readonly projectSidebarDataById: ReadonlyMap<ProjectId, SidebarDerivedProjectData>;
  readonly threadsHydrated: boolean;
  readonly visualActiveThreadId: ThreadId | null;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  readonly renderThreadRow: (
    thread: SidebarThreadSummary,
    orderedProjectThreadIds: readonly ThreadId[],
    depth?: number,
    topLevel?: boolean,
    projectContextLabel?: string,
  ) => ReactNode;
  readonly renderListSectionHeader: (label: string, toolbar: ReactNode) => ReactNode;
  readonly renderPinnedThreadsSection: () => ReactNode;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenGroupSettings: (
    projectId: ProjectId,
    mode: "onboarding" | "edit",
    options?: { readonly discardable?: boolean },
  ) => void;
  readonly onProjectContextMenu: (projectId: ProjectId, position: { x: number; y: number }) => void;
}) {
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((store) => store.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((store) => store.studioWorkspaceRoot);
  const groupsWorkspaceRoot = useWorkspacePathsStore((store) => store.groupsWorkspaceRoot);
  const toggleProject = useStore((store) => store.toggleProject);
  const projects = useStore((store) => store.projects);
  const sidebarThreadSummaryById = useStore((store) => store.sidebarThreadSummaryById);
  const { summariesByProjectId } = useProjectAgentSummaries();
  const projectLabelById = useMemo(() => {
    const map = new Map<ProjectId, string>();
    for (const project of projects) {
      map.set(project.id, resolveSidebarProjectRowLabel(project));
    }
    return map;
  }, [projects]);
  // One shared selector answers "which groups have a thread Waiting on you" for
  // every row — the chat-header Group toggle reads the same result.
  const attentionGroups = useMemo(() => {
    const groups = new Map<ProjectId, GroupNeedsAttentionGroup>();
    for (const project of groupProjects) {
      const summary = summariesByProjectId.get(project.id);
      groups.set(project.id, {
        projectId: project.id,
        coordinatorThreadId: summary?.coordinatorThreadId ?? null,
        memberThreadIds: new Set(summary?.memberThreadIds ?? []),
        needsYouThreadIds: new Set(summary?.needsYouThreadIds ?? []),
      });
    }
    return groups;
  }, [groupProjects, summariesByProjectId]);
  const selectGroupNeedsAttention = useMemo(
    () => createGroupNeedsAttentionSelector({ groups: attentionGroups }),
    [attentionGroups],
  );
  const groupNeedsAttention = useStore(selectGroupNeedsAttention);
  const pinnedProjectAgentIds = usePinnedProjectAgentsStore((store) => store.pinnedProjectAgentIds);
  const pinnedProjectAgentIdSet = new Set(pinnedProjectAgentIds);
  const toggleProjectAgentPinned = usePinnedProjectAgentsStore(
    (store) => store.toggleProjectAgentPinned,
  );
  const [newGroupDialogOpen, setNewGroupDialogOpen] = useState(false);
  const [archivedGroupsOpen, setArchivedGroupsOpen] = useState(false);

  const activeGroups = groupProjects.filter(
    (project) => summariesByProjectId.get(project.id)?.archivedAt == null,
  );
  const archivedGroups = groupProjects.filter(
    (project) => summariesByProjectId.get(project.id)?.archivedAt != null,
  );

  const unarchiveGroup = async (projectId: ProjectId) => {
    const api = readNativeApi();
    if (!api?.projectAgent) return;
    const overview = await api.projectAgent
      .unarchiveGroup({ requestId: crypto.randomUUID(), projectId })
      .catch(() => null);
    if (overview) {
      useProjectAgentSummariesStore.getState().applyOverview(overview);
    }
  };

  // Adopt the legacy Studio container in place: retitle it "Hubs" once so its
  // existing chats stay under it. Idempotent — the row stops matching once renamed.
  // threadsHydrated doubles as the connected-api signal: the hydrated snapshot only
  // lands after the API negotiated, so gating on it retries adoption once the
  // transport is live instead of silently returning on a null api.
  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }
    const legacy = findLegacyStudioContainerForAdoption(groupProjects, {
      homeDir,
      chatWorkspaceRoot,
      studioWorkspaceRoot,
      groupsWorkspaceRoot,
    });
    if (
      !legacy ||
      studioAdoptionDispatchedIds.has(legacy.id) ||
      studioAdoptionInFlightIds.has(legacy.id)
    ) {
      return;
    }
    const api = readNativeApi();
    if (!api) {
      return;
    }
    studioAdoptionInFlightIds.add(legacy.id);
    void api.orchestration
      .dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: legacy.id,
        title: "Hubs",
      })
      .then(() => {
        studioAdoptionDispatchedIds.add(legacy.id);
      })
      .catch(() => {
        // Leave unmarked: a transient failure retries on the next snapshot.
      })
      .finally(() => {
        studioAdoptionInFlightIds.delete(legacy.id);
      });
  }, [
    chatWorkspaceRoot,
    groupProjects,
    groupsWorkspaceRoot,
    homeDir,
    studioWorkspaceRoot,
    threadsHydrated,
  ]);

  const createGroup = async (title: string) => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      return;
    }
    let projectId: ProjectId | null = null;
    try {
      projectId = await createGroupProject({ title: trimmed });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to create hub",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      // Re-throw so the dialog stays open for a retry instead of closing silently.
      throw error;
    }
    if (!projectId) {
      toastManager.add({
        type: "error",
        title: "Unable to create hub",
        description: "The Hubs workspace is not ready yet — try again in a moment.",
      });
      throw new Error("Hub creation is not ready yet.");
    }
    // This dialog opening just created the group — Cancel may offer discard.
    onOpenGroupSettings(projectId, "onboarding", { discardable: true });
  };

  const emptyState = resolveGroupsListEmptyState({
    threadsHydrated,
    groupCount: groupProjects.length,
  });

  return (
    <>
      <SidebarGroup className="px-1.5 pt-1 pb-1.5">
        <SidebarMenu className="gap-0.5">
          <SidebarPrimaryAction
            icon={NewThreadIcon}
            iconClassName="size-3.5"
            label="New hub"
            // The /hubs route gates on the same root: without it
            // createGroupProject can only fail, so hold the action off.
            disabled={!groupsWorkspaceRoot}
            onClick={() => {
              setNewGroupDialogOpen(true);
            }}
          />
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup className="px-1.5 py-1.5">
        {renderPinnedThreadsSection()}
        {renderListSectionHeader(
          "Hubs",
          <ChatSortMenu
            threadSortOrder={threadSortOrder}
            onThreadSortOrderChange={onThreadSortOrderChange}
          />,
        )}
        <SidebarMenu className="gap-3">
          {activeGroups.length > 0 ? (
            activeGroups.map((project) => {
              const projectSidebarData = projectSidebarDataById.get(project.id);
              const coordinatorSummary = summariesByProjectId.get(project.id) ?? null;
              const coordinatorConfigured = coordinatorSummary?.configured === true;
              const coordinatorPinned =
                coordinatorConfigured && pinnedProjectAgentIdSet.has(project.id);
              const coordinatorRowLabel = resolveGroupCoordinatorRowLabel({
                configured: coordinatorConfigured,
                coordinatorName: coordinatorSummary?.coordinatorName,
                groupName: resolveSidebarProjectRowLabel(project),
                remoteName: project.remoteName,
                threadTitle:
                  coordinatorSummary?.coordinatorThreadId != null
                    ? sidebarThreadSummaryById[coordinatorSummary.coordinatorThreadId]?.title
                    : null,
              });
              const coordinatorThreadActive =
                coordinatorConfigured &&
                coordinatorSummary?.coordinatorThreadId === visualActiveThreadId;
              const coordinatorAppearance = resolveCoordinatorAppearance({
                coordinatorIcon: coordinatorSummary?.coordinatorIcon,
                coordinatorColor: coordinatorSummary?.coordinatorColor,
              });
              const CoordinatorGlyph = coordinatorAppearance.Icon;
              const activateCoordinatorRow = () => {
                if (coordinatorConfigured && coordinatorSummary?.coordinatorThreadId) {
                  onOpenThread(coordinatorSummary.coordinatorThreadId);
                  return;
                }
                onOpenGroupSettings(project.id, "onboarding");
              };
              const groupThreadEntries = projectSidebarData?.visibleEntries ?? [];
              const hasGroupThreads = (projectSidebarData?.allProjectThreadCount ?? 0) > 0;
              const groupLabel = resolveSidebarProjectRowLabel(project);
              const toggleLabel = project.expanded ? "Hide threads" : "Show threads";
              return (
                <SidebarMenuItem key={project.id} className="rounded-md">
                  <div className="group/collapsible">
                    {/* The coordinator IS the hub's row, laid out like a project row: clicking
                        opens its chat, and on hover the leading glyph gives its slot to the
                        thread disclosure while the toolbar replaces the trailing status. */}
                    <div className="group/project-header relative">
                      <SidebarMenuButton
                        size="sm"
                        isActive={coordinatorThreadActive}
                        data-thread-selection-safe
                        className={cn(
                          SIDEBAR_HEADER_ROW_CLASS_NAME,
                          "cursor-pointer hover:bg-[var(--sidebar-accent)] group-hover/project-header:bg-[var(--sidebar-accent)] group-hover/project-header:text-[var(--sidebar-accent-foreground)]",
                          coordinatorThreadActive ? "bg-[var(--sidebar-accent)]" : null,
                        )}
                        aria-label={
                          coordinatorConfigured
                            ? `Open ${coordinatorRowLabel}`
                            : `Set up coordinator for ${groupLabel}`
                        }
                        onClick={activateCoordinatorRow}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          onProjectContextMenu(project.id, {
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }}
                      >
                        <SidebarLeadingIcon
                          size="sm"
                          tone={SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME}
                          className={
                            hasGroupThreads
                              ? cn(
                                  "invisible md:visible",
                                  sidebarHoverRevealHideClassName("project-header"),
                                )
                              : undefined
                          }
                        >
                          <CoordinatorGlyph
                            className={cn("size-4", coordinatorAppearance.iconClassName)}
                          />
                        </SidebarLeadingIcon>
                        <div
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-2 overflow-hidden transition-[padding] duration-150 ease-out",
                            coordinatorConfigured ? HUB_ROW_TOOLBAR_RESERVE_CLASS_NAME : null,
                          )}
                        >
                          <span className={SIDEBAR_PROJECT_NAME_CLASS_NAME}>
                            {coordinatorConfigured ? coordinatorRowLabel : groupLabel}
                          </span>
                        </div>
                        {coordinatorConfigured ? null : (
                          <span className="shrink-0 text-ui-xs text-muted-foreground/70">
                            Set up
                          </span>
                        )}
                        {groupNeedsAttention.has(project.id) ? (
                          <span
                            className={cn(
                              "ml-auto flex shrink-0 items-center",
                              sidebarHoverRevealHideClassName("project-header"),
                            )}
                          >
                            <span
                              className="mr-1 size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-300/90"
                              aria-hidden
                              title="A thread needs you"
                            />
                            <span className="sr-only">A thread needs you</span>
                          </span>
                        ) : null}
                      </SidebarMenuButton>
                      <button
                        type="button"
                        className={cn(
                          SIDEBAR_HEADER_LEADING_ACTION_CLASS_NAME,
                          SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
                          hasGroupThreads
                            ? cn(
                                SIDEBAR_HEADER_LEADING_ACTION_REVEAL_CLASS_NAME,
                                "pointer-events-auto opacity-100 md:pointer-events-none md:opacity-0",
                              )
                            : "invisible",
                        )}
                        aria-label={`${toggleLabel} in ${groupLabel}`}
                        aria-expanded={project.expanded}
                        tabIndex={hasGroupThreads ? 0 : -1}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          toggleProject(project.id);
                        }}
                      >
                        <DisclosureChevron open={project.expanded} className="size-3.5 shrink-0" />
                      </button>
                      {coordinatorConfigured ? (
                        <SidebarSectionToolbar placement="overlay" revealOnHover>
                          <ThreadPinToggleButton
                            pinned={coordinatorPinned}
                            presentation="inline"
                            targetLabel="coordinator"
                            toneClassName="text-muted-foreground/79"
                            onToggle={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              toggleProjectAgentPinned(project.id);
                            }}
                          />
                          <SidebarIconButton
                            icon={SettingsIcon}
                            label={`Hub settings for ${groupLabel}`}
                            tooltip="Hub settings"
                            tooltipSide="top"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              onOpenGroupSettings(project.id, "edit");
                            }}
                          />
                        </SidebarSectionToolbar>
                      ) : null}
                    </div>
                    <DisclosureRegion
                      open={project.expanded}
                      className={SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME}
                    >
                      <SidebarMenuSub
                        className={cn(
                          "mx-0 my-0 w-full translate-x-0 border-l-0 px-0 py-0",
                          SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
                        )}
                      >
                        {groupThreadEntries.map((entry) =>
                          renderThreadRow(
                            entry.thread,
                            projectSidebarData?.orderedProjectThreadIds ?? [],
                            entry.depth,
                            false,
                            entry.thread.projectId !== project.id
                              ? (projectLabelById.get(entry.thread.projectId) ?? undefined)
                              : undefined,
                          ),
                        )}
                      </SidebarMenuSub>
                    </DisclosureRegion>
                  </div>
                </SidebarMenuItem>
              );
            })
          ) : (
            <div className="px-2 pt-4 text-center text-ui text-muted-foreground/58">
              {emptyState === "loading" ? "Loading hubs…" : "No hubs yet"}
            </div>
          )}
        </SidebarMenu>
        {archivedGroups.length > 0 ? (
          <SidebarCollapsibleSection
            label="Archived hubs"
            open={archivedGroupsOpen}
            onToggle={() => setArchivedGroupsOpen((open) => !open)}
            className="pt-3"
          >
            <SidebarMenuSub
              className={cn(
                "mx-0 my-0 w-full translate-x-0 border-l-0 px-0 py-0",
                SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
              )}
            >
              {archivedGroups.map((project) => {
                const ArchivedGlyph = resolveCoordinatorAppearance({
                  coordinatorIcon: summariesByProjectId.get(project.id)?.coordinatorIcon,
                }).Icon;
                return (
                  <SidebarMenuSubItem
                    key={project.id}
                    className="group/archived-row relative w-full"
                  >
                    <SidebarMenuSubButton
                      render={<div role="button" tabIndex={0} />}
                      size="sm"
                      className={cn("text-muted-foreground", SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME)}
                      aria-label={`Archived hub ${resolveSidebarProjectRowLabel(project)}`}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        onProjectContextMenu(project.id, {
                          x: event.clientX,
                          y: event.clientY,
                        });
                      }}
                    >
                      <ArchivedGlyph className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {resolveSidebarProjectRowLabel(project)}
                      </span>
                    </SidebarMenuSubButton>
                    <button
                      type="button"
                      className={cn(
                        "sidebar-icon-button absolute right-1.5 top-1/2 z-20 -translate-y-1/2 cursor-pointer rounded-sm px-1 text-ui-xs text-muted-foreground transition-opacity hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
                        "pointer-events-none opacity-0 md:group-hover/archived-row:pointer-events-auto md:group-hover/archived-row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
                      )}
                      aria-label={`Unarchive ${resolveSidebarProjectRowLabel(project)}`}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void unarchiveGroup(project.id);
                      }}
                    >
                      Unarchive
                    </button>
                  </SidebarMenuSubItem>
                );
              })}
            </SidebarMenuSub>
          </SidebarCollapsibleSection>
        ) : null}
      </SidebarGroup>
      <RenameDialog
        open={newGroupDialogOpen}
        title="New hub"
        description="Create a hub container for coordinated work."
        initialValue=""
        placeholder="Hub name"
        saveLabel="Create hub"
        onOpenChange={setNewGroupDialogOpen}
        onSave={createGroup}
      />
    </>
  );
}
