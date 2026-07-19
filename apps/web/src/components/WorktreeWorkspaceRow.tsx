import type { OrchestrationWorktreeWorkspace } from "@synara/contracts";
import { type MouseEvent, type ReactNode, useRef } from "react";

import { PencilIcon, WorktreeIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import {
  type WorktreeWorkspaceContextMenuActionId,
  type WorktreeWorkspaceContextMenuActions,
  WorktreeWorkspaceContextMenu,
} from "./WorktreeWorkspaceContextMenu";
import {
  type WorktreeWorkspaceHoverCardContentProps,
  WorktreeWorkspaceHoverCardContent,
} from "./WorktreeWorkspaceHoverCardContent";
import { getWorktreeWorkspaceSidebarLabel } from "./worktreeWorkspaceSidebar.logic";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "./ui/preview-card";
import { SidebarMenuButton } from "./ui/sidebar";

export type WorktreeWorkspaceRowProps = {
  workspace: OrchestrationWorktreeWorkspace;
  isActive: boolean;
  openConversationCount: number;
  contextMenuActions: WorktreeWorkspaceContextMenuActions;
  hoverCard: Omit<WorktreeWorkspaceHoverCardContentProps, "title" | "openConversationCount">;
  trailing?: ReactNode;
  onOpenWorkspace: (workspace: OrchestrationWorktreeWorkspace) => void;
  onRenameWorkspace?: (workspace: OrchestrationWorktreeWorkspace) => void;
  onContextMenuAction: (
    actionId: WorktreeWorkspaceContextMenuActionId,
    workspace: OrchestrationWorktreeWorkspace,
  ) => void;
};

const TRAILING_SLOT_CLASS_NAME =
  "absolute inset-y-0 right-1.5 flex w-14 shrink-0 items-center justify-end gap-1";

export function WorktreeWorkspaceRow({
  workspace,
  isActive,
  openConversationCount,
  contextMenuActions,
  hoverCard,
  trailing,
  onOpenWorkspace,
  onRenameWorkspace,
  onContextMenuAction,
}: WorktreeWorkspaceRowProps) {
  const rowButtonRef = useRef<HTMLButtonElement>(null);
  const label = getWorktreeWorkspaceSidebarLabel(workspace);
  const canRename = workspace.kind !== "repository-root" && onRenameWorkspace !== undefined;
  const openWorkspace = () => onOpenWorkspace(workspace);
  const renameWorkspace = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onRenameWorkspace?.(workspace);
  };

  return (
    <WorktreeWorkspaceContextMenu
      finalFocusRef={rowButtonRef}
      trigger={
        <div
          className="group/worktree-row relative min-w-0"
          data-testid={`worktree-workspace-row-${workspace.id}`}
          data-workspace-id={workspace.id}
          tabIndex={-1}
        >
          <PreviewCard>
            <PreviewCardTrigger
              render={
                <SidebarMenuButton
                  ref={rowButtonRef}
                  type="button"
                  size="sm"
                  isActive={isActive}
                  aria-current={isActive ? "page" : undefined}
                  aria-label={`Open ${label}`}
                  className="h-8 gap-2 rounded-lg pl-2 pr-2 font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-foreground/89 transition-colors hover:bg-[var(--sidebar-accent)] data-[active=true]:bg-[var(--sidebar-accent-active)] data-[active=true]:text-[var(--sidebar-accent-foreground)]"
                  onClick={openWorkspace}
                  onDoubleClick={canRename ? renameWorkspace : undefined}
                />
              }
            >
              <SidebarLeadingIcon size="sm" tone="text-muted-foreground/65">
                <WorktreeIcon className="size-3.5" aria-hidden />
              </SidebarLeadingIcon>
              <span className="min-w-0 flex-1 truncate" title={label}>
                {label}
              </span>
              <span className="w-14 shrink-0" aria-hidden />
            </PreviewCardTrigger>
            <PreviewCardPopup className="w-72">
              <WorktreeWorkspaceHoverCardContent
                {...hoverCard}
                title={label}
                openConversationCount={openConversationCount}
              />
            </PreviewCardPopup>
          </PreviewCard>

          <div className={TRAILING_SLOT_CLASS_NAME} data-slot="worktree-row-trailing">
            {trailing}
            {openConversationCount > 0 ? (
              <span
                className={cn(
                  "text-[length:var(--app-font-size-ui-xs,10px)] tabular-nums text-muted-foreground/55 transition-opacity motion-reduce:transition-none",
                  canRename &&
                    "group-hover/worktree-row:opacity-0 group-focus-within/worktree-row:opacity-0",
                )}
                aria-label={`${openConversationCount} open ${openConversationCount === 1 ? "conversation" : "conversations"}`}
              >
                {openConversationCount}
              </span>
            ) : null}
            {canRename ? (
              <SidebarIconButton
                icon={PencilIcon}
                label={`Rename ${label}`}
                size="sm"
                title="Rename workspace"
                className="pointer-events-none absolute right-0 opacity-0 transition-opacity group-hover/worktree-row:pointer-events-auto group-hover/worktree-row:opacity-100 group-focus-within/worktree-row:pointer-events-auto group-focus-within/worktree-row:opacity-100 motion-reduce:transition-none"
                onClick={renameWorkspace}
              />
            ) : null}
          </div>
        </div>
      }
      target={{ workspaceId: workspace.id, workspacePath: workspace.path }}
      actions={contextMenuActions}
      onAction={(actionId) => onContextMenuAction(actionId, workspace)}
    />
  );
}
