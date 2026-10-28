import type { MouseEvent } from "react";
import type { ThreadId } from "@synara/contracts";

import { CircleCheckIcon, Undo2Icon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { SidebarIconButton } from "./SidebarIconButton";
import { SIDEBAR_TRAILING_ICON_CLASS } from "./sidebarGlyphs";
import { ThreadArchiveActionButton } from "./ThreadArchiveActionButton";
import { ThreadPinToggleButton } from "./ThreadPinToggleButton";

/** The same pin, archive and completion controls serve local and remote thread rows. */
export function ThreadRowQuickActions({
  threadId,
  isPinned,
  isSettled,
  isSnoozed = false,
  disabled = false,
  archiveDisabled = false,
  toneClassName = "text-muted-foreground/42",
  onTogglePinned,
  onArchive,
  onDone,
}: {
  threadId: ThreadId;
  isPinned: boolean;
  isSettled: boolean;
  isSnoozed?: boolean;
  disabled?: boolean;
  archiveDisabled?: boolean;
  toneClassName?: string;
  onTogglePinned: () => void;
  onArchive: () => void;
  onDone: () => void;
}) {
  const stopActivation = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const doneLabel = isSnoozed ? "Return now" : isSettled ? "Undo" : "Done";
  return (
    <span
      className="pointer-events-auto inline-flex items-center gap-1"
      onDoubleClick={stopActivation}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <ThreadPinToggleButton
        pinned={isPinned}
        presentation="inline"
        disabled={disabled}
        toneClassName={toneClassName}
        onToggle={(event) => {
          stopActivation(event);
          onTogglePinned();
        }}
      />
      <ThreadArchiveActionButton
        threadId={threadId}
        disabled={disabled || archiveDisabled}
        toneClassName={toneClassName}
        onArchive={onArchive}
      />
      <SidebarIconButton
        icon={isSnoozed || isSettled ? Undo2Icon : CircleCheckIcon}
        label={doneLabel}
        title={doneLabel}
        disabled={disabled}
        iconClassName={SIDEBAR_TRAILING_ICON_CLASS}
        className={cn("hover:text-foreground/89", toneClassName)}
        onMouseDown={stopActivation}
        onClick={(event) => {
          stopActivation(event);
          onDone();
        }}
      />
    </span>
  );
}
