// FILE: SidebarGroupsSurface.tsx
// Purpose: Groups sidebar surface — a "New group" action plus one expandable row per
//          group container (coordinator row first, then the group's chats, then a
//          per-group "New group chat" button). Replaces the old flat Studio list.
// Layer: Web component
// Exports: SidebarGroupsSurface

import { useEffect, useState, type ReactNode } from "react";
import type { ProjectId, ThreadId } from "@synara/contracts";

import { createGroupProject, findLegacyStudioContainerForAdoption } from "../lib/groupProjects";
import { BotIcon, FolderOpenIcon, NewThreadIcon } from "../lib/icons";
import { newCommandId } from "../lib/utils";
import { PinStatusIcon, pinActionLabel } from "../lib/pin";
import { readNativeApi } from "../nativeApi";
import { usePinnedProjectAgentsStore } from "../pinnedProjectAgentsStore";
import { useStore } from "../store";
import type { SidebarThreadSummary } from "../types";
import { cn } from "../lib/utils";
import { useWorkspacePathsStore } from "../workspacePathsStore";

import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarSectionToolbar } from "./SidebarSectionToolbar";
import {
  resolveSidebarProjectRowLabel,
  resolveThreadRowClassName,
  type SidebarDerivedProjectData,
} from "./Sidebar.logic";
import { ChatSortMenu, SidebarPrimaryAction } from "./Sidebar";
import {
  resolveGroupCoordinatorRowLabel,
  resolveGroupsListEmptyState,
} from "./SidebarGroupsSurface.logic";
import { useProjectAgentSummaries } from "./chat/project/useProjectAgentSummaries";
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
import type { Project } from "../types";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
} from "../sidebarRowStyles";
import type { SidebarThreadSortOrder } from "../appSettings";

// Rename fires once per project per session; the effect re-runs on every snapshot
// while the server has not yet echoed the new title.
const studioAdoptionDispatchedIds = new Set<string>();

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
  onCreateGroupChat,
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
  ) => ReactNode;
  readonly renderListSectionHeader: (label: string, toolbar: ReactNode) => ReactNode;
  readonly renderPinnedThreadsSection: () => ReactNode;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenGroupSettings: (projectId: ProjectId, mode: "onboarding" | "edit") => void;
  readonly onProjectContextMenu: (projectId: ProjectId, position: { x: number; y: number }) => void;
  readonly onCreateGroupChat: (projectId: ProjectId) => void;
}) {
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((store) => store.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((store) => store.studioWorkspaceRoot);
  const groupsWorkspaceRoot = useWorkspacePathsStore((store) => store.groupsWorkspaceRoot);
  const toggleProject = useStore((store) => store.toggleProject);
  const { summariesByProjectId } = useProjectAgentSummaries();
  const pinnedProjectAgentIds = usePinnedProjectAgentsStore((store) => store.pinnedProjectAgentIds);
  const pinnedProjectAgentIdSet = new Set(pinnedProjectAgentIds);
  const toggleProjectAgentPinned = usePinnedProjectAgentsStore(
    (store) => store.toggleProjectAgentPinned,
  );
  const [newGroupDialogOpen, setNewGroupDialogOpen] = useState(false);

  // Adopt the pre-Groups Studio container in place: retitle it "Groups" once so its
  // existing chats stay under it. Idempotent — the row stops matching once renamed.
  useEffect(() => {
    const legacy = findLegacyStudioContainerForAdoption(groupProjects, {
      homeDir,
      chatWorkspaceRoot,
      studioWorkspaceRoot,
      groupsWorkspaceRoot,
    });
    if (!legacy || studioAdoptionDispatchedIds.has(legacy.id)) {
      return;
    }
    const api = readNativeApi();
    if (!api) {
      return;
    }
    studioAdoptionDispatchedIds.add(legacy.id);
    void api.orchestration
      .dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: legacy.id,
        title: "Groups",
      })
      .catch(() => {
        // Leave the id marked: a transient failure should not spam the command.
      });
  }, [chatWorkspaceRoot, groupProjects, groupsWorkspaceRoot, homeDir, studioWorkspaceRoot]);

  const createGroup = async (title: string) => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      return;
    }
    const projectId = await createGroupProject({ title: trimmed });
    if (projectId) {
      onOpenGroupSettings(projectId, "onboarding");
    }
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
          {groupProjects.length > 0 ? (
            groupProjects.map((project) => {
              const projectSidebarData = projectSidebarDataById.get(project.id);
              const coordinatorSummary = summariesByProjectId.get(project.id) ?? null;
              const coordinatorConfigured = coordinatorSummary?.configured === true;
              const coordinatorPinned =
                coordinatorConfigured && pinnedProjectAgentIdSet.has(project.id);
              const coordinatorRowLabel = resolveGroupCoordinatorRowLabel({
                configured: coordinatorConfigured,
                coordinatorName: coordinatorSummary?.coordinatorName,
              });
              const coordinatorThreadActive =
                coordinatorConfigured &&
                coordinatorSummary?.coordinatorThreadId === visualActiveThreadId;
              const coordinatorRow = (
                <SidebarMenuSubItem className="group/project-agent-row relative w-full">
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
                    onClick={() => {
                      if (coordinatorConfigured && coordinatorSummary?.coordinatorThreadId) {
                        onOpenThread(coordinatorSummary.coordinatorThreadId);
                        return;
                      }
                      onOpenGroupSettings(project.id, "onboarding");
                    }}
                  >
                    <BotIcon className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate">{coordinatorRowLabel}</span>
                  </SidebarMenuSubButton>
                  {coordinatorConfigured ? (
                    <button
                      type="button"
                      aria-label={pinActionLabel("project agent", coordinatorPinned)}
                      aria-pressed={coordinatorPinned}
                      title={pinActionLabel("project agent", coordinatorPinned)}
                      className={cn(
                        "sidebar-icon-button absolute right-1.5 top-1/2 z-20 inline-flex size-4 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm transition-opacity hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
                        SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
                        coordinatorPinned
                          ? "pointer-events-auto opacity-100"
                          : "pointer-events-none opacity-0 md:group-hover/project-agent-row:pointer-events-auto md:group-hover/project-agent-row:opacity-100 md:group-has-[:focus-visible]/project-agent-row:pointer-events-auto md:group-has-[:focus-visible]/project-agent-row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
                      )}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        toggleProjectAgentPinned(project.id);
                      }}
                    >
                      <PinStatusIcon pinned={coordinatorPinned} className="size-3.5" />
                    </button>
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
                          "min-w-0 flex-1 truncate font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal",
                          SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
                        )}
                      >
                        {resolveSidebarProjectRowLabel(project)}
                      </span>
                    </SidebarMenuButton>
                    <SidebarSectionToolbar placement="overlay" revealOnHover>
                      <SidebarIconButton
                        icon={NewThreadIcon}
                        label={`New group chat in ${resolveSidebarProjectRowLabel(project)}`}
                        tooltip="New group chat"
                        tooltipSide="top"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onCreateGroupChat(project.id);
                        }}
                      />
                    </SidebarSectionToolbar>
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
                        ),
                      )}
                      {(projectSidebarData?.visibleEntries.length ?? 0) === 0 ? (
                        <div className="px-2 py-1 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/58">
                          No group chats yet
                        </div>
                      ) : null}
                      <SidebarMenuSubItem className="w-full">
                        <SidebarMenuSubButton
                          render={<div role="button" tabIndex={0} />}
                          data-thread-selection-safe
                          size="sm"
                          aria-label={`New group chat in ${resolveSidebarProjectRowLabel(project)}`}
                          className={SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME}
                          onClick={() => {
                            onCreateGroupChat(project.id);
                          }}
                        >
                          <NewThreadIcon className="size-3.5 shrink-0" />
                          <span className="min-w-0 truncate">New group chat</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  </DisclosureRegion>
                </div>
              );
            })
          ) : (
            <div className="px-2 pt-4 text-center text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/58">
              {emptyState === "loading" ? "Loading Groups..." : "No group chats yet"}
            </div>
          )}
        </SidebarMenu>
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
