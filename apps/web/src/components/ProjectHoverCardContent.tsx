// rendered inside a Base UI PreviewCard (hover-open + interactive) so pin/edit rows are real controls

import { BotIcon, MessageCircleIcon, SettingsIcon, FolderIcon } from "~/lib/icons";
import { PinStatusIcon, pinActionLabel } from "~/lib/pin";
import type { ProjectAppearance } from "~/lib/projectAppearance";
import { cn } from "~/lib/utils";
import { ProjectSidebarIcon } from "./ProjectSidebarIcon";
import {
  SIDEBAR_HOVER_CARD_CONTAINER_PADDING_CLASS_NAME,
  SIDEBAR_HOVER_CARD_ROW_CLASS_NAME,
} from "./sidebarHoverCardStyles";

export type ProjectHoverCardContentProps = {
  name: string;
  cwd: string;
  appearance: ProjectAppearance | null;
  isPinned: boolean;
  chatCount: number;
  /** Display path (already home-abbreviated, e.g. ~/Developer/synara). */
  path: string;
  onTogglePin: () => void;
  onEditProject: () => void;
  onEditProjectAgent?: (() => void) | undefined;
};

const ROW_CLASS_NAME = SIDEBAR_HOVER_CARD_ROW_CLASS_NAME;
// Central glyphs paint via bg-current — the explicit text color tints them directly, one step dimmer than their label
const ICON_CLASS_NAME = "size-3.5 shrink-0 text-muted-foreground";

function formatChatCount(count: number): string {
  return `${count} ${count === 1 ? "chat" : "chats"}`;
}

export function ProjectHoverCardContent({
  name,
  cwd,
  appearance,
  isPinned,
  chatCount,
  path,
  onTogglePin,
  onEditProject,
  onEditProjectAgent,
}: ProjectHoverCardContentProps) {
  return (
    <div
      className={cn("flex w-full flex-col gap-0", SIDEBAR_HOVER_CARD_CONTAINER_PADDING_CLASS_NAME)}
    >
      <div className={cn(ROW_CLASS_NAME, "gap-2.5")}>
        <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          <ProjectSidebarIcon
            cwd={cwd}
            expanded
            appearance={appearance}
            glyphClassName="size-3.5"
          />
        </span>
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
        <FolderIcon className={ICON_CLASS_NAME} aria-hidden />
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
      {onEditProjectAgent ? (
        <button
          type="button"
          onClick={onEditProjectAgent}
          className={cn(
            ROW_CLASS_NAME,
            "cursor-pointer text-left text-foreground/80 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground",
          )}
        >
          <BotIcon className={ICON_CLASS_NAME} aria-hidden />
          <span className="min-w-0 truncate">Edit coordinator</span>
        </button>
      ) : null}
    </div>
  );
}
