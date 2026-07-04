// FILE: ComposerQueuedHeader.tsx
// Purpose: Queued follow-up rows shown as a panel that merges into the top of the
// composer input (each with Steer / Delete / Edit actions). Rounded only on top with
// a flat, borderless bottom that fuses flush onto the composer; spans the full composer
// width while the composer below keeps its own full rounding.
// Layer: Chat composer UI
// Exports: ComposerQueuedHeader

import { memo, useEffect, useRef } from "react";

import type { QueuedComposerTurn } from "../../composerDraftStore";
import { ClockIcon, SteerIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { formatClockElapsed } from "~/session-logic";
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
import { QueuedComposerActions } from "./QueuedComposerActions";

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

export function formatQueuedComposerWaitTimer(startIso: string, endIso: string): string {
  return formatClockElapsed(startIso, endIso) ?? "0s";
}

function formatQueuedComposerWaitTimerNow(startIso: string): string {
  return formatQueuedComposerWaitTimer(startIso, new Date().toISOString());
}

const QueuedComposerReadyTimer = memo(function QueuedComposerReadyTimer({
  createdAt,
}: {
  createdAt: string;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatQueuedComposerWaitTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatQueuedComposerWaitTimerNow(createdAt);
      }
    };
    updateText();
    const intervalId = window.setInterval(updateText, 1000);
    return () => window.clearInterval(intervalId);
  }, [createdAt]);

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[color:var(--color-border-light)] bg-[var(--composer-surface)] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground"
      title="Ready to send when the current turn finishes"
      aria-label={`Ready to send, waiting ${initialText}`}
    >
      <ClockIcon className="size-3" aria-hidden />
      <span className="hidden sm:inline">Ready</span>
      <span aria-hidden className="hidden sm:inline">
        ·
      </span>
      <span ref={textRef}>{initialText}</span>
    </span>
  );
});

interface ComposerQueuedHeaderProps {
  queuedTurns: QueuedComposerTurn[];
  onSteer: (queuedTurn: QueuedComposerTurn) => void;
  onRemove: (queuedTurnId: string) => void;
  onEdit: (queuedTurn: QueuedComposerTurn) => void;
  /** Workspace root used to resolve local file links/mentions inside the parsed preview. */
  cwd?: string | undefined;
  attachedToPrevious?: boolean;
}

export const ComposerQueuedHeader = memo(function ComposerQueuedHeader({
  queuedTurns,
  onSteer,
  onRemove,
  onEdit,
  cwd,
  attachedToPrevious = false,
}: ComposerQueuedHeaderProps) {
  if (queuedTurns.length === 0) {
    return null;
  }

  return (
    <ComposerStackedPanel attachedToPrevious={attachedToPrevious} className="flex flex-col">
      {queuedTurns.map((queuedTurn, queuedTurnIndex) => (
        <ComposerStackedPanelRow
          key={queuedTurn.id}
          compact
          data-testid="queued-follow-up-row"
          className={cn(queuedTurnIndex > 0 && COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME)}
        >
          <ComposerStackedPanelRowMain>
            <SteerIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
            <QueuedComposerReadyTimer createdAt={queuedTurn.createdAt} />
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
});
