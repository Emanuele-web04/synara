// FILE: EnvironmentPinnedSection.tsx
// Purpose: "Pinned" section of the Environment panel — a checklist of pinned assistant
//          messages with jump-to-message navigation, done toggling (strikethrough),
//          inline rename (double-click), and unpin. Pins are per-thread, server-synced.
// Layer: Environment panel section

import type { MessageId, PinnedMessage } from "@t3tools/contracts";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { Checkbox } from "~/components/ui/checkbox";
import { IconButton } from "~/components/ui/icon-button";
import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { displayLabelFor } from "~/pinnedMessages";

import { EnvironmentCollapsibleSection } from "./EnvironmentRow";

interface EnvironmentPinnedSectionProps {
  pins: readonly PinnedMessage[];
  /** Live text of pinned messages still present in the transcript (absent → unavailable). */
  messageTextById: ReadonlyMap<MessageId, string>;
  onJump: (messageId: MessageId) => void;
  onToggleDone: (messageId: MessageId) => void;
  onUnpin: (messageId: MessageId) => void;
  onRename: (messageId: MessageId, label: string | null) => void;
}

export function EnvironmentPinnedSection({
  pins,
  messageTextById,
  onJump,
  onToggleDone,
  onUnpin,
  onRename,
}: EnvironmentPinnedSectionProps) {
  const { t } = useTranslation();
  if (pins.length === 0) {
    return null;
  }
  return (
    <EnvironmentCollapsibleSection label={t("environment.pinned.label")}>
      <ul className="flex flex-col">
        {pins.map((pin) => (
          <PinnedMessageRow
            key={pin.messageId}
            pin={pin}
            text={messageTextById.get(pin.messageId)}
            onJump={onJump}
            onToggleDone={onToggleDone}
            onUnpin={onUnpin}
            onRename={onRename}
          />
        ))}
      </ul>
    </EnvironmentCollapsibleSection>
  );
}

const PinnedMessageRow = memo(function PinnedMessageRow({
  pin,
  text,
  onJump,
  onToggleDone,
  onUnpin,
  onRename,
}: {
  pin: PinnedMessage;
  text: string | undefined;
  onJump: (messageId: MessageId) => void;
  onToggleDone: (messageId: MessageId) => void;
  onUnpin: (messageId: MessageId) => void;
  onRename: (messageId: MessageId, label: string | null) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const jumpClickTimeoutRef = useRef<number | null>(null);
  const suppressNextBlurCommitRef = useRef(false);

  const available = text !== undefined;
  const resolvedLabel = displayLabelFor(pin, text);
  const displayLabel =
    resolvedLabel.length > 0 ? resolvedLabel : t("environment.pinned.messageUnavailable");

  const clearScheduledJump = useCallback(() => {
    if (jumpClickTimeoutRef.current !== null) {
      window.clearTimeout(jumpClickTimeoutRef.current);
      jumpClickTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (editing) {
      inputRef.current?.select();
    }
  }, [editing]);
  useEffect(() => () => clearScheduledJump(), [clearScheduledJump]);

  const beginEditing = useCallback(() => {
    clearScheduledJump();
    suppressNextBlurCommitRef.current = false;
    setDraft(resolvedLabel);
    setEditing(true);
  }, [clearScheduledJump, resolvedLabel]);

  const commitEditing = useCallback(() => {
    suppressNextBlurCommitRef.current = true;
    setEditing(false);
    const trimmed = draft.trim();
    onRename(pin.messageId, trimmed.length === 0 ? null : trimmed);
  }, [draft, onRename, pin.messageId]);

  const cancelEditing = useCallback(() => {
    suppressNextBlurCommitRef.current = true;
    setEditing(false);
  }, []);
  const handleInputBlur = useCallback(() => {
    if (suppressNextBlurCommitRef.current) {
      suppressNextBlurCommitRef.current = false;
      return;
    }
    commitEditing();
  }, [commitEditing]);

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitEditing();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelEditing();
      }
    },
    [cancelEditing, commitEditing],
  );
  const handleLabelClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (!available) {
        beginEditing();
        return;
      }
      if (event.detail > 1) {
        return;
      }
      clearScheduledJump();
      jumpClickTimeoutRef.current = window.setTimeout(() => {
        jumpClickTimeoutRef.current = null;
        onJump(pin.messageId);
      }, 180);
    },
    [available, beginEditing, clearScheduledJump, onJump, pin.messageId],
  );
  const handleLabelDoubleClick = useCallback(() => {
    beginEditing();
  }, [beginEditing]);
  const handleLabelKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "F2" || (!available && event.key === "Enter")) {
        event.preventDefault();
        beginEditing();
      }
    },
    [available, beginEditing],
  );

  return (
    <li className="group/pin flex items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-[var(--color-background-elevated-secondary)]">
      <Checkbox
        className="size-3.5 sm:size-3.5"
        checked={pin.done}
        onCheckedChange={() => onToggleDone(pin.messageId)}
        aria-label={
          pin.done ? t("environment.pinned.markNotDone") : t("environment.pinned.markDone")
        }
      />
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={handleInputBlur}
          onKeyDown={handleInputKeyDown}
          placeholder={available ? "" : t("environment.pinned.renamePlaceholder")}
          className="min-w-0 flex-1 rounded border border-input bg-background px-1 py-0.5 text-[length:var(--app-font-size-ui,12px)] text-foreground outline-none focus-visible:border-ring"
        />
      ) : (
        <button
          type="button"
          onClick={handleLabelClick}
          // A short delayed jump lets double-click rename cancel the first click's jump.
          onDoubleClick={handleLabelDoubleClick}
          onKeyDown={handleLabelKeyDown}
          aria-label={
            available
              ? t("environment.pinned.jumpOrRename")
              : t("environment.pinned.unavailableOrRename")
          }
          title={
            available
              ? t("environment.pinned.clickToJumpTitle")
              : t("environment.pinned.clickToRenameTitle")
          }
          className={cn(
            "min-w-0 flex-1 truncate text-left text-[length:var(--app-font-size-ui,12px)] outline-none transition-colors",
            pin.done
              ? "text-muted-foreground/55 line-through"
              : "text-[var(--color-text-foreground)] hover:text-foreground",
            available
              ? "cursor-pointer hover:underline"
              : "cursor-default text-muted-foreground/55",
          )}
        >
          {displayLabel}
        </button>
      )}
      <IconButton
        label={t("environment.pinned.unpinMessage")}
        tooltip={t("environment.pinned.unpin")}
        size="icon-xs"
        className="shrink-0 opacity-0 transition-opacity group-hover/pin:opacity-100 focus-visible:opacity-100"
        onClick={() => onUnpin(pin.messageId)}
      >
        <XIcon className="size-3" />
      </IconButton>
    </li>
  );
});
