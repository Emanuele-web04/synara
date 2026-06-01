// FILE: QueuedComposerActions.tsx
// Purpose: Inline action cluster (Steer / Delete / Menu) rendered on each queued
// composer row. Used in both the compact and expanded composer layouts so the
// action chrome stays in lockstep across surfaces.
// Layer: Chat composer UI primitive
// Exports: QueuedComposerActions

import { EllipsisIcon, SteerIcon, Trash2 } from "~/lib/icons";

import type { QueuedComposerTurn } from "../../composerDraftStore";

import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

type QueuedComposerActionsProps = {
  queuedTurn: QueuedComposerTurn;
  onSteer: (queuedTurn: QueuedComposerTurn) => void;
  onRemove: (queuedTurnId: string) => void;
  onEdit: (queuedTurn: QueuedComposerTurn) => void;
};

function QueuedComposerActions({
  queuedTurn,
  onSteer,
  onRemove,
  onEdit,
}: QueuedComposerActionsProps) {
  return (
    <div className="flex shrink-0 items-center gap-0">
      <Button variant="subtle" size="chip" onClick={() => void onSteer(queuedTurn)}>
        <SteerIcon />
        <span>Steer</span>
      </Button>
      <IconButton
        variant="ghost"
        size="icon-chip"
        label="Delete queued follow-up"
        onClick={() => onRemove(queuedTurn.id)}
      >
        <Trash2 />
      </IconButton>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-chip"
              aria-label="Queued follow-up actions"
              className="[&_svg]:mx-0"
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end" side="top">
          <MenuItem onClick={() => onEdit(queuedTurn)}>Edit queued prompt</MenuItem>
          <MenuItem onClick={() => onRemove(queuedTurn.id)}>Delete queued prompt</MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

export { QueuedComposerActions };
