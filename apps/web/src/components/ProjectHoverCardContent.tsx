// FILE: ProjectHoverCardContent.tsx
// Purpose: Interactive hover-card body for sidebar project/folder rows — project
//          name + pin toggle on the header line, then the chat count, the project
//          path, and a clickable "Edit project" action.
// Layer: Sidebar UI component
// Exports: ProjectHoverCardContent
// Why: Rendered inside a Base UI PreviewCard (hover-open + interactive), so the
//      pin and "Edit project" rows are real controls. Spacing/type mirror the
//      app's menu rows (12px UI font, compact padding) so it reads as native.

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

// One shared row rhythm for every line. No dividers: the card separates rows
// with even spacing only (the outer container owns the padding inset), so rows
// stay flush and read as a single clean menu. Tight vertical padding keeps the
// card slim.
const ROW_CLASS_NAME = SIDEBAR_HOVER_CARD_ROW_CLASS_NAME;
// Icons stay one step dimmer than their label so the glyph reads as a quiet
// affordance, not a peer of the text. Central glyphs paint via bg-current, so
// the explicit text color here tints them directly.
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
