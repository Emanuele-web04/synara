// FILE: ComposerQueuedHeader.tsx
// Purpose: Queued follow-up rows stacked flush above the composer input (each with
// Steer / Delete / Edit actions). Owns the rounded-top seam so the queue and the
// input below read as one continuous surface.
// Layer: Chat composer UI
// Exports: ComposerQueuedHeader

import { memo } from "react";

import type { QueuedComposerTurn } from "../../composerDraftStore";
import { SteerIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  COMPOSER_STACKED_HEADER_FRAME_CLASS_NAME,
  COMPOSER_SURFACE_BORDER_CLASS_NAME,
} from "./composerPickerStyles";
import { QueuedComposerActions } from "./QueuedComposerActions";

interface ComposerQueuedHeaderProps {
  queuedTurns: QueuedComposerTurn[];
  // When a task-list card already sits above these rows it owns the rounded top, so
  // the first queued row stays square to keep the stacked surface seamless.
  taskListAboveComposer: boolean;
  onSteer: (queuedTurn: QueuedComposerTurn) => void;
  onRemove: (queuedTurnId: string) => void;
  onEdit: (queuedTurn: QueuedComposerTurn) => void;
}

export const ComposerQueuedHeader = memo(function ComposerQueuedHeader({
  queuedTurns,
  taskListAboveComposer,
  onSteer,
  onRemove,
  onEdit,
}: ComposerQueuedHeaderProps) {
  if (queuedTurns.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-col", COMPOSER_STACKED_HEADER_FRAME_CLASS_NAME)}>
      {queuedTurns.map((queuedTurn, queuedTurnIndex) => (
        <div
          key={queuedTurn.id}
          data-testid="queued-follow-up-row"
          className={cn(
            "chat-composer-surface flex items-center gap-2 border border-b-0 px-3 pt-2.5 pb-2.5 text-[12px]",
            COMPOSER_SURFACE_BORDER_CLASS_NAME,
            queuedTurnIndex === 0 && !taskListAboveComposer
              ? "chat-composer-stacked-top"
              : "rounded-none",
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
    </div>
  );
});
