// FILE: Sidebar.threadHoverActions.tsx
// Purpose: Thread-row archive confirmation and hover actions (pin toggle + archive) extracted from Sidebar.tsx.
// Layer: Sidebar presentation (component).
// Exports: SidebarThreadArchiveAction, SidebarThreadHoverActions

import { HiOutlineArchiveBox } from "react-icons/hi2";
import type { ThreadId } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarRowHoverActions } from "./SidebarRowHoverActions";
import { ThreadPinToggleButton } from "./ThreadPinToggleButton";

interface SidebarThreadArchiveActionProps {
  threadId: ThreadId;
  toneClassName: string;
  isPendingConfirmation: boolean;
  compact?: boolean | undefined;
  onConfirmArchive: (threadId: ThreadId) => void;
  onRequestArchive: (threadId: ThreadId) => void;
}

export function SidebarThreadArchiveAction({
  threadId,
  toneClassName,
  isPendingConfirmation,
  compact: compactOption,
  onConfirmArchive,
  onRequestArchive,
}: SidebarThreadArchiveActionProps) {
  const compact = compactOption === true;

  if (isPendingConfirmation) {
    return (
      <button
        type="button"
        aria-label="Confirm archive"
        title="Confirm archive"
        className={cn(
          "pointer-events-auto inline-flex h-5 items-center rounded-full px-2.5 text-[10px] font-normal leading-none tracking-[-0.01em] opacity-100 transition-colors",
          "bg-red-400/12 text-red-400 hover:bg-red-400/16 hover:text-red-300",
          "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-red-400/45",
          compact ? "h-4.5 px-1.5 text-[10px]" : undefined,
        )}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onConfirmArchive(threadId);
        }}
      >
        <span>Confirm</span>
      </button>
    );
  }

  return (
    <SidebarIconButton
      icon={HiOutlineArchiveBox}
      label="Archive thread"
      title="Archive thread"
      data-testid={`thread-archive-${threadId}`}
      size={compact ? "sm" : "md"}
      glyph={compact ? "compact" : "meta"}
      className={cn("hover:text-foreground/89", toneClassName)}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onRequestArchive(threadId);
      }}
    />
  );
}

interface SidebarThreadHoverActionsProps {
  threadId: ThreadId;
  toneClassName: string;
  pinned: boolean;
  isPendingConfirmation: boolean;
  compact?: boolean | undefined;
  onConfirmArchive: (threadId: ThreadId) => void;
  onRequestArchive: (threadId: ThreadId) => void;
  onTogglePin: (threadId: ThreadId) => void;
}

export function SidebarThreadHoverActions({
  threadId,
  toneClassName,
  pinned,
  isPendingConfirmation,
  compact: compactOption,
  onConfirmArchive,
  onRequestArchive,
  onTogglePin,
}: SidebarThreadHoverActionsProps) {
  const compact = compactOption === true;

  return (
    <SidebarRowHoverActions threadId={threadId} pinnedVisible={isPendingConfirmation}>
      {isPendingConfirmation ? (
        <button
          type="button"
          aria-label="Confirm archive"
          title="Confirm archive"
          className={cn(
            "pointer-events-auto inline-flex h-5 items-center rounded-full px-2.5 text-[10px] font-normal leading-none tracking-[-0.01em] opacity-100 transition-colors",
            "bg-red-400/12 text-red-400 hover:bg-red-400/16 hover:text-red-300",
            "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-red-400/45",
            compact ? "h-4.5 px-1.5 text-[10px]" : undefined,
          )}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onConfirmArchive(threadId);
          }}
        >
          <span>Confirm</span>
        </button>
      ) : (
        <div className="pointer-events-auto inline-flex items-center gap-1">
          <ThreadPinToggleButton
            pinned={pinned}
            presentation="inline"
            toneClassName={toneClassName}
            onToggle={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onTogglePin(threadId);
            }}
          />
          <SidebarThreadArchiveAction
            threadId={threadId}
            toneClassName={toneClassName}
            isPendingConfirmation={false}
            compact={compact}
            onConfirmArchive={onConfirmArchive}
            onRequestArchive={onRequestArchive}
          />
        </div>
      )}
    </SidebarRowHoverActions>
  );
}
