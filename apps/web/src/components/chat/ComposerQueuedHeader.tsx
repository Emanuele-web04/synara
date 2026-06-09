// FILE: ComposerQueuedHeader.tsx
// Purpose: Queued follow-up rows shown as a panel that merges into the top of the
// composer input (each with Steer / Delete / Edit actions). Rounded only on top with
// a flat, borderless bottom that fuses flush onto the composer; sits at 11/12 of the
// composer width while the composer below keeps its own full rounding.
// Layer: Chat composer UI
// Exports: ComposerQueuedHeader

import { memo } from "react";

import type { QueuedComposerTurn } from "../../composerDraftStore";
import { SteerIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME,
  ComposerStackedPanel,
} from "./ComposerStackedPanel";
import { QueuedComposerActions } from "./QueuedComposerActions";

interface ComposerQueuedHeaderProps {
  queuedTurns: QueuedComposerTurn[];
  onSteer: (queuedTurn: QueuedComposerTurn) => void;
  onRemove: (queuedTurnId: string) => void;
  onEdit: (queuedTurn: QueuedComposerTurn) => void;
  attachedToPrevious?: boolean;
}

export const ComposerQueuedHeader = memo(function ComposerQueuedHeader({
  queuedTurns,
  onSteer,
  onRemove,
  onEdit,
  attachedToPrevious = false,
}: ComposerQueuedHeaderProps) {
  if (queuedTurns.length === 0) {
    return null;
  }

  return (
    <ComposerStackedPanel attachedToPrevious={attachedToPrevious} className="flex flex-col">
      {queuedTurns.map((queuedTurn, queuedTurnIndex) => (
        <div
          key={queuedTurn.id}
          data-testid="queued-follow-up-row"
          className={cn(
            "flex items-center gap-2 px-3 pt-1.5 pb-1.5 text-[12px]",
            queuedTurnIndex > 0 && COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME,
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <SteerIcon className="size-3 shrink-0 text-[var(--color-text-foreground-secondary)]" />
            <span className="truncate text-[12px] font-medium text-foreground/85">
              {queuedTurn.previewText}
            </span>
          </div>
          <QueuedComposerActions
            queuedTurn={queuedTurn}
            onSteer={onSteer}
            onRemove={onRemove}
            onEdit={onEdit}
          />
        </div>
      ))}
    </ComposerStackedPanel>
  );
});
