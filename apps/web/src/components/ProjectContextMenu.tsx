import { ContextMenu } from "@base-ui/react/context-menu";
import type { ProjectId } from "@synara/contracts";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  CopyIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  KanbanIcon,
  PencilIcon,
  PinIcon,
  WorktreeIcon,
  XIcon,
  type LucideIcon,
} from "~/lib/icons";
import { PickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { openContextMenuFromKeyboard } from "./contextMenuKeyboard";
import { MenuGroup, MenuItem, MenuSeparator } from "./ui/menu";

export type ProjectContextMenuActionId =
  | "new-workspace"
  | "show-in-folder"
  | "open-in-kanban"
  | "open-repository-on-github"
  | "copy-path"
  | "edit-project"
  | "toggle-pin"
  | "remove-project";

export type ProjectContextMenuAction = {
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  tooltip?: string;
};

export type ProjectContextMenuActions = Partial<
  Record<ProjectContextMenuActionId, ProjectContextMenuAction>
>;

export type ProjectContextMenuTarget = {
  projectId: ProjectId;
  projectPath: string;
};

export type ProjectContextMenuProps = {
  trigger: ReactElement;
  target: ProjectContextMenuTarget;
  actions: ProjectContextMenuActions;
  onAction: (actionId: ProjectContextMenuActionId, target: ProjectContextMenuTarget) => void;
};

const ACTION_GROUPS: readonly (readonly ProjectContextMenuActionId[])[] = [
  ["new-workspace", "show-in-folder", "open-in-kanban", "open-repository-on-github", "copy-path"],
  ["edit-project", "toggle-pin"],
  ["remove-project"],
];

const ACTION_ICONS: Record<ProjectContextMenuActionId, LucideIcon> = {
  "new-workspace": WorktreeIcon,
  "show-in-folder": FolderOpenIcon,
  "open-in-kanban": KanbanIcon,
  "open-repository-on-github": ExternalLinkIcon,
  "copy-path": CopyIcon,
  "edit-project": PencilIcon,
  "toggle-pin": PinIcon,
  "remove-project": XIcon,
};

const MENU_ITEM_CLASS_NAME =
  "text-[var(--color-text-foreground)] data-highlighted:text-[var(--color-text-foreground)]";
const MENU_ICON_CLASS_NAME =
  "inline-flex size-3.5 shrink-0 items-center justify-center text-[var(--color-text-foreground-secondary)] [&>svg]:size-3.5";

export function getProjectContextMenuActionGroups(
  actions: ProjectContextMenuActions,
): ProjectContextMenuActionId[][] {
  return ACTION_GROUPS.map((group) =>
    group.filter((actionId) => actions[actionId] !== undefined),
  ).filter((group) => group.length > 0);
}

export function getFirstEnabledProjectContextMenuActionId(
  actions: ProjectContextMenuActions,
): ProjectContextMenuActionId | undefined {
  return getProjectContextMenuActionGroups(actions)
    .flat()
    .find((actionId) => actions[actionId]?.disabled !== true);
}

export function ProjectContextMenu({
  trigger,
  target,
  actions,
  onAction,
}: ProjectContextMenuProps) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const firstEnabledItemRef = useRef<HTMLDivElement>(null);
  const focusFrameRef = useRef<number | null>(null);
  const actionGroups = useMemo(() => getProjectContextMenuActionGroups(actions), [actions]);
  const firstEnabledActionId = useMemo(
    () => getFirstEnabledProjectContextMenuActionId(actions),
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
      if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
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
          finalFocus={triggerRef}
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
