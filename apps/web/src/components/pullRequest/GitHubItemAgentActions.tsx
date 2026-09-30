// FILE: GitHubItemAgentActions.tsx
// Purpose: The agent actions a GitHub item's header offers ahead of Open on GitHub: Send to
//          agent (a new draft thread with the item attached) and Ask (a side chat about it).
//          When the item's repository belongs to several projects, Send to agent asks which one.
// Layer: Pull request presentation
// Exports: GitHubItemAgentActions, GitHubItemSendTarget

import type { ProjectId } from "@synara/contracts";

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { ChatBubbleIcon, ChevronDownIcon, LoaderIcon } from "~/lib/icons";

export interface GitHubItemSendTarget {
  projectId: ProjectId;
  projectTitle: string;
}

export function GitHubItemAgentActions({
  sendTargets,
  sending,
  onSendToAgent,
  onAsk,
  asking,
}: {
  /** Projects Send to agent can open the thread in; one skips the picker. */
  sendTargets: ReadonlyArray<GitHubItemSendTarget>;
  sending: boolean;
  onSendToAgent: (projectId: ProjectId) => void;
  /** Absent where the host cannot show a side chat. */
  onAsk?: (() => void) | undefined;
  asking?: boolean;
}) {
  const sendLabel = sending ? "Preparing…" : "Send to agent";
  const sendIcon = sending ? <LoaderIcon className="animate-spin" /> : null;
  const [onlyTarget] = sendTargets;
  return (
    <>
      {sendTargets.length > 1 ? (
        <Menu>
          <MenuTrigger
            render={
              <Button size="sm" disabled={sending} aria-label="Send to agent: choose project" />
            }
          >
            {sendIcon}
            {sendLabel}
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
      ) : onlyTarget ? (
        <Button size="sm" disabled={sending} onClick={() => onSendToAgent(onlyTarget.projectId)}>
          {sendIcon}
          {sendLabel}
        </Button>
      ) : null}
      {onAsk ? (
        <Button variant="outline" size="sm" disabled={asking === true} onClick={onAsk}>
          {asking ? <LoaderIcon className="animate-spin" /> : <ChatBubbleIcon />}
          Ask
        </Button>
      ) : null}
    </>
  );
}
