// FILE: SidebarArchivedThreadsSection.tsx
// Purpose: The sidebar's Archived section — the archived chats the sidebar hides,
//          listed with their project and archive time and restored from the row.
// Layer: Sidebar UI section
// Exports: SidebarArchivedThreadsSection

import { useMemo, useState } from "react";

import type { ProjectId, ThreadId } from "@synara/contracts";

import { formatRelativeTime } from "~/lib/relativeTime";
import { Undo2Icon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
  SIDEBAR_ROW_GAP_CLASS_NAME,
  SIDEBAR_ROW_HEIGHT_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_PADDING_CLASS_NAME,
  SIDEBAR_ROW_RADIUS_CLASS_NAME,
  sidebarHoverRevealHideClassName,
} from "~/sidebarRowStyles";
import type { SidebarThreadSummary } from "../types";
import { ProviderIcon } from "./ProviderIcon";
import { resolveSidebarThreadListPaging } from "./Sidebar.logic";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarCollapsibleSection, SidebarShowMoreRow } from "./SidebarListSection";
import { SidebarRowHoverActions } from "./SidebarRowHoverActions";
import { SIDEBAR_TRAILING_ICON_CLASS } from "./sidebarGlyphs";

// Same paging rhythm as the Snoozed section beside it: one screenful of rows, then
// "Show more" — the section is folded by default, so it never pushes the sidebar down.
const ARCHIVED_LIST_BASE_LIMIT = 20;
const ARCHIVED_LIST_PAGE_SIZE = 20;

/**
 * Folds the archive of chats the sidebar hides. A row keeps its project context, so it
 * reads as a chat the user set aside rather than an anonymous title.
 */
export type SidebarArchivedProjectLabel = (projectId: ProjectId) => string | null;

function SidebarArchivedThreadRow({
  thread,
  projectLabel,
  onRestore,
}: {
  thread: SidebarThreadSummary;
  projectLabel: string | null;
  onRestore: (threadId: ThreadId) => void;
}) {
  const provider = thread.session?.provider ?? thread.modelSelection.provider;
  const archivedLabel = thread.archivedAt ? formatRelativeTime(thread.archivedAt) : null;

  return (
    <div
      data-testid={`archived-thread-${thread.id}`}
      className={cn(
        "group/thread-row relative flex min-w-0 items-center",
        SIDEBAR_ROW_HEIGHT_CLASS_NAME,
        SIDEBAR_ROW_GAP_CLASS_NAME,
        SIDEBAR_ROW_RADIUS_CLASS_NAME,
        SIDEBAR_ROW_PADDING_CLASS_NAME,
        SIDEBAR_ROW_FOCUS_CLASS_NAME,
        SIDEBAR_ROW_HOVER_CLASS_NAME,
      )}
    >
      <ProviderIcon provider={provider} className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-ui leading-5 text-muted-foreground">
        {thread.title}
      </span>
      {/* Meta yields its slot to the restore button, exactly like a live thread row. */}
      {projectLabel ? (
        <span
          title={projectLabel}
          className={cn(
            "min-w-0 max-w-[40%] shrink truncate text-ui-xs text-muted-foreground/58",
            sidebarHoverRevealHideClassName("thread-row"),
          )}
        >
          {projectLabel}
        </span>
      ) : null}
      {archivedLabel ? (
        <span
          className={cn(
            "shrink-0 text-ui-xs text-muted-foreground/42",
            sidebarHoverRevealHideClassName("thread-row"),
          )}
        >
          {archivedLabel}
        </span>
      ) : null}
      <SidebarRowHoverActions threadId={thread.id}>
        <SidebarIconButton
          icon={Undo2Icon}
          label={`Restore ${thread.title}`}
          title="Restore thread"
          size="md"
          iconClassName={SIDEBAR_TRAILING_ICON_CLASS}
          className="hover:text-foreground/89 text-muted-foreground/42"
          data-testid={`thread-restore-${thread.id}`}
          onClick={() => onRestore(thread.id)}
        />
      </SidebarRowHoverActions>
    </div>
  );
}

/**
 * Folds like the Snoozed section it sits beside. Rows stay mounted while folded so a
 * reopen animates through the shared disclosure motion instead of snapping in.
 */
export function SidebarArchivedThreadsSection({
  threads,
  resolveProjectLabel,
  open,
  onToggle,
  onRestore,
}: {
  threads: readonly SidebarThreadSummary[];
  resolveProjectLabel: SidebarArchivedProjectLabel;
  open: boolean;
  onToggle: () => void;
  onRestore: (threadId: ThreadId) => void;
}) {
  const [extraPages, setExtraPages] = useState(0);
  const paging = resolveSidebarThreadListPaging({
    totalCount: threads.length,
    baseLimit: ARCHIVED_LIST_BASE_LIMIT,
    pageSize: ARCHIVED_LIST_PAGE_SIZE,
    requestedExtraPages: extraPages,
  });
  const visibleThreads = useMemo(
    () => threads.slice(0, paging.previewLimit),
    [paging.previewLimit, threads],
  );

  if (threads.length === 0) return null;

  return (
    <SidebarCollapsibleSection label="Archived" open={open} onToggle={onToggle}>
      {visibleThreads.map((thread) => (
        <SidebarArchivedThreadRow
          key={thread.id}
          thread={thread}
          projectLabel={resolveProjectLabel(thread.projectId)}
          onRestore={onRestore}
        />
      ))}
      <SidebarShowMoreRow
        canShowMore={paging.canShowMore}
        canShowLess={paging.canShowLess}
        onShowMore={() => setExtraPages(paging.effectiveExtraPages + 1)}
        onShowLess={() => setExtraPages(Math.max(0, paging.effectiveExtraPages - 1))}
      />
    </SidebarCollapsibleSection>
  );
}
