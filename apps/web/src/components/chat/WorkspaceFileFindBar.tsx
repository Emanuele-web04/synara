// FILE: WorkspaceFileFindBar.tsx
// Purpose: Compact in-preview find field with match count and keyboard navigation.
// Layer: Chat/editor file-preview presentation

import { useEffect, useRef, type KeyboardEvent } from "react";

import { IconButton } from "~/components/ui/icon-button";
import { ArrowDownIcon, ArrowUpIcon, SearchIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

interface WorkspaceFileFindBarProps {
  open: boolean;
  focusNonce: number;
  query: string;
  matchCount: number;
  matchCountCapped?: boolean;
  activeIndex: number;
  onQueryChange: (query: string) => void;
  onStep: (direction: "next" | "previous") => void;
  onClose: () => void;
}

const FIND_QUERY_MAX_LENGTH = 200;
const FIND_STEP_BUTTON_CLASS_NAME =
  "size-6 rounded-md border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-muted-foreground/15 hover:text-foreground sm:size-6";

export function WorkspaceFileFindBar({
  open,
  focusNonce,
  query,
  matchCount,
  matchCountCapped = false,
  activeIndex,
  onQueryChange,
  onStep,
  onClose,
}: WorkspaceFileFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce, open]);

  if (!open) return null;

  const hasQuery = query.trim().length > 0;
  const resultLabel = hasQuery
    ? matchCount === 0
      ? "No results"
      : `${Math.min(Math.max(activeIndex, 0), matchCount - 1) + 1} / ${matchCount}${matchCountCapped ? "+" : ""}`
    : "";

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      onStep(event.shiftKey ? "previous" : "next");
    }
  };

  return (
    <div
      role="search"
      data-testid="workspace-file-find-bar"
      className="flex w-72 max-w-[calc(100vw-2rem)] items-center rounded-lg border border-border/60 bg-[var(--color-background-elevated-primary-opaque)] px-2.5 shadow-lg"
    >
      <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        maxLength={FIND_QUERY_MAX_LENGTH}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in file..."
        aria-label="Find in file"
        autoComplete="off"
        spellCheck={false}
        className="font-system-ui h-9 min-w-0 flex-1 bg-transparent px-2 text-ui text-foreground placeholder:text-muted-foreground focus:outline-none"
      />
      <span
        aria-live="polite"
        className={cn(
          "shrink-0 px-1 text-ui-xs tabular-nums",
          hasQuery ? "text-muted-foreground" : "text-transparent",
        )}
      >
        {resultLabel}
      </span>
      <IconButton
        onClick={() => onStep("previous")}
        disabled={!hasQuery || matchCount === 0}
        className={FIND_STEP_BUTTON_CLASS_NAME}
        label="Previous match (Shift+Enter)"
      >
        <ArrowUpIcon className="size-3.5" />
      </IconButton>
      <IconButton
        onClick={() => onStep("next")}
        disabled={!hasQuery || matchCount === 0}
        className={FIND_STEP_BUTTON_CLASS_NAME}
        label="Next match (Enter)"
      >
        <ArrowDownIcon className="size-3.5" />
      </IconButton>
      <IconButton
        onClick={onClose}
        className={FIND_STEP_BUTTON_CLASS_NAME}
        label="Close find (Esc)"
      >
        <XIcon className="size-3.5" />
      </IconButton>
    </div>
  );
}
