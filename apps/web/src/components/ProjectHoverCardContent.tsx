// rendered inside a Base UI PreviewCard (hover-open + interactive) so pin/edit rows are real controls

import { MessageCircleIcon, SettingsIcon } from "~/lib/icons";
import { PinStatusIcon, pinActionLabel } from "~/lib/pin";
import { cn } from "~/lib/utils";
import { FolderClosed, FolderOpen } from "./FolderClosed";
import {
  SIDEBAR_HOVER_CARD_CONTAINER_PADDING_CLASS_NAME,
  SIDEBAR_HOVER_CARD_ROW_CLASS_NAME,
} from "./sidebarHoverCardStyles";

export type ProjectHoverCardContentProps = {
  name: string;
  isPinned: boolean;
  chatCount: number;
  /** Display path (already home-abbreviated, e.g. ~/Developer/synara). */
  path: string;
  onTogglePin: () => void;
  onEditProject: () => void;
};

const ROW_CLASS_NAME = SIDEBAR_HOVER_CARD_ROW_CLASS_NAME;
// Central glyphs paint via bg-current — the explicit text color tints them directly, one step dimmer than their label
const ICON_CLASS_NAME = "size-3.5 shrink-0 text-muted-foreground";

function formatChatCount(count: number): string {
  return `${count} ${count === 1 ? "chat" : "chats"}`;
}

export function ProjectHoverCardContent({
  name,
  isPinned,
  chatCount,
  path,
  onTogglePin,
  onEditProject,
}: ProjectHoverCardContentProps) {
  return (
    <div
      className={cn("flex w-full flex-col gap-0", SIDEBAR_HOVER_CARD_CONTAINER_PADDING_CLASS_NAME)}
    >
      <div className={cn(ROW_CLASS_NAME, "gap-2.5")}>
        <FolderOpen className={ICON_CLASS_NAME} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{name}</span>
        <button
          type="button"
          aria-label={pinActionLabel(name, isPinned)}
          aria-pressed={isPinned}
          onClick={onTogglePin}
          className={cn(
            "-mr-1 shrink-0 cursor-pointer rounded-sm p-1 transition-colors",
            isPinned ? "text-foreground" : "text-muted-foreground/55 hover:text-foreground",
          )}
        >
          <PinStatusIcon pinned={isPinned} className="size-3" aria-hidden />
        </button>
      </div>
      <div className={cn(ROW_CLASS_NAME, "text-foreground/80")}>
        <MessageCircleIcon className={ICON_CLASS_NAME} aria-hidden />
        <span className="min-w-0 truncate">{formatChatCount(chatCount)}</span>
      </div>
      <div className="-mx-0.5 my-0.5 h-px bg-[color:var(--color-border)]" aria-hidden />
      <div className={cn(ROW_CLASS_NAME, "text-foreground/80")}>
        <FolderClosed className={ICON_CLASS_NAME} aria-hidden />
        <span className="min-w-0 truncate">{path}</span>
      </div>
      <div className="-mx-0.5 my-0.5 h-px bg-[color:var(--color-border)]" aria-hidden />
      <button
        type="button"
        onClick={onEditProject}
        className={cn(
          ROW_CLASS_NAME,
          "cursor-pointer text-left text-foreground/80 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground",
        )}
      >
        <SettingsIcon className={ICON_CLASS_NAME} aria-hidden />
        <span className="min-w-0 truncate">Edit project</span>
      </button>
    </div>
  );
}
