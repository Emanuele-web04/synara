import { ContextMenu } from "@base-ui/react/context-menu";
import type { PullRequestListEntry } from "@synara/contracts";
import type { ReactElement } from "react";
import { useMemo } from "react";

import { PickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { openContextMenuFromKeyboard } from "~/components/contextMenuKeyboard";
import { MenuGroup, MenuItem, MenuSeparator } from "~/components/ui/menu";
import {
  ArchiveIcon,
  CopyIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  MessageCircleIcon,
  type LucideIcon,
} from "~/lib/icons";

import type { PullRequestWorkspaceAssociation } from "./pullRequestList.logic";

export type PullRequestRowContextMenuActionId =
  | "open-workspace"
  | "restore-workspace"
  | "review-in-new-workspace"
  | "new-review-conversation"
  | "open-on-github"
  | "copy-link"
  | "archive-workspace";

export interface PullRequestRowContextMenuAction {
  label: string;
  destructive?: boolean;
}

export type PullRequestRowContextMenuActions = Partial<
  Record<PullRequestRowContextMenuActionId, PullRequestRowContextMenuAction>
>;

const ACTION_GROUPS: readonly (readonly PullRequestRowContextMenuActionId[])[] = [
  ["open-workspace", "restore-workspace", "review-in-new-workspace", "new-review-conversation"],
  ["open-on-github", "copy-link"],
  ["archive-workspace"],
];

const ACTION_ICONS: Record<PullRequestRowContextMenuActionId, LucideIcon> = {
  "open-workspace": GitPullRequestIcon,
  "restore-workspace": GitPullRequestIcon,
  "review-in-new-workspace": GitPullRequestIcon,
  "new-review-conversation": MessageCircleIcon,
  "open-on-github": ExternalLinkIcon,
  "copy-link": CopyIcon,
  "archive-workspace": ArchiveIcon,
};

export function derivePullRequestRowContextMenuActions(input: {
  entry: Pick<PullRequestListEntry, "state">;
  association: PullRequestWorkspaceAssociation;
  canArchiveAssociatedWorkspace: boolean;
}): PullRequestRowContextMenuActions {
  const actions: PullRequestRowContextMenuActions = {
    "open-on-github": { label: "Open on GitHub" },
    "copy-link": { label: "Copy pull request link" },
  };
  if (input.association === "active") {
    actions["open-workspace"] = { label: "Open workspace" };
    actions["new-review-conversation"] = { label: "New review conversation" };
  } else if (input.association === "archived") {
    actions["restore-workspace"] = { label: "Restore workspace" };
  } else if (input.entry.state === "open") {
    actions["review-in-new-workspace"] = { label: "Review in new workspace" };
  }
  if (
    input.entry.state === "merged" &&
    input.association === "active" &&
    input.canArchiveAssociatedWorkspace
  ) {
    actions["archive-workspace"] = { label: "Archive workspace" };
  }
  return actions;
}

export function PullRequestRowContextMenu({
  trigger,
  actions,
  onAction,
}: {
  trigger: ReactElement;
  actions: PullRequestRowContextMenuActions;
  onAction: (actionId: PullRequestRowContextMenuActionId) => void;
}) {
  const groups = useMemo(
    () =>
      ACTION_GROUPS.map((group) =>
        group.filter((actionId) => actions[actionId] !== undefined),
      ).filter((group) => group.length > 0),
    [actions],
  );
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={trigger} onKeyDown={openContextMenuFromKeyboard} />
      <PickerMenuPopup align="start" side="bottom" sideOffset={0} className="w-56 min-w-56">
        {groups.map((group, groupIndex) => (
          <MenuGroup key={group[0]}>
            {groupIndex > 0 ? <MenuSeparator /> : null}
            {group.map((actionId) => {
              const action = actions[actionId];
              if (!action) return null;
              const Icon = ACTION_ICONS[actionId];
              return (
                <MenuItem
                  key={actionId}
                  variant={action.destructive ? "destructive" : "default"}
                  onClick={() => onAction(actionId)}
                >
                  <Icon className="size-3.5 shrink-0" aria-hidden />
                  <span>{action.label}</span>
                </MenuItem>
              );
            })}
          </MenuGroup>
        ))}
      </PickerMenuPopup>
    </ContextMenu.Root>
  );
}
