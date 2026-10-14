// FILE: GitHubItemAgentActions.tsx
// Purpose: Send to agent for a GitHub item (a new draft thread with the item attached), in its
//          two shapes: the top bar button of the detail page (asking which project when the
//          item's repository belongs to several) and the menu entries the dock's "…" menu and
//          the floating composer's "+" menu list, one per project.
// Layer: Pull request presentation
// Exports: GitHubItemAgentActions, SendToAgentMenuItems, GitHubItemSendTarget,
//          TOP_BAR_NARROW_LABEL_CLASS_NAME

import type { ProjectId } from "@synara/contracts";

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { MENU_ICON_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { BotIcon, ChevronDownIcon, LoaderIcon } from "~/lib/icons";

/**
 * On a top bar control's words: once the page's top bar is narrow (the side chat is open) the
 * glyph carries the meaning and the words drop, so tabs and actions stay on one row.
 */
export const TOP_BAR_NARROW_LABEL_CLASS_NAME = "@max-[46rem]/topbar:sr-only";

export interface GitHubItemSendTarget {
  projectId: ProjectId;
  projectTitle: string;
}

/** "Send to agent" per project, for a menu; one project keeps the plain label. */
export function SendToAgentMenuItems({
  sendTargets,
  sending,
  disabled,
  onSendToAgent,
}: {
  sendTargets: ReadonlyArray<GitHubItemSendTarget>;
  /** Shows "Preparing…" while the thread is being prepared. */
  sending?: boolean;
  disabled?: boolean;
  onSendToAgent: (projectId: ProjectId) => void;
}) {
  return sendTargets.map((target) => (
    <MenuItem
      key={target.projectId}
      onClick={() => onSendToAgent(target.projectId)}
      disabled={disabled === true}
    >
      <BotIcon className={MENU_ICON_CLASS_NAME} />
      <span className="truncate">
        {sending
          ? "Preparing…"
          : sendTargets.length > 1
            ? `Send to agent in ${target.projectTitle}`
            : "Send to agent"}
      </span>
    </MenuItem>
  ));
}

/** The top bar's Send to agent, led by the agent glyph. */
export function GitHubItemAgentActions({
  sendTargets,
  sending,
  onSendToAgent,
}: {
  /** Projects Send to agent can open the thread in; one skips the picker. */
  sendTargets: ReadonlyArray<GitHubItemSendTarget>;
  sending: boolean;
  onSendToAgent: (projectId: ProjectId) => void;
}) {
  const sendLabel = sending ? "Preparing…" : "Send to agent";
  const label = <span className={TOP_BAR_NARROW_LABEL_CLASS_NAME}>{sendLabel}</span>;
  const icon = sending ? <LoaderIcon className="animate-spin" /> : <BotIcon />;
  const [onlyTarget] = sendTargets;
  if (sendTargets.length > 1) {
    return (
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              disabled={sending}
              aria-label="Send to agent: choose project"
            />
          }
        >
          {icon}
          {label}
          <ChevronDownIcon />
        </MenuTrigger>
        <ComposerPickerMenuPopup align="start" side="bottom" className="w-56 min-w-56">
          {sendTargets.map((target) => (
            <MenuItem key={target.projectId} onClick={() => onSendToAgent(target.projectId)}>
              <span className="truncate">{target.projectTitle}</span>
            </MenuItem>
          ))}
        </ComposerPickerMenuPopup>
      </Menu>
    );
  }
  if (!onlyTarget) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={sending}
      onClick={() => onSendToAgent(onlyTarget.projectId)}
      title={sendLabel}
    >
      {icon}
      {label}
    </Button>
  );
}
