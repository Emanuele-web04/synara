// FILE: EnvironmentMarkersSection.tsx
// Purpose: "Markers" section of the Environment panel for highlighted transcript text.
// Layer: Environment panel section

import type { MessageId, ThreadMarker, ThreadMarkerId } from "@t3tools/contracts";
import { isThreadMarkerAvailable } from "@t3tools/shared/threadMarkers";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { Checkbox } from "~/components/ui/checkbox";
import { IconButton } from "~/components/ui/icon-button";
import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { deriveThreadMarkerLabel } from "~/threadMarkers";

import { EnvironmentCollapsibleSection } from "./EnvironmentRow";

const MARKER_SWATCH_CLASS: Record<ThreadMarker["color"], string> = {
  yellow: "bg-[#facc15]",
  blue: "bg-[#38bdf8]",
  green: "bg-[#34d399]",
  pink: "bg-[#f472b6]",
};

interface EnvironmentMarkersSectionProps {
  markers: readonly ThreadMarker[];
  messageTextById: ReadonlyMap<MessageId, string>;
  onJump: (marker: ThreadMarker) => void;
  onToggleDone: (markerId: ThreadMarkerId) => void;
  onRemove: (markerId: ThreadMarkerId) => void;
  onRename: (markerId: ThreadMarkerId, label: string | null) => void;
}

export function EnvironmentMarkersSection({
  markers,
  messageTextById,
  onJump,
  onToggleDone,
  onRemove,
  onRename,
}: EnvironmentMarkersSectionProps) {
  if (markers.length === 0) {
    return null;
  }
  return (
    <EnvironmentCollapsibleSection label="Markers">
      <ul className="flex flex-col">
        {markers.map((marker) => (
          <MarkerRow
            key={marker.id}
            marker={marker}
            text={messageTextById.get(marker.messageId)}
            onJump={onJump}
            onToggleDone={onToggleDone}
            onRemove={onRemove}
            onRename={onRename}
          />
        ))}
      </ul>
    </EnvironmentCollapsibleSection>
  );
}

const MarkerRow = memo(function MarkerRow({
  marker,
  text,
  onJump,
  onToggleDone,
  onRemove,
  onRename,
}: {
  marker: ThreadMarker;
  text: string | undefined;
  onJump: (marker: ThreadMarker) => void;
  onToggleDone: (markerId: ThreadMarkerId) => void;
  onRemove: (markerId: ThreadMarkerId) => void;
  onRename: (markerId: ThreadMarkerId, label: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const jumpClickTimeoutRef = useRef<number | null>(null);
  const suppressNextBlurCommitRef = useRef(false);

  const available = text !== undefined && isThreadMarkerAvailable(marker, text);
  const resolvedLabel = marker.label?.trim() || deriveThreadMarkerLabel(marker);
  const displayLabel = available ? resolvedLabel : `${resolvedLabel} (unavailable)`;

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
    setDraft(marker.label ?? resolvedLabel);
    setEditing(true);
  }, [clearScheduledJump, marker.label, resolvedLabel]);

  const commitEditing = useCallback(() => {
    suppressNextBlurCommitRef.current = true;
    setEditing(false);
    const trimmed = draft.trim();
    onRename(marker.id, trimmed.length === 0 ? null : trimmed);
  }, [draft, marker.id, onRename]);

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
        onJump(marker);
      }, 180);
    },
    [available, beginEditing, clearScheduledJump, marker, onJump],
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
    <li className="group/marker flex items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-[var(--color-background-elevated-secondary)]">
      <Checkbox
        className="size-3.5 sm:size-3.5"
        checked={marker.done}
        onCheckedChange={() => onToggleDone(marker.id)}
        aria-label={marker.done ? "Mark not done" : "Mark done"}
      />
      <span
        aria-hidden="true"
        className={cn("size-2.5 shrink-0 rounded-full", MARKER_SWATCH_CLASS[marker.color])}
      />
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={handleInputBlur}
          onKeyDown={handleInputKeyDown}
          className="min-w-0 flex-1 rounded border border-input bg-background px-1 py-0.5 text-[length:var(--app-font-size-ui,12px)] text-foreground outline-none focus-visible:border-ring"
        />
      ) : (
        <button
          type="button"
          onClick={handleLabelClick}
          onDoubleClick={handleLabelDoubleClick}
          onKeyDown={handleLabelKeyDown}
          aria-label={
            available
              ? "Jump to marker. Press F2 to rename."
              : "Marker unavailable. Press Enter to rename."
          }
          title={
            available
              ? "Click to jump · double-click or press F2 to rename"
              : "Source text changed or is unavailable"
          }
          className={cn(
            "min-w-0 flex-1 truncate text-left text-[length:var(--app-font-size-ui,12px)] outline-none transition-colors",
            marker.done
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
        label="Remove marker"
        tooltip="Remove"
        size="icon-xs"
        className="shrink-0 opacity-0 transition-opacity group-hover/marker:opacity-100 focus-visible:opacity-100"
        onClick={() => onRemove(marker.id)}
      >
        <XIcon className="size-3" />
      </IconButton>
    </li>
  );
});
