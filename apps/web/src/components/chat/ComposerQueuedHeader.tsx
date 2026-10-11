// FILE: ComposerQueuedHeader.tsx
// Purpose: Queued follow-up rows shown as a panel that merges into the top of the
// composer input (each with Steer / Delete / Edit actions), led by a "Queue paused"
// notice with Resume / Edit when a stop, failure, or usage limit holds the queue. Rounded only on top with
// a flat, borderless bottom that fuses flush onto the composer; spans the full composer
// width while the composer below keeps its own full rounding.
// Layer: Chat composer UI
// Exports: ComposerQueuedHeader

import type { QueuedComposerTurn } from "../../composerDraftStore";
import type { QueuedComposerPause, QueuedComposerPauseReason } from "~/lib/queuedComposerPause";
import { PauseIcon, SteerIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import {
  ComposerStackedPanelRow,
  ComposerStackedPanelRowMain,
} from "./ComposerStackedPanelContent";
import {
  COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME,
  ComposerStackedPanel,
} from "./ComposerStackedPanel";
import {
  COMPOSER_STACKED_PANEL_ICON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_PREVIEW_MARKDOWN_CLASS_NAME,
} from "./composerStackedPanelStyles";
import { COMPOSER_INLINE_ACTION_PILL_CLASS_NAME } from "./composerPickerStyles";
import { QueuedComposerActions } from "./QueuedComposerActions";

const PAUSE_DETAIL_BY_REASON: Record<QueuedComposerPauseReason, string> = {
  stopped: "Paused after you stopped the turn",
  error: "Paused after an error",
  "usage-limit": "Paused: usage limit",
};

const PAUSE_ACTION_CLASS_NAME = cn(COMPOSER_INLINE_ACTION_PILL_CLASS_NAME, "text-ui-sm");

function QueuedComposerPausedNotice({
  pause,
  onResume,
  onEdit,
}: {
  pause: QueuedComposerPause;
  onResume: () => void;
  onEdit: () => void;
}) {
  return (
    <ComposerStackedPanelRow
      role="status"
      data-testid="queued-follow-up-paused-notice"
      // A user stop is expected and stays neutral; failures and limits get the warning tint.
      className={pause.reason === "stopped" ? undefined : "bg-warning/8"}
    >
      <ComposerStackedPanelRowMain>
        <PauseIcon
          aria-hidden
          className={
            pause.reason === "stopped"
              ? COMPOSER_STACKED_PANEL_ICON_CLASS_NAME
              : "size-3.5 shrink-0 text-warning"
          }
        />
        <span className="min-w-0 truncate text-ui-sm text-muted-foreground">
          <span className="font-medium text-foreground">Queue paused</span>
          <span aria-hidden> · </span>
          {PAUSE_DETAIL_BY_REASON[pause.reason]}
        </span>
      </ComposerStackedPanelRowMain>
      <div className="flex shrink-0 items-center gap-1.5">
        <button type="button" className={PAUSE_ACTION_CLASS_NAME} onClick={onResume}>
          Resume
        </button>
        <button type="button" className={PAUSE_ACTION_CLASS_NAME} onClick={onEdit}>
          Edit
        </button>
      </div>
    </ComposerStackedPanelRow>
  );
}

function firstNonEmptyLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0)
      ?.trim() ?? ""
  );
}

// Queue previews use the shared markdown renderer for inline chips/emphasis, but
// must stay a single composer row even when the queued prompt is a heading, list,
// or fenced code block.
export function compactQueuedComposerPreviewMarkdown(value: string): string {
  const firstLine = firstNonEmptyLine(value);
  if (firstLine.length === 0) {
    return "Queued follow-up";
  }
  if (/^(?:`{3,}|~{3,})/.test(firstLine)) {
    return "Code block";
  }
  const normalized = firstLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^- \[[ xX]\]\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
  return normalized.length > 0 ? normalized : "Queued follow-up";
}

interface ComposerQueuedHeaderProps {
  queuedTurns: QueuedComposerTurn[];
  onSteer: (queuedTurn: QueuedComposerTurn) => void;
  onRemove: (queuedTurnId: string) => void;
  onEdit: (queuedTurn: QueuedComposerTurn) => void;
  /** Set while a stop, failure, or usage limit holds the queue. */
  pause?: QueuedComposerPause | null;
  onResume?: () => void;
  /** Takes the next queued message back into the composer. */
  onEditPaused?: () => void;
  /** Workspace root used to resolve local file links/mentions inside the parsed preview. */
  cwd?: string | undefined;
  attachedToPrevious?: boolean;
}

export const ComposerQueuedHeader = function ComposerQueuedHeader({
  queuedTurns,
  onSteer,
  onRemove,
  onEdit,
  pause,
  onResume,
  onEditPaused,
  cwd,
  attachedToPrevious: attachedToPreviousProp,
}: ComposerQueuedHeaderProps) {
  const attachedToPrevious = attachedToPreviousProp ?? false;
  if (queuedTurns.length === 0) {
    return null;
  }

  return (
    <ComposerStackedPanel attachedToPrevious={attachedToPrevious} className="flex flex-col">
      {pause && onResume && onEditPaused ? (
        <QueuedComposerPausedNotice pause={pause} onResume={onResume} onEdit={onEditPaused} />
      ) : null}
      {queuedTurns.map((queuedTurn, queuedTurnIndex) => (
        <ComposerStackedPanelRow
          key={queuedTurn.id}
          compact
          data-testid="queued-follow-up-row"
          className={cn(
            (queuedTurnIndex > 0 || pause) && COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME,
          )}
        >
          <ComposerStackedPanelRowMain>
            <SteerIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
            <ChatMarkdown
              text={compactQueuedComposerPreviewMarkdown(queuedTurn.previewText)}
              cwd={cwd}
              isStreaming={false}
              className={COMPOSER_STACKED_PANEL_PREVIEW_MARKDOWN_CLASS_NAME}
            />
          </ComposerStackedPanelRowMain>
          <QueuedComposerActions
            queuedTurn={queuedTurn}
            onSteer={onSteer}
            onRemove={onRemove}
            onEdit={onEdit}
          />
        </ComposerStackedPanelRow>
      ))}
    </ComposerStackedPanel>
  );
};
