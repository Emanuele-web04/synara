// FILE: SidebarGroupsSurface.tsx
// Purpose: Groups sidebar surface — a "New group" action plus one expandable row per
//          group container (coordinator row first, then the group's chats). Threads in a
//          group are started by its coordinator. Replaces the old flat Studio list.
// Layer: Web component
// Exports: SidebarGroupsSurface

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProjectId, ThreadId } from "@synara/contracts";

import { createGroupProject, findLegacyStudioContainerForAdoption } from "../lib/groupProjects";
import { FolderOpenIcon, NewThreadIcon, PENCIL_ICON_NAME } from "../lib/icons";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { usePinnedProjectAgentsStore } from "../pinnedProjectAgentsStore";
import { useStore } from "../store";
import type { SidebarThreadSummary } from "../types";
import { cn } from "../lib/utils";
import { useWorkspacePathsStore } from "../workspacePathsStore";

import {
  resolveSidebarProjectRowLabel,
  resolveThreadRowClassName,
  type SidebarDerivedProjectData,
} from "./Sidebar.logic";
import { ChatSortMenu, SidebarPrimaryAction } from "./Sidebar";
import { SidebarRowHoverActions } from "./SidebarRowHoverActions";
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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "./ui/sidebar";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import { RenameDialog } from "./RenameDialog";
import { toastManager } from "./ui/toast";
import type { Project } from "../types";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
} from "../sidebarRowStyles";
import type { SidebarThreadSortOrder } from "../appSettings";

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
      groups.set(project.id, {
        projectId: project.id,
        coordinatorThreadId: summariesByProjectId.get(project.id)?.coordinatorThreadId ?? null,
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

  // Adopt the pre-Groups Studio container in place: retitle it "Groups" once so its
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
        title: "Groups",
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
        title: "Unable to create group",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      // Re-throw so the dialog stays open for a retry instead of closing silently.
      throw error;
    }
    if (!projectId) {
      toastManager.add({
        type: "error",
        title: "Unable to create group",
        description: "The Groups workspace is not ready yet — try again in a moment.",
      });
      throw new Error("Group creation is not ready yet.");
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
            label="New group"
            // The /groups route gates on the same root: without it
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
          "Groups",
          <ChatSortMenu
            threadSortOrder={threadSortOrder}
            onThreadSortOrderChange={onThreadSortOrderChange}
          />,
        )}
        <SidebarMenu className="gap-1">
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
              const showCoordinatorContextMenu = (position: { x: number; y: number }) => {
                if (!coordinatorConfigured) return;
                const api = readNativeApi();
                if (!api) return;
                void api.contextMenu
                  .show(
                    [
                      {
                        id: "change-icon" as const,
                        label: "Change icon…",
                        icon: PENCIL_ICON_NAME,
                      },
                    ],
                    position,
                  )
                  .then((clicked) => {
                    if (clicked === "change-icon") {
                      onOpenGroupSettings(project.id, "edit");
                    }
                  });
              };
              const coordinatorRow = (
                <SidebarMenuSubItem className="group/thread-row relative w-full">
                  <SidebarMenuSubButton
                    render={<div role="button" tabIndex={0} />}
                    data-thread-selection-safe
                    size="sm"
                    isActive={coordinatorThreadActive}
                    className={cn(
                      resolveThreadRowClassName({
                        isActive: coordinatorThreadActive,
                        isSelected: false,
                      }),
                      SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
                      coordinatorConfigured ? "pr-7" : null,
                    )}
                    aria-label={
                      coordinatorConfigured
                        ? `Open ${coordinatorRowLabel}`
                        : `Set up coordinator for ${resolveSidebarProjectRowLabel(project)}`
                    }
                    onClick={activateCoordinatorRow}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      activateCoordinatorRow();
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      showCoordinatorContextMenu({ x: event.clientX, y: event.clientY });
                    }}
                  >
                    <CoordinatorGlyph
                      className={cn("size-3.5 shrink-0", coordinatorAppearance.iconClassName)}
                    />
                    <span className="min-w-0 truncate">{coordinatorRowLabel}</span>
                  </SidebarMenuSubButton>
                  {coordinatorConfigured ? (
                    <SidebarRowHoverActions
                      threadId={coordinatorSummary?.coordinatorThreadId ?? project.id}
                    >
                      <div className="pointer-events-auto inline-flex items-center">
                        <ThreadPinToggleButton
                          pinned={coordinatorPinned}
                          presentation="inline"
                          targetLabel="coordinator"
                          toneClassName="text-muted-foreground/42"
                          onToggle={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            toggleProjectAgentPinned(project.id);
                          }}
                        />
                      </div>
                    </SidebarRowHoverActions>
                  ) : null}
                </SidebarMenuSubItem>
              );
              return (
                <div key={project.id} className="group/collapsible">
                  <div className="group/group-header relative">
                    <SidebarMenuButton
                      size="sm"
                      className={cn(
                        SIDEBAR_HEADER_ROW_CLASS_NAME,
                        "cursor-pointer hover:bg-[var(--sidebar-accent)] group-hover/group-header:bg-[var(--sidebar-accent)] group-hover/group-header:text-[var(--sidebar-accent-foreground)]",
                      )}
                      aria-expanded={project.expanded}
                      onClick={() => {
                        toggleProject(project.id);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        onProjectContextMenu(project.id, {
                          x: event.clientX,
                          y: event.clientY,
                        });
                      }}
                    >
                      <DisclosureChevron
                        open={project.expanded}
                        className="size-3 shrink-0 text-muted-foreground/70"
                      />
                      <FolderOpenIcon className="size-3.5 shrink-0" />
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate font-system-ui text-ui font-normal",
                          SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
                        )}
                      >
                        {resolveSidebarProjectRowLabel(project)}
                      </span>
                      {groupNeedsAttention.has(project.id) ? (
                        <>
                          <span
                            className="mr-1 size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-300/90"
                            aria-hidden
                            title="A thread needs you"
                          />
                          <span className="sr-only">A thread needs you</span>
                        </>
                      ) : null}
                    </SidebarMenuButton>
                  </div>
                  {coordinatorPinned ? (
                    <SidebarMenuSub
                      className={cn(
                        "mx-0 my-0 w-full translate-x-0 border-l-0 px-0 py-0",
                        SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
                      )}
                    >
                      {coordinatorRow}
                    </SidebarMenuSub>
                  ) : null}
                  <DisclosureRegion open={project.expanded} className="pt-0.5">
                    <SidebarMenuSub
                      className={cn(
                        "mx-0 my-0 w-full translate-x-0 border-l-0 px-0 py-0",
                        SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
                      )}
                    >
                      {!coordinatorPinned ? coordinatorRow : null}
                      {(projectSidebarData?.visibleEntries ?? []).map((entry) =>
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
              );
            })
          ) : (
            <div className="px-2 pt-4 text-center text-ui text-muted-foreground/58">
              {emptyState === "loading" ? "Loading groups…" : "No groups yet"}
            </div>
          )}
        </SidebarMenu>
        {archivedGroups.length > 0 ? (
          <div className="group/archived-collapsible pt-1">
            <SidebarMenuButton
              size="sm"
              className={cn(
                SIDEBAR_HEADER_ROW_CLASS_NAME,
                "cursor-pointer hover:bg-[var(--sidebar-accent)]",
              )}
              aria-expanded={archivedGroupsOpen}
              onClick={() => setArchivedGroupsOpen((open) => !open)}
            >
              <DisclosureChevron
                open={archivedGroupsOpen}
                className="size-3 shrink-0 text-muted-foreground/70"
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-system-ui text-ui font-normal text-muted-foreground",
                  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
                )}
              >
                Archived groups
              </span>
            </SidebarMenuButton>
            <DisclosureRegion open={archivedGroupsOpen} className="pt-0.5">
              <SidebarMenuSub
                className={cn(
                  "mx-0 my-0 w-full translate-x-0 border-l-0 px-0 py-0",
                  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
                )}
              >
                {archivedGroups.map((project) => (
                  <SidebarMenuSubItem
                    key={project.id}
                    className="group/archived-row relative w-full"
                  >
                    <SidebarMenuSubButton
                      render={<div role="button" tabIndex={0} />}
                      size="sm"
                      className={cn("text-muted-foreground", SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME)}
                      aria-label={`Archived group ${resolveSidebarProjectRowLabel(project)}`}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        onProjectContextMenu(project.id, {
                          x: event.clientX,
                          y: event.clientY,
                        });
                      }}
                    >
                      <FolderOpenIcon className="size-3.5 shrink-0" />
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
                ))}
              </SidebarMenuSub>
            </DisclosureRegion>
          </div>
        ) : null}
      </SidebarGroup>
      <RenameDialog
        open={newGroupDialogOpen}
        title="New group"
        description="Create a group container for coordinated work."
        initialValue=""
        placeholder="Group name"
        saveLabel="Create group"
        onOpenChange={setNewGroupDialogOpen}
        onSave={createGroup}
      />
    </>
  );
}
