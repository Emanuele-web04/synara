// FILE: SidebarActivityView.tsx
// Purpose: Task-feed sidebar surface — every thread is a task row (project /
//          title / provider + branch) grouped by status, with settle/unsettle.
// Layer: Sidebar UI component
// Exports: SidebarActivityView

import { useState, type MouseEvent, type ReactNode } from "react";

import type { ProjectId, ThreadId } from "@synara/contracts";

import {
  CircleCheckIcon,
  GitBranchIcon,
  ListChecksIcon,
  PinFilledIcon,
  Undo2Icon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { TimestampFormat } from "../appSettings";
import {
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
} from "../sidebarRowStyles";
import type { Project, SidebarThreadSummary } from "../types";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { FolderClosed } from "./FolderClosed";
import { ProviderIcon } from "./ProviderIcon";
import { PrStateChip } from "./pullRequest/PrStateChip";
import {
  createSidebarThreadHoverAnchorId,
  resolveSidebarThreadListPaging,
  resolveThreadProjectLabel,
  type ThreadStatusPill,
} from "./Sidebar.logic";
import {
  buildActivityViewModel,
  collectActivityScopeOptions,
  collectUnreadActivityThreads,
  formatActivityRowTime,
  splitActivityThreadsByDateBucket,
  splitRecentActivityThreads,
  type ActivityScopeOption,
} from "./SidebarActivityView.logic";
import { SIDEBAR_TRAILING_ICON_CLASS } from "./sidebarGlyphs";
import { SIDEBAR_HOVER_CARD_TRIGGER_PROPS } from "./sidebarHoverCardStyles";
import { SidebarIconButton } from "./SidebarIconButton";
import { ThreadArchiveActionButton } from "./ThreadArchiveActionButton";
import { ThreadPinToggleButton } from "./ThreadPinToggleButton";
import { ThreadStatusPillChip } from "./ThreadStatusPillChip";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import { Menu, MenuGroup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipTrigger } from "./ui/tooltip";

const ACTIVITY_LIST_BASE_LIMIT = 20;
const ACTIVITY_LIST_PAGE_SIZE = 20;

function ActivityThreadRow({
  thread,
  project,
  isActive,
  isSettled,
  isPinned,
  status,
  timeLabel,
  onOpen,
  onSetSettled,
  onTogglePinned,
  onArchive,
  renderHoverCard,
}: {
  thread: SidebarThreadSummary;
  project: Project | undefined;
  isActive: boolean;
  isSettled: boolean;
  isPinned: boolean;
  status: ThreadStatusPill | null;
  timeLabel: string;
  onOpen: () => void;
  onSetSettled: (settled: boolean) => void;
  onTogglePinned: () => void;
  onArchive: () => void;
  renderHoverCard: (anchorId: string) => ReactNode;
}) {
  const provider = thread.session?.provider ?? thread.modelSelection.provider;
  const branch = thread.associatedWorktreeBranch?.trim() || thread.branch?.trim() || null;
  const hoverAnchorId = createSidebarThreadHoverAnchorId({
    scope: "activity",
    threadId: thread.id,
  });
  const stopRowActivation = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const actionToneClassName = "text-muted-foreground/42";

  return (
    <Tooltip>
      <TooltipTrigger
        {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
        render={
          <div
            data-thread-hover-anchor={hoverAnchorId}
            className="group/activity-row relative"
            data-thread-item
          />
        }
      >
        <button
          type="button"
          onClick={onOpen}
          data-testid={`activity-thread-${thread.id}`}
          className={cn(
            "flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-lg px-2.5 py-2 text-left select-none",
            SIDEBAR_ROW_FOCUS_CLASS_NAME,
            isActive ? SIDEBAR_ROW_ACTIVE_CLASS_NAME : SIDEBAR_ROW_HOVER_CLASS_NAME,
            isSettled && "opacity-55 transition-opacity hover:opacity-85",
          )}
        >
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 transition-[padding] duration-150 ease-out",
              // Yield row 1 to the hover action cluster (pin + archive + done).
              "group-hover/activity-row:pr-[4.25rem] group-focus-within/activity-row:pr-[4.25rem]",
            )}
          >
            <FolderClosed className="size-3 shrink-0 text-muted-foreground/90" aria-hidden />
            <span className="min-w-0 truncate text-[11px] text-muted-foreground/95">
              {resolveThreadProjectLabel(project)}
            </span>
            {isPinned ? (
              <PinFilledIcon
                className="size-2.5 shrink-0 text-muted-foreground/60"
                aria-label="Pinned"
              />
            ) : null}
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/55 transition-opacity group-hover/activity-row:opacity-0 group-focus-within/activity-row:opacity-0">
              {timeLabel}
            </span>
          </span>
          <span
            className={cn(
              "min-w-0 truncate text-[13px] leading-snug font-medium",
              isActive ? "text-foreground" : "text-foreground/90",
            )}
          >
            {thread.title}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 pt-0.5">
            <ProviderIcon
              provider={provider}
              className="size-3 shrink-0 opacity-80"
              fallback={
                <span className="size-3 shrink-0 rounded-full border border-dashed border-muted-foreground/40" />
              }
            />
            {status && !isSettled ? <ThreadStatusPillChip pill={status} /> : null}
            <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
              {thread.lastKnownPr ? <PrStateChip pr={thread.lastKnownPr} /> : null}
              {branch ? (
                <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground/70">
                  <GitBranchIcon className="size-3 shrink-0" aria-hidden />
                  <span className="max-w-36 truncate">{branch}</span>
                </span>
              ) : null}
            </span>
          </span>
        </button>
        <span className="absolute top-1 right-1 inline-flex items-center gap-1 opacity-0 transition-opacity group-hover/activity-row:opacity-100 group-focus-within/activity-row:opacity-100">
          <ThreadPinToggleButton
            pinned={isPinned}
            presentation="inline"
            toneClassName={actionToneClassName}
            onToggle={(event) => {
              stopRowActivation(event);
              onTogglePinned();
            }}
          />
          <ThreadArchiveActionButton
            threadId={thread.id}
            toneClassName={actionToneClassName}
            onArchive={onArchive}
          />
          <SidebarIconButton
            icon={isSettled ? Undo2Icon : CircleCheckIcon}
            label={isSettled ? "Undo" : "Done"}
            title={isSettled ? "Undo" : "Done"}
            iconClassName={SIDEBAR_TRAILING_ICON_CLASS}
            className={cn("hover:text-foreground/89", actionToneClassName)}
            onMouseDown={stopRowActivation}
            onClick={(event) => {
              stopRowActivation(event);
              onSetSettled(!isSettled);
            }}
          />
        </span>
      </TooltipTrigger>
      {renderHoverCard(hoverAnchorId)}
    </Tooltip>
  );
}

function ActivitySectionLabel({ label }: { label: string }) {
  return (
    <div className="mb-1.5 px-2">
      <span className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>{label}</span>
    </div>
  );
}

/**
 * Collapsible section (Pinned, Earlier, Settled): the same label + inline
 * disclosure chevron the classic "Chats" header uses, with the shared
 * disclosure motion. Section-to-section spacing is owned by the parent list.
 */
function ActivityCollapsibleSection({
  label,
  open,
  onToggle,
  children,
  className,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <button
        type="button"
        className={cn(
          "flex h-7 w-full min-w-0 cursor-pointer items-center gap-1 rounded-md px-2 py-0.5",
          SIDEBAR_ROW_FOCUS_CLASS_NAME,
        )}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className={cn("min-w-0 truncate", SIDEBAR_SECTION_LABEL_CLASS_NAME)}>{label}</span>
        <DisclosureChevron open={open} className="text-muted-foreground/58" />
      </button>
      <DisclosureRegion open={open}>
        <div className="flex flex-col gap-0.5 pt-0.5">{children}</div>
      </DisclosureRegion>
    </div>
  );
}

/**
 * The "Activity" header doubles as the project scope switcher: clicking it opens
 * the project menu, and while a project is selected the header reads its name so
 * the isolated scope is always visible at a glance.
 */
export type ActivityScopeSelection = ProjectId | "chats" | null;

function ActivityScopeMenu({
  options,
  projectById,
  scopeSelection,
  onChangeScopeSelection,
}: {
  options: ReadonlyArray<ActivityScopeOption>;
  projectById: ReadonlyMap<ProjectId, Project>;
  scopeSelection: ActivityScopeSelection;
  onChangeScopeSelection: (selection: ActivityScopeSelection) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const scopeLabel =
    scopeSelection === null
      ? "Activity"
      : scopeSelection === "chats"
        ? "Synara"
        : resolveThreadProjectLabel(projectById.get(scopeSelection));

  return (
    <Menu onOpenChange={(open) => setMenuOpen(open)}>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label="Filter activity by project"
            className={cn(
              "flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md text-left",
              SIDEBAR_ROW_FOCUS_CLASS_NAME,
            )}
          />
        }
      >
        <span
          className={cn(
            "min-w-0 truncate",
            SIDEBAR_SECTION_LABEL_CLASS_NAME,
            scopeSelection !== null && "text-foreground/85",
          )}
        >
          {scopeLabel}
        </span>
        <DisclosureChevron open={menuOpen} className="text-muted-foreground/55" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">
            Filter by project
          </div>
          <MenuRadioGroup
            value={scopeSelection ?? "all"}
            onValueChange={(value) => {
              onChangeScopeSelection(
                value === "all" ? null : value === "chats" ? "chats" : (value as ProjectId),
              );
            }}
          >
            <MenuRadioItem value="all" className="min-h-7 py-1 sm:text-xs">
              All projects
            </MenuRadioItem>
            {options.map((option) => (
              <MenuRadioItem
                key={option.kind === "project" ? option.projectId : "chats"}
                value={option.kind === "project" ? option.projectId : "chats"}
                className="min-h-7 py-1 sm:text-xs"
              >
                <span className="min-w-0 flex-1 truncate">
                  {option.kind === "project"
                    ? resolveThreadProjectLabel(projectById.get(option.projectId))
                    : "Synara"}
                </span>
                <span className="ml-2 shrink-0 tabular-nums text-muted-foreground/60">
                  {option.threadCount}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function ActivityShowMoreRow({
  canShowMore,
  canShowLess,
  onShowMore,
  onShowLess,
}: {
  canShowMore: boolean;
  canShowLess: boolean;
  onShowMore: () => void;
  onShowLess: () => void;
}) {
  if (!canShowMore && !canShowLess) return null;
  const buttonClassName =
    "h-7 cursor-pointer rounded-lg px-2.5 text-left text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/79 hover:text-foreground";
  return (
    <div className="flex w-full items-center gap-1">
      {canShowMore ? (
        <button type="button" className={cn(buttonClassName, "flex-1")} onClick={onShowMore}>
          Show more
        </button>
      ) : null}
      {canShowLess ? (
        <button
          type="button"
          className={cn(buttonClassName, canShowMore ? "flex-none" : "flex-1")}
          onClick={onShowLess}
        >
          Show less
        </button>
      ) : null}
    </div>
  );
}

export function SidebarActivityView({
  threads,
  projectById,
  activeThreadId,
  pinnedThreadIdSet,
  settledOverrideByThreadId,
  threadsHydrated,
  resolveThreadStatus,
  onOpenThread,
  onSetThreadSettled,
  onToggleThreadPinned,
  onArchiveThread,
  onMarkThreadRead,
  renderThreadHoverCard,
  headerToolbar,
  timestampFormat,
  pinnedThreads,
  renderPinnedThreadRow,
}: {
  threads: readonly SidebarThreadSummary[];
  projectById: ReadonlyMap<ProjectId, Project>;
  activeThreadId: ThreadId | null;
  pinnedThreadIdSet: ReadonlySet<ThreadId>;
  settledOverrideByThreadId: ReadonlyMap<ThreadId, boolean>;
  threadsHydrated: boolean;
  timestampFormat: TimestampFormat;
  /** Classic single-line pinned rows, rendered by the Sidebar so both surfaces stay identical. */
  pinnedThreads: readonly SidebarThreadSummary[];
  renderPinnedThreadRow: (thread: SidebarThreadSummary) => ReactNode;
  resolveThreadStatus: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
  onOpenThread: (threadId: ThreadId) => void;
  onSetThreadSettled: (threadId: ThreadId, settled: boolean) => void;
  onToggleThreadPinned: (threadId: ThreadId) => void;
  onArchiveThread: (threadId: ThreadId) => void;
  /** Records a completion as seen (the classic sidebar's markThreadVisited). */
  onMarkThreadRead: (threadId: ThreadId, completedAt?: string) => void;
  /** Same rich hover card the classic thread rows show at the sidebar edge. */
  renderThreadHoverCard: (thread: SidebarThreadSummary, anchorId: string) => ReactNode;
  /** Rendered on the "Activity" header row (e.g. the classic-view toggle). */
  headerToolbar?: ReactNode;
}) {
  const [scopeSelection, setScopeSelection] = useState<ActivityScopeSelection>(null);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [earlierExtraPages, setEarlierExtraPages] = useState(0);
  const [settledOpen, setSettledOpen] = useState(false);
  const [settledExtraPages, setSettledExtraPages] = useState(0);

  const isRealProject = (projectId: ProjectId) => projectById.get(projectId)?.kind === "project";
  // Scope options and the unread sweep intentionally ignore the active scope:
  // the menu must keep offering every project, and "Mark all as read" means all.
  const scopeOptions = collectActivityScopeOptions(threads, isRealProject);
  const unreadThreads = collectUnreadActivityThreads(threads);

  const projectFilterIds =
    scopeSelection === null
      ? null
      : scopeSelection === "chats"
        ? new Set(
            (scopeOptions.find((option) => option.kind === "chats")?.projectIds ??
              []) as ProjectId[],
          )
        : new Set([scopeSelection]);

  const model = buildActivityViewModel({
    threads,
    pinnedThreadIdSet,
    settledOverrideByThreadId,
    projectFilterIds,
  });
  const nowMs = Date.now();
  const { recent: recentThreads, rest: remainingActiveThreads } = splitRecentActivityThreads(
    model.active,
  );
  const dateBuckets = splitActivityThreadsByDateBucket(remainingActiveThreads, nowMs);

  const earlierPaging = resolveSidebarThreadListPaging({
    totalCount: dateBuckets.earlier.length,
    baseLimit: ACTIVITY_LIST_BASE_LIMIT,
    pageSize: ACTIVITY_LIST_PAGE_SIZE,
    requestedExtraPages: earlierExtraPages,
  });
  const settledPaging = resolveSidebarThreadListPaging({
    totalCount: model.settled.length,
    baseLimit: ACTIVITY_LIST_BASE_LIMIT,
    pageSize: ACTIVITY_LIST_PAGE_SIZE,
    requestedExtraPages: settledExtraPages,
  });

  const markAllRead = () => {
    for (const thread of unreadThreads) {
      onMarkThreadRead(thread.id, thread.latestTurn?.completedAt ?? undefined);
    }
  };

  const renderRow = (thread: SidebarThreadSummary, isSettled: boolean) => (
    <ActivityThreadRow
      key={thread.id}
      thread={thread}
      project={projectById.get(thread.projectId)}
      isActive={activeThreadId === thread.id}
      isSettled={isSettled}
      isPinned={pinnedThreadIdSet.has(thread.id)}
      status={resolveThreadStatus(thread)}
      timeLabel={formatActivityRowTime({ thread, nowMs, timestampFormat })}
      onOpen={() => onOpenThread(thread.id)}
      onSetSettled={(settled) => onSetThreadSettled(thread.id, settled)}
      onTogglePinned={() => onToggleThreadPinned(thread.id)}
      onArchive={() => onArchiveThread(thread.id)}
      renderHoverCard={(anchorId) => renderThreadHoverCard(thread, anchorId)}
    />
  );

  // Pinned rows render in their own section, so the feed itself is empty
  // exactly when no date bucket has rows.
  const isEmpty = model.active.length === 0;

  return (
    <div className="flex flex-col gap-3">
      {pinnedThreads.length > 0 ? (
        <ActivityCollapsibleSection
          label="Pinned"
          open={pinnedOpen}
          onToggle={() => setPinnedOpen((open) => !open)}
        >
          {pinnedThreads.map((thread) => renderPinnedThreadRow(thread))}
        </ActivityCollapsibleSection>
      ) : null}

      <div className="flex h-7 items-center gap-1 px-2 py-0.5">
        <ActivityScopeMenu
          options={scopeOptions}
          projectById={projectById}
          scopeSelection={scopeSelection}
          onChangeScopeSelection={setScopeSelection}
        />
        <SidebarIconButton
          icon={ListChecksIcon}
          label="Mark all as read"
          tooltip="Mark all as read"
          tooltipSide="bottom"
          disabled={unreadThreads.length === 0}
          className="disabled:cursor-default disabled:opacity-45"
          onClick={markAllRead}
        />
        {headerToolbar}
      </div>

      {isEmpty ? (
        <div className="px-2 pt-4 text-center text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/58">
          {threadsHydrated
            ? scopeSelection !== null
              ? "No activity for this project"
              : "No activity yet"
            : "Loading activity..."}
        </div>
      ) : (
        <>
          {recentThreads.length > 0 ? (
            <div>
              <ActivitySectionLabel label="Recent" />
              <div className="flex flex-col gap-0.5">
                {recentThreads.map((thread) => renderRow(thread, false))}
              </div>
            </div>
          ) : null}
          {dateBuckets.today.length > 0 ? (
            <div>
              <ActivitySectionLabel label="Today" />
              <div className="flex flex-col gap-0.5">
                {dateBuckets.today.map((thread) => renderRow(thread, false))}
              </div>
            </div>
          ) : null}
          {dateBuckets.yesterday.length > 0 ? (
            <div>
              <ActivitySectionLabel label="Yesterday" />
              <div className="flex flex-col gap-0.5">
                {dateBuckets.yesterday.map((thread) => renderRow(thread, false))}
              </div>
            </div>
          ) : null}
          {dateBuckets.earlier.length > 0 ? (
            <ActivityCollapsibleSection
              label="Earlier"
              open={earlierOpen}
              onToggle={() => setEarlierOpen((open) => !open)}
            >
              {dateBuckets.earlier
                .slice(0, earlierPaging.previewLimit)
                .map((thread) => renderRow(thread, false))}
              <ActivityShowMoreRow
                canShowMore={earlierPaging.canShowMore}
                canShowLess={earlierPaging.canShowLess}
                onShowMore={() => setEarlierExtraPages(earlierPaging.effectiveExtraPages + 1)}
                onShowLess={() =>
                  setEarlierExtraPages(Math.max(0, earlierPaging.effectiveExtraPages - 1))
                }
              />
            </ActivityCollapsibleSection>
          ) : null}
        </>
      )}

      {model.settled.length > 0 ? (
        <ActivityCollapsibleSection
          label="Settled"
          open={settledOpen}
          onToggle={() => setSettledOpen((open) => !open)}
        >
          {model.settled
            .slice(0, settledPaging.previewLimit)
            .map((thread) => renderRow(thread, true))}
          <ActivityShowMoreRow
            canShowMore={settledPaging.canShowMore}
            canShowLess={settledPaging.canShowLess}
            onShowMore={() => setSettledExtraPages(settledPaging.effectiveExtraPages + 1)}
            onShowLess={() =>
              setSettledExtraPages(Math.max(0, settledPaging.effectiveExtraPages - 1))
            }
          />
        </ActivityCollapsibleSection>
      ) : null}
    </div>
  );
}
