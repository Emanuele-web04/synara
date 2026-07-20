// FILE: EnvironmentEditableChecklistRow.tsx
// Purpose: Shared editable checklist-row interaction for pinned messages and transcript markers.
// Layer: Environment panel UI primitive

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { Checkbox } from "~/components/ui/checkbox";
import { IconButton } from "~/components/ui/icon-button";
import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

const JUMP_CLICK_DELAY_MS = 180;

interface EnvironmentEditableChecklistRowProps {
  checked: boolean | undefined;
  available: boolean;
  displayLabel: string;
  initialEditLabel: string;
  editPlaceholder?: string;
  checkboxAriaLabel: string;
  labelAriaLabel: string;
  labelTitle: string;
  removeLabel: string;
  removeTooltip: string;
  leading?: ReactNode;
  className?: string;
  removeButtonClassName?: string;
  onJump: () => void;
  onToggleDone: () => void;
  onRemove: () => void;
  onRename: (label: string | null) => void;
}

export function EnvironmentEditableChecklistRow({
  checked,
  available,
  displayLabel,
  initialEditLabel,
  editPlaceholder,
  checkboxAriaLabel,
  labelAriaLabel,
  labelTitle,
  removeLabel,
  removeTooltip,
  leading,
  className,
  removeButtonClassName,
  onJump,
  onToggleDone,
  onRemove,
  onRename,
}: EnvironmentEditableChecklistRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const jumpClickTimeoutRef = useRef<number | null>(null);
  const suppressNextBlurCommitRef = useRef(false);

  const clearScheduledJump = () => {
    if (jumpClickTimeoutRef.current !== null) {
      window.clearTimeout(jumpClickTimeoutRef.current);
      jumpClickTimeoutRef.current = null;
    }
  };

  useEffect(() => {
    if (editing) {
      inputRef.current?.select();
    }
  }, [editing]);
  useEffect(() => () => clearScheduledJump(), [clearScheduledJump]);

  const beginEditing = () => {
    clearScheduledJump();
    suppressNextBlurCommitRef.current = false;
    setDraft(initialEditLabel);
    setEditing(true);
  };

  const commitEditing = () => {
    suppressNextBlurCommitRef.current = true;
    setEditing(false);
    const trimmed = draft.trim();
    onRename(trimmed.length === 0 ? null : trimmed);
  };

  const cancelEditing = () => {
    suppressNextBlurCommitRef.current = true;
    setEditing(false);
  };

  const handleInputBlur = () => {
    if (suppressNextBlurCommitRef.current) {
      suppressNextBlurCommitRef.current = false;
      return;
    }
    commitEditing();
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitEditing();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelEditing();
    }
  };

  const handleLabelClick = (event: MouseEvent<HTMLButtonElement>) => {
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
      onJump();
    }, JUMP_CLICK_DELAY_MS);
  };

  const handleLabelKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "F2" || (!available && event.key === "Enter")) {
      event.preventDefault();
      beginEditing();
    }
  };

  return (
    <li
      className={cn(
        "flex items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-[var(--color-background-elevated-secondary)]",
        className,
      )}
    >
      <Checkbox
        className="size-3.5 sm:size-3.5"
        checked={checked}
        onCheckedChange={onToggleDone}
        aria-label={checkboxAriaLabel}
      />
      {leading}
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={handleInputBlur}
          onKeyDown={handleInputKeyDown}
          placeholder={editPlaceholder}
          className="min-w-0 flex-1 rounded border border-input bg-background px-1 py-0.5 text-[length:var(--app-font-size-ui,12px)] text-foreground outline-none focus-visible:border-ring"
        />
      ) : (
        <button
          type="button"
          onClick={handleLabelClick}
          onDoubleClick={beginEditing}
          onKeyDown={handleLabelKeyDown}
          aria-label={labelAriaLabel}
          title={labelTitle}
          className={cn(
            "min-w-0 flex-1 truncate text-left text-[length:var(--app-font-size-ui,12px)] outline-none transition-colors",
            checked
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
        label={removeLabel}
        tooltip={removeTooltip}
        size="icon-xs"
        className={cn(
          "shrink-0 opacity-0 transition-opacity focus-visible:opacity-100",
          removeButtonClassName,
        )}
        onClick={onRemove}
      >
        <XIcon className="size-3" />
      </IconButton>
    </li>
  );
}
