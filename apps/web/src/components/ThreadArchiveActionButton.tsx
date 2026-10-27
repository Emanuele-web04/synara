// FILE: ThreadArchiveActionButton.tsx
// Purpose: Hover-revealed archive action shared by classic thread rows and
//          Activity rows — one icon, label, sizing, and row-activation guard.
// Layer: Sidebar UI primitive
// Exports: ThreadArchiveActionButton, THREAD_ARCHIVE_ICON

import { HiOutlineArchiveBox } from "react-icons/hi2";

import type { ThreadId } from "@synara/contracts";

import { cn } from "~/lib/utils";
import { SIDEBAR_TRAILING_ICON_CLASS } from "./sidebarGlyphs";
import { SidebarIconButton } from "./SidebarIconButton";
import { useTranslation } from "~/i18n";

export const THREAD_ARCHIVE_ICON = HiOutlineArchiveBox;

export function ThreadArchiveActionButton({
  threadId,
  toneClassName,
  onArchive,
}: {
  threadId: ThreadId;
  toneClassName?: string;
  onArchive: () => void;
}) {
  const { t } = useTranslation();

  return (
    <SidebarIconButton
      icon={THREAD_ARCHIVE_ICON}
      label={t("common:archive_archiveThread")}
      title={t("common:archive_archiveThread")}
      data-testid={`thread-archive-${threadId}`}
      size="md"
      // Match the pin and the right-side meta chips (shared trailing-icon size).
      iconClassName={SIDEBAR_TRAILING_ICON_CLASS}
      className={cn("hover:text-foreground/89", toneClassName)}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onArchive();
      }}
    />
  );
}
