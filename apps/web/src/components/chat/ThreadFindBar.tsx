// FILE: ThreadFindBar.tsx
// Purpose: Compact in-thread find panel floating at the top-right of the chat
//   column — field + close on top, prev/next + match count below.
// Layer: Chat transcript presentation
// Depends on: projected-message matching in threadFind.logic (not the DOM list).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { IconButton } from "~/components/ui/icon-button";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import { type TimelineEntry } from "../../session-logic";
import {
  collectThreadFindDocuments,
  findThreadMatches,
  normalizeFindQuery,
  resolveThreadFindJump,
  stepThreadFindIndex,
  type ThreadFindHighlight,
  type ThreadFindMatch,
} from "./threadFind.logic";

interface ThreadFindBarProps {
  open: boolean;
  focusNonce: number;
  timelineEntries: readonly TimelineEntry[];
  onClose: () => void;
  onJump: (match: ThreadFindMatch) => void;
  onHighlightChange: (highlight: ThreadFindHighlight | null) => void;
}

const FIND_QUERY_MAX_LENGTH = 200;

const FIND_STEP_BUTTON_CLASS_NAME =
  "size-6 rounded-md border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-muted-foreground/15 hover:text-foreground sm:size-6";

export function ThreadFindBar({
  open,
  focusNonce,
  timelineEntries,
  onClose,
  onJump,
  onHighlightChange,
}: ThreadFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<ThreadFindMatch[]>([]);
  const onJumpRef = useRef(onJump);
  const onHighlightChangeRef = useRef(onHighlightChange);
  onJumpRef.current = onJump;
  onHighlightChangeRef.current = onHighlightChange;
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const documents = useMemo(
    () => (open ? collectThreadFindDocuments(timelineEntries) : []),
    [open, timelineEntries],
  );
  const matches = useMemo(() => findThreadMatches(documents, query), [documents, query]);
  matchesRef.current = matches;
  const matchCount = matches.length;
  const safeIndex = matchCount === 0 ? -1 : Math.min(Math.max(activeIndex, 0), matchCount - 1);
  const hasQuery = normalizeFindQuery(query).length > 0;

  useEffect(() => {
    if (!open) {
      onHighlightChangeRef.current(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    onHighlightChangeRef.current({
      query,
      activeMatch: resolveThreadFindJump(matches, safeIndex),
    });
  }, [matches, open, query, safeIndex]);

  // Jump only when the user changes the query or steps matches — not on every
  // streaming transcript rewrite, which would yank the viewport mid-read.
  useEffect(() => {
    if (!open || safeIndex < 0) {
      return;
    }
    const match = matchesRef.current[safeIndex];
    if (match) {
      onJumpRef.current(match);
    }
  }, [open, query, safeIndex]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const input = inputRef.current;
    if (!input) {
      return;
    }
    if (document.activeElement !== input && input.value.trim().length === 0) {
      const selected = window.getSelection()?.toString().trim() ?? "";
      if (selected.length > 0) {
        setQuery(selected.slice(0, FIND_QUERY_MAX_LENGTH));
        setActiveIndex(0);
      }
    }
    input.focus();
    input.select();
  }, [focusNonce, open]);

  const handleQueryChange = (nextQuery: string) => {
    setQuery(nextQuery);
    setActiveIndex(0);
  };

  const handleStep = (direction: "next" | "previous") => {
    if (matchCount === 0) {
      return;
    }
    setActiveIndex((current) => stepThreadFindIndex(matchCount, current, direction));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      handleStep(event.shiftKey ? "previous" : "next");
    }
  };

  return (
    <div
      role="search"
      data-testid="thread-find-bar"
      data-thread-find-layout="panel"
      className="flex w-72 max-w-[calc(100vw-2rem)] flex-col rounded-xl border border-border bg-[var(--color-background-elevated-primary-opaque)] shadow-md"
    >
      <div className="flex items-center gap-2 border-b border-border px-2.5">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => handleQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Find in thread"
          aria-label="Find in thread"
          autoComplete="off"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 bg-transparent text-[length:var(--app-font-size-ui,12px)] text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        <div aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
        <IconButton
          onClick={onClose}
          className={FIND_STEP_BUTTON_CLASS_NAME}
          label="Close find (Esc)"
        >
          <XIcon className="size-4" />
        </IconButton>
      </div>
      <div className="flex items-center justify-between gap-2 px-2 py-1.5">
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            onClick={() => handleStep("previous")}
            disabled={matchCount === 0}
            className={FIND_STEP_BUTTON_CLASS_NAME}
            label="Previous match (Shift+Enter)"
          >
            <ChevronUpIcon className="size-4" />
          </IconButton>
          <IconButton
            onClick={() => handleStep("next")}
            disabled={matchCount === 0}
            className={FIND_STEP_BUTTON_CLASS_NAME}
            label="Next match (Enter)"
          >
            <ChevronDownIcon className="size-4" />
          </IconButton>
        </div>
        <span
          className={cn(
            "min-w-0 truncate pr-1 text-right text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums",
            MUTED_LABEL_TEXT_CLASS_NAME,
          )}
          aria-live="polite"
        >
          {hasQuery
            ? matchCount === 0
              ? "No results"
              : `${safeIndex + 1} / ${matchCount} results`
            : ""}
        </span>
      </div>
    </div>
  );
}

export function ChatThreadFindHost({
  open,
  focusNonce,
  timelineEntries,
  threadId,
  onClose,
  onJump,
  onHighlightChange,
}: ThreadFindBarProps & {
  threadId: string;
}) {
  return (
    // z-30 stacks the panel above the docked Environment overlay (z-20) so find
    // stays pinned to the chat column's top-right corner.
    <div data-thread-find-host="true" className="pointer-events-none absolute right-0 top-0 z-30">
      {/* Content padding keeps the panel shadow inside the disclosure clip box
          and keeps the card off the column borders. */}
      <DisclosureRegion open={open} contentClassName="pointer-events-auto p-3">
        <ThreadFindBar
          key={threadId}
          open={open}
          focusNonce={focusNonce}
          timelineEntries={timelineEntries}
          onClose={onClose}
          onJump={onJump}
          onHighlightChange={onHighlightChange}
        />
      </DisclosureRegion>
    </div>
  );
}
