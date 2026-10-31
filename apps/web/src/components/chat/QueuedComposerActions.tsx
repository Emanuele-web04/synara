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
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { useTranslation } from "~/i18n";

type QueuedComposerActionsProps = {
  queuedTurn: QueuedComposerTurn;
  onSteer: (queuedTurn: QueuedComposerTurn) => void;
  onRemove: (queuedTurnId: string) => void;
  onEdit: (queuedTurn: QueuedComposerTurn) => void;
  steerDisabled?: boolean | undefined;
};

function QueuedComposerActions({
  queuedTurn,
  onSteer,
  onRemove,
  onEdit,
  steerDisabled,
}: QueuedComposerActionsProps) {
  const { t } = useTranslation();

  return (
    <div className="flex shrink-0 items-center gap-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="chip"
              disabled={steerDisabled}
              onClick={() => void onSteer(queuedTurn)}
            />
          }
        >
          <SteerIcon />
          <span>{t("chat:queuedActions_steer")}</span>
        </TooltipTrigger>
        <TooltipPopup className="max-w-80 leading-tight">
          {t("chat:sendThisFollowUpNowToRedirectTheCurrent")}
        </TooltipPopup>
      </Tooltip>
      <IconButton
        variant="ghost"
        size="icon-chip"
        label={t("chat:queuedActions_deleteQueued")}
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
              aria-label={t("chat:queuedActions_queuedActions")}
              className="[&_svg]:mx-0"
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <ComposerPickerMenuPopup align="end" side="top" sideOffset={6}>
          <MenuItem onClick={() => onEdit(queuedTurn)}>{t("chat:editQueuedFollowUp")}</MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
    </div>
  );
}

export { QueuedComposerActions };
