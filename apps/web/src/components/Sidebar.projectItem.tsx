// FILE: Sidebar.projectItem.tsx
// Purpose: Renders a project header row (icon, status dot, rename input, new-thread toolbar) plus its nested thread list.
// Layer: Sidebar presentation (component).
// Exports: SidebarProjectItem

import type { MutableRefObject, ReactNode } from "react";
import { DisposableThreadIcon, NewThreadIcon, TerminalIcon } from "~/lib/icons";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import type { Project, SidebarThreadSummary } from "../types";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME,
} from "../sidebarRowStyles";
import {
  disclosureContentClassName,
  disclosureShellClassName,
  DISCLOSURE_INNER_CLASS,
} from "~/lib/disclosureMotion";
import { ProjectSidebarIcon } from "./ProjectSidebarIcon";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import { SidebarSectionToolbar } from "./SidebarSectionToolbar";
import {
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "./ui/sidebar";
import type { SortableProjectHandleProps } from "./Sidebar.sortable";
import type { SidebarDerivedProjectData } from "./Sidebar.logic";

export interface SidebarProjectItemProps {
  project: Project;
  dragHandleProps: SortableProjectHandleProps | null;
  projectSidebarData: SidebarDerivedProjectData;

  isManualProjectSorting: boolean;
  isRenamingProject: boolean;
  renamingProjectName: string;
  renamingProjectInputRef: MutableRefObject<HTMLInputElement | null>;
  renamingProjectCommittedRef: MutableRefObject<boolean>;
  newTerminalThreadShortcutLabel: string | null;
  newThreadShortcutLabel: string | null;

  onProjectTitlePointerDownCapture: () => void;
  onProjectTitleClick: (event: React.MouseEvent<HTMLButtonElement>, projectId: ProjectId) => void;
  onProjectTitleKeyDown: (
    event: React.KeyboardEvent<HTMLButtonElement>,
    projectId: ProjectId,
  ) => void;
  onProjectContextMenu: (projectId: ProjectId, position: { x: number; y: number }) => void;
  onChangeRenamingProjectName: (value: string) => void;
  onCommitProjectRename: (
    projectId: ProjectId,
    nextName: string,
    previousLocalName: string | null,
  ) => void;
  onCancelProjectRename: () => void;
  onCreateTerminalThread: (projectId: ProjectId) => void;
  onCreateDisposableThread: (projectId: ProjectId) => void;
  onCreateThread: (projectId: ProjectId) => void;
  onExpandThreadList: (cwd: string) => void;
  onCollapseThreadList: (cwd: string) => void;
  renderThreadRow: (
    thread: SidebarThreadSummary,
    orderedProjectThreadIds: readonly ThreadId[],
    depth: number,
    childCount: number,
    isExpanded: boolean,
  ) => ReactNode;
}

export function SidebarProjectItem({
  project,
  dragHandleProps,
  projectSidebarData,
  isManualProjectSorting,
  isRenamingProject,
  renamingProjectName,
  renamingProjectInputRef,
  renamingProjectCommittedRef,
  newTerminalThreadShortcutLabel,
  newThreadShortcutLabel,
  onProjectTitlePointerDownCapture,
  onProjectTitleClick,
  onProjectTitleKeyDown,
  onProjectContextMenu,
  onChangeRenamingProjectName,
  onCommitProjectRename,
  onCancelProjectRename,
  onCreateTerminalThread,
  onCreateDisposableThread,
  onCreateThread,
  onExpandThreadList,
  onCollapseThreadList,
  renderThreadRow,
}: SidebarProjectItemProps) {
  const {
    orderedProjectThreadIds,
    projectStatus,
    visibleEntries,
    hasHiddenThreads,
    isThreadListExpanded,
  } = projectSidebarData;

  return (
    <div className="group/collapsible">
      <div className="group/project-header relative">
        <SidebarMenuButton
          ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
          size="sm"
          className={cn(
            SIDEBAR_HEADER_ROW_CLASS_NAME,
            "transition-[padding] duration-150 ease-out hover:bg-[var(--sidebar-accent)] group-hover/project-header:bg-[var(--sidebar-accent)] group-hover/project-header:pr-[4.75rem] group-hover/project-header:text-[var(--sidebar-accent-foreground)] group-focus-within/project-header:pr-[4.75rem]",
            isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
          )}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
          onPointerDownCapture={onProjectTitlePointerDownCapture}
          onClick={(event) => onProjectTitleClick(event, project.id)}
          onKeyDown={(event) => onProjectTitleKeyDown(event, project.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            onProjectContextMenu(project.id, {
              x: event.clientX,
              y: event.clientY,
            });
          }}
        >
          <SidebarLeadingIcon size="sm">
            <ProjectSidebarIcon cwd={project.cwd} expanded={project.expanded} />
            {projectStatus ? (
              <span
                aria-hidden="true"
                title={projectStatus.label}
                className={cn(
                  "absolute -right-0.5 top-0.5 size-1.5 rounded-full",
                  projectStatus.dotClass,
                  projectStatus.pulse ? "animate-pulse" : "",
                )}
              />
            ) : null}
          </SidebarLeadingIcon>
          <div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
            {isRenamingProject ? (
              <input
                ref={(element) => {
                  if (element && renamingProjectInputRef.current !== element) {
                    renamingProjectInputRef.current = element;
                    element.focus();
                    element.select();
                  }
                }}
                className="min-w-0 flex-1 rounded-md border border-ring bg-transparent px-1.5 py-0.5 text-[length:var(--app-font-size-ui,12px)] font-normal text-foreground outline-none"
                value={renamingProjectName}
                placeholder={project.folderName}
                onChange={(event) => onChangeRenamingProjectName(event.target.value)}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    renamingProjectCommittedRef.current = true;
                    onCommitProjectRename(project.id, renamingProjectName, project.localName);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    renamingProjectCommittedRef.current = true;
                    onCancelProjectRename();
                  }
                }}
                onBlur={() => {
                  if (!renamingProjectCommittedRef.current) {
                    onCommitProjectRename(project.id, renamingProjectName, project.localName);
                  }
                }}
              />
            ) : (
              <>
                <span className="truncate font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/79">
                  {project.name}
                </span>
                {project.localName ? (
                  <span className="shrink-0 truncate text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/70">
                    {project.folderName}
                  </span>
                ) : null}
              </>
            )}
          </div>
        </SidebarMenuButton>
        <SidebarSectionToolbar placement="overlay" revealOnHover>
          <SidebarIconButton
            icon={TerminalIcon}
            label={`Create new terminal thread in ${project.name}`}
            tooltip={
              newTerminalThreadShortcutLabel
                ? `New terminal thread (${newTerminalThreadShortcutLabel})`
                : "New terminal thread"
            }
            tooltipSide="top"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onCreateTerminalThread(project.id);
            }}
          />
          <SidebarIconButton
            icon={DisposableThreadIcon}
            glyph="chromeLu"
            label={`Create disposable thread in ${project.name}`}
            tooltip="New disposable thread"
            tooltipSide="top"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onCreateDisposableThread(project.id);
            }}
          />
          <SidebarIconButton
            icon={NewThreadIcon}
            label={`Create new thread in ${project.name}`}
            tooltip={
              newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"
            }
            tooltipSide="top"
            data-testid="new-thread-button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onCreateThread(project.id);
            }}
          />
        </SidebarSectionToolbar>
      </div>

      <div
        className={cn(
          disclosureShellClassName(project.expanded),
          SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME,
        )}
      >
        <div className={DISCLOSURE_INNER_CLASS}>
          <SidebarMenuSub
            className={cn(
              "mx-0 my-0 w-full translate-x-0 border-l-0 px-0 py-0",
              SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
              disclosureContentClassName(project.expanded),
            )}
          >
            {visibleEntries.map((entry) =>
              renderThreadRow(
                entry.thread,
                orderedProjectThreadIds,
                entry.depth,
                entry.childCount,
                entry.isExpanded,
              ),
            )}

            {hasHiddenThreads && !isThreadListExpanded && (
              <SidebarMenuSubItem className="w-full">
                <SidebarMenuSubButton
                  render={<button type="button" />}
                  data-thread-selection-safe
                  size="sm"
                  className="h-7 w-full translate-x-0 justify-start rounded-lg pr-2 pl-8 text-left text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/79 hover:bg-[var(--sidebar-accent)]"
                  onClick={() => {
                    onExpandThreadList(project.cwd);
                  }}
                >
                  <span>Show more</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            )}
            {hasHiddenThreads && isThreadListExpanded && (
              <SidebarMenuSubItem className="w-full">
                <SidebarMenuSubButton
                  render={<button type="button" />}
                  data-thread-selection-safe
                  size="sm"
                  className="h-7 w-full translate-x-0 justify-start rounded-lg pr-2 pl-8 text-left text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/79 hover:bg-[var(--sidebar-accent)]"
                  onClick={() => {
                    onCollapseThreadList(project.cwd);
                  }}
                >
                  <span>Show less</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            )}
          </SidebarMenuSub>
        </div>
      </div>
    </div>
  );
}
