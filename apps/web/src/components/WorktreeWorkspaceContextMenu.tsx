import { ContextMenu } from "@base-ui/react/context-menu";
import type { WorktreeWorkspaceId } from "@synara/contracts";
import {
  ArchiveIcon,
  CopyIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  MessageCircleIcon,
  PencilIcon,
  PinIcon,
  PlayIcon,
  PushIcon,
  StopFilledIcon,
  TerminalIcon,
  Trash2,
  type LucideIcon,
} from "~/lib/icons";
import type { ReactElement, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { PickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { openContextMenuFromKeyboard } from "./contextMenuKeyboard";
import { MenuGroup, MenuItem, MenuSeparator } from "./ui/menu";

export {
  getKeyboardContextMenuPoint,
  isContextMenuKeyboardEvent,
  openContextMenuFromKeyboard,
} from "./contextMenuKeyboard";

export type WorktreeWorkspaceContextMenuActionId =
  | "new-conversation"
  | "show-in-folder"
  | "open-in-editor"
  | "open-terminal"
  | "copy-path"
  | "start-dev"
  | "stop-dev"
  | "open-dev-server"
  | "rename-workspace"
  | "toggle-pin"
  | "publish-branch"
  | "create-pull-request"
  | "view-pull-request"
  | "fix-review-comments"
  | "resolve-conflicts"
  | "copy-branch-name"
  | "open-branch-on-github"
  | "archive-workspace"
  | "remove-from-synara";

export type WorktreeWorkspaceContextMenuAction = {
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  tooltip?: string;
};

export type WorktreeWorkspaceContextMenuActions = Partial<
  Record<WorktreeWorkspaceContextMenuActionId, WorktreeWorkspaceContextMenuAction>
>;

export type WorktreeWorkspaceContextMenuTarget = {
  workspaceId: WorktreeWorkspaceId;
  workspacePath: string | null;
};

export type WorktreeWorkspaceContextMenuProps = {
  trigger: ReactElement;
  finalFocusRef?: RefObject<HTMLElement | null>;
  target: WorktreeWorkspaceContextMenuTarget;
  actions: WorktreeWorkspaceContextMenuActions;
  onAction: (
    actionId: WorktreeWorkspaceContextMenuActionId,
    target: WorktreeWorkspaceContextMenuTarget,
  ) => void;
};

const ACTION_GROUPS: readonly (readonly WorktreeWorkspaceContextMenuActionId[])[] = [
  ["new-conversation", "show-in-folder", "open-in-editor", "open-terminal", "copy-path"],
  ["start-dev", "stop-dev", "open-dev-server"],
  ["rename-workspace", "toggle-pin"],
  [
    "publish-branch",
    "create-pull-request",
    "view-pull-request",
    "fix-review-comments",
    "resolve-conflicts",
    "copy-branch-name",
    "open-branch-on-github",
  ],
  ["archive-workspace", "remove-from-synara"],
];

const ACTION_ICONS: Record<WorktreeWorkspaceContextMenuActionId, LucideIcon> = {
  "new-conversation": MessageCircleIcon,
  "show-in-folder": FolderOpenIcon,
  "open-in-editor": PencilIcon,
  "open-terminal": TerminalIcon,
  "copy-path": CopyIcon,
  "start-dev": PlayIcon,
  "stop-dev": StopFilledIcon,
  "open-dev-server": ExternalLinkIcon,
  "rename-workspace": PencilIcon,
  "toggle-pin": PinIcon,
  "publish-branch": PushIcon,
  "create-pull-request": GitPullRequestIcon,
  "view-pull-request": GitPullRequestIcon,
  "fix-review-comments": MessageCircleIcon,
  "resolve-conflicts": GitBranchIcon,
  "copy-branch-name": CopyIcon,
  "open-branch-on-github": ExternalLinkIcon,
  "archive-workspace": ArchiveIcon,
  "remove-from-synara": Trash2,
};

const MENU_ITEM_CLASS_NAME =
  "text-[var(--color-text-foreground)] data-highlighted:text-[var(--color-text-foreground)]";
const MENU_ICON_CLASS_NAME =
  "inline-flex size-3.5 shrink-0 items-center justify-center text-[var(--color-text-foreground-secondary)] [&>svg]:size-3.5 [&>[data-slot=central-icon]]:size-3.5";

export function getWorktreeWorkspaceActionGroups(
  actions: WorktreeWorkspaceContextMenuActions,
): WorktreeWorkspaceContextMenuActionId[][] {
  return ACTION_GROUPS.map((group) =>
    group.filter((actionId) => actions[actionId] !== undefined),
  ).filter((group) => group.length > 0);
}

export function getFirstEnabledWorktreeWorkspaceActionId(
  actions: WorktreeWorkspaceContextMenuActions,
): WorktreeWorkspaceContextMenuActionId | undefined {
  return getWorktreeWorkspaceActionGroups(actions)
    .flat()
    .find((actionId) => actions[actionId]?.disabled !== true);
}

export function WorktreeWorkspaceContextMenu({
  trigger,
  finalFocusRef,
  target,
  actions,
  onAction,
}: WorktreeWorkspaceContextMenuProps) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const firstEnabledItemRef = useRef<HTMLDivElement>(null);
  const focusFrameRef = useRef<number | null>(null);
  const actionGroups = useMemo(() => getWorktreeWorkspaceActionGroups(actions), [actions]);
  const firstEnabledActionId = useMemo(
    () => getFirstEnabledWorktreeWorkspaceActionId(actions),
    [actions],
  );

  const handleOpenChange = useCallback((open: boolean) => {
    if (focusFrameRef.current !== null) {
      window.cancelAnimationFrame(focusFrameRef.current);
      focusFrameRef.current = null;
    }
    if (!open) return;
    focusFrameRef.current = window.requestAnimationFrame(() => {
      firstEnabledItemRef.current?.focus();
      focusFrameRef.current = null;
    });
  }, []);

  useEffect(
    () => () => {
      if (focusFrameRef.current !== null) {
        window.cancelAnimationFrame(focusFrameRef.current);
      }
    },
    [],
  );

  return (
    <ContextMenu.Root onOpenChange={handleOpenChange}>
      <ContextMenu.Trigger
        ref={triggerRef}
        render={trigger}
        onKeyDown={openContextMenuFromKeyboard}
      />
      {actionGroups.length > 0 ? (
        <PickerMenuPopup
          align="start"
          side="bottom"
          sideOffset={0}
          className="w-56 min-w-56"
          finalFocus={finalFocusRef ?? triggerRef}
        >
          {actionGroups.map((group, groupIndex) => (
            <MenuGroup key={group[0]}>
              {groupIndex > 0 ? <MenuSeparator /> : null}
              {group.map((actionId) => {
                const action = actions[actionId];
                if (!action) return null;
                const Icon = ACTION_ICONS[actionId];
                return (
                  <MenuItem
                    key={actionId}
                    render={
                      actionId === firstEnabledActionId ? (
                        <div ref={firstEnabledItemRef} />
                      ) : undefined
                    }
                    className={MENU_ITEM_CLASS_NAME}
                    disabled={action.disabled}
                    variant={action.destructive ? "destructive" : "default"}
                    title={action.tooltip}
                    onClick={() => onAction(actionId, target)}
                  >
                    <span className={MENU_ICON_CLASS_NAME}>
                      <Icon aria-hidden />
                    </span>
                    <span>{action.label}</span>
                  </MenuItem>
                );
              })}
            </MenuGroup>
          ))}
        </PickerMenuPopup>
      ) : null}
    </ContextMenu.Root>
  );
}
