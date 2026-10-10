// FILE: SidebarActivityView.tsx
// Purpose: Task-feed sidebar surface — every thread is a 2-line task row
//          (provider + title / project + branch) grouped by status, with settle.
// Layer: Sidebar UI component
// Exports: SidebarActivityView, ActivityThreadRow, SidebarSnoozedThreadsSection

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";

import type { OrchestrationThreadPullRequest, ProjectId, ThreadId } from "@synara/contracts";
import { resolveThreadEnvironmentMode } from "@synara/shared/threadEnvironment";

import {
  AddPlusIcon,
  CircleCheckIcon,
  ClockIcon,
  GitBranchIcon,
  NewThreadIcon,
  SortIcon,
  Undo2Icon,
  WorktreeIcon,
  FolderIcon,
} from "~/lib/icons";
import { beginThreadDrag, endThreadDrag } from "~/lib/threadDrag";
import { cn } from "~/lib/utils";
import {
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
  SIDEBAR_ROW_SNOOZE_REMINDER_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
  sidebarHoverRevealHideClassName,
} from "../sidebarRowStyles";
import { resolveThreadPullRequestFallback } from "../hooks/useThreadPullRequests";
import { useThreadIdsWithPendingDraft } from "../composerDraftStore";
import type { Project, SidebarThreadSummary } from "../types";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { ProviderIcon } from "./ProviderIcon";
import { SnoozeCountdown } from "./SnoozeCountdown";
import { ProjectSidebarIcon } from "./ProjectSidebarIcon";
import { PrStateChip } from "./pullRequest/PrStateChip";
import {
  createSidebarThreadHoverAnchorId,
  resolveSidebarThreadListPaging,
  resolveThreadDisplayBranch,
  resolveThreadProjectLabel,
  resolveThreadStatusTrailingIndicator,
  type ThreadStatusPill,
} from "./Sidebar.logic";
import {
  buildActivityViewModel,
  collectActivityScopeOptions,
  collectUnreadActivityThreads,
  collectVisibleActivityThreadIds,
  resolveActivitySectionRows,
  groupActivityThreadsByProject,
  isThreadSettledForActivity,
  resolveActivityScope,
  resolveActivityThreadReadAt,
  splitActivityThreadsByDateBucket,
  splitRecentActivityThreads,
  type ActivityGroupMode,
  type ActivityProjectGroup,
  type ActivityScopeOption,
  type ActivityScopeSelection,
} from "./SidebarActivityView.logic";
import { SIDEBAR_TRAILING_ICON_CLASS, sidebarGlyphClass } from "./sidebarGlyphs";
import { SIDEBAR_HOVER_CARD_TRIGGER_PROPS } from "./sidebarHoverCardStyles";
import {
  createSidebarThreadRowGestures,
  type SidebarRowContextMenuPosition,
} from "./sidebarThreadRowGestures";
import { SidebarIconButton } from "./SidebarIconButton";
import {
  SidebarCollapsibleSection,
  SidebarSectionLabel,
  SidebarShowMoreRow,
} from "./SidebarListSection";
import { SidebarSectionToolbar } from "./SidebarSectionToolbar";
import { SidebarDraftGlyph, SidebarStatusTrailingGlyph } from "./SidebarStatusTrailingGlyph";
import { ThreadArchiveActionButton } from "./ThreadArchiveActionButton";
import { ThreadPinToggleButton } from "./ThreadPinToggleButton";
import { ShortcutKbd } from "./ui/kbd";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipTrigger } from "./ui/tooltip";

const ACTIVITY_LIST_BASE_LIMIT = 20;
const ACTIVITY_LIST_PAGE_SIZE = 20;
const EMPTY_PROJECT_GROUPS: ActivityProjectGroup[] = [];

/** Keeps a row action (pin, archive, done) from also opening the thread. */
function stopRowActivation(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

export function ActivityThreadRow({
  thread,
  project,
  isActive,
  isSettled,
  isPinned,
  hasPendingDraft,
  pr,
  status,
  threadJumpLabel,
  onOpen,
  onOpenPullRequest,
  onSetSettled,
  onReturnSnoozed,
  onTogglePinned,
  onArchive,
  onRename,
  onRenamePointerUp,
  onContextMenu,
  renderHoverCard,
  rowRef,
}: {
  thread: SidebarThreadSummary;
  project: Project | undefined;
  isActive: boolean;
  isSettled: boolean;
  isPinned: boolean;
  hasPendingDraft: boolean;
  pr: OrchestrationThreadPullRequest | null;
  status: ThreadStatusPill | null;
  threadJumpLabel: string | null;
  onOpen: () => void;
  onOpenPullRequest: (event: MouseEvent<HTMLElement>, pr: OrchestrationThreadPullRequest) => void;
  onSetSettled: (settled: boolean) => void;
  onReturnSnoozed: () => void;
  onTogglePinned: () => void;
  onArchive: () => void;
  onRename: (threadId: ThreadId) => void;
  onRenamePointerUp: (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => void;
  onContextMenu: (threadId: ThreadId, position: SidebarRowContextMenuPosition) => void;
  renderHoverCard: (anchorId: string) => ReactNode;
  rowRef?: Ref<HTMLButtonElement>;
}) {
  const provider = thread.session?.provider ?? thread.modelSelection.provider;
  const branch = resolveThreadDisplayBranch(thread);
  const isWorktree =
    resolveThreadEnvironmentMode({
      envMode: thread.envMode,
      worktreePath: thread.worktreePath,
    }) === "worktree";
  const hoverAnchorId = createSidebarThreadHoverAnchorId({
    scope: "activity",
    threadId: thread.id,
  });
  const actionToneClassName = "text-muted-foreground/42";
  // One trailing slot, top-right, shared by every status: the accent dot for an
  // unread completion and the running spinner (or state dot) for everything
  // else — same rule and same glyphs the classic thread/project rows use.
  const trailingStatus = resolveThreadStatusTrailingIndicator({
    status,
    isActive,
    slotOccupied: Boolean(threadJumpLabel),
  });
  // Rename/context-menu gestures live on the row wrapper (not the title button) so
  // they also fire over the trailing status and hover-action cluster, which are
  // absolutely positioned siblings of the button.
  const rowGestures = createSidebarThreadRowGestures({
    threadId: thread.id,
    onRename,
    onRenamePointerUp,
    onContextMenu,
  });

  return (
    <Tooltip>
      <TooltipTrigger
        {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
        render={
          <div
            data-thread-hover-anchor={hoverAnchorId}
            className="group/activity-row relative"
            data-thread-item
            {...rowGestures}
          />
        }
      >
        <button
          ref={rowRef}
          type="button"
          onClick={onOpen}
          aria-current={isActive ? "page" : undefined}
          // Same native drag as the classic thread rows: drop on a chat pane to
          // split, or on a composer to @mention the chat.
          draggable
          onDragStart={(event) => beginThreadDrag(event, thread.id)}
          onDragEnd={endThreadDrag}
          data-testid={`activity-thread-${thread.id}`}
          className={cn(
            "flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-lg px-2.5 py-2 text-left select-none",
            SIDEBAR_ROW_FOCUS_CLASS_NAME,
            isActive ? SIDEBAR_ROW_ACTIVE_CLASS_NAME : SIDEBAR_ROW_HOVER_CLASS_NAME,
            isSettled && "opacity-55 transition-opacity hover:opacity-85",
            // Snoozed rows carry a tint on top of the clock line so they read apart at a glance.
            thread.snoozedUntil != null && !isActive && "bg-info/6",
            status?.label === "Reminder" && !isActive && SIDEBAR_ROW_SNOOZE_REMINDER_CLASS_NAME,
          )}
        >
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 overflow-hidden transition-[padding] duration-150 ease-out",
              !threadJumpLabel && "pr-5",
              // Yield the title row to the hover action cluster (pin + archive + done).
              "group-hover/activity-row:pr-[4.25rem] group-focus-within/activity-row:pr-[4.25rem]",
            )}
          >
            <ProviderIcon
              provider={provider}
              className="size-3 shrink-0"
              fallback={
                <span className="size-3 shrink-0 rounded-full border border-dashed border-muted-foreground/40" />
              }
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-ui leading-5 font-normal",
                isActive ? "text-foreground" : SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
              )}
            >
              {thread.title}
            </span>
            {thread.snoozedUntil != null ? (
              <ClockIcon
                className={sidebarGlyphClass("meta", "shrink-0 text-info")}
                aria-label="Scheduled"
              />
            ) : null}
            {hasPendingDraft ? <SidebarDraftGlyph /> : null}
            {threadJumpLabel ? (
              <ShortcutKbd
                shortcutLabel={threadJumpLabel}
                title={threadJumpLabel}
                groupClassName={sidebarHoverRevealHideClassName("activity-row")}
              />
            ) : null}
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            {project?.cwd ? (
              <ProjectSidebarIcon
                cwd={project.cwd}
                expanded={false}
                appearance={project.appearance}
                glyphClassName={sidebarGlyphClass("meta", "text-muted-foreground/70")}
                presentation="favicon"
              />
            ) : (
              <FolderIcon
                className={sidebarGlyphClass("meta", "text-muted-foreground/70")}
                aria-hidden
              />
            )}
            <span className="min-w-0 truncate text-ui-sm text-muted-foreground/80">
              {resolveThreadProjectLabel(project)}
            </span>
            <span className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
              {isWorktree ? (
                <span className="inline-flex size-5 shrink-0 items-center justify-center">
                  <WorktreeIcon
                    className={sidebarGlyphClass("meta", "text-muted-foreground/70")}
                    aria-label="Worktree"
                  />
                </span>
              ) : null}
              {pr ? (
                <PrStateChip
                  pr={pr}
                  className="min-h-5 min-w-5 justify-center [&_svg]:size-3"
                  onOpen={(event) => onOpenPullRequest(event, pr)}
                />
              ) : null}
              {branch ? (
                <span className="flex min-w-0 items-center gap-1 text-ui-sm text-muted-foreground/70">
                  <GitBranchIcon className={sidebarGlyphClass("meta")} aria-hidden />
                  <span className="max-w-36 truncate">{branch}</span>
                </span>
              ) : null}
            </span>
          </span>
          {thread.snoozedUntil != null ? (
            <span className="flex min-w-0 items-center gap-1 text-ui-sm text-muted-foreground/80">
              <span className="truncate">
                <SnoozeCountdown snoozedUntil={thread.snoozedUntil} />
              </span>
            </span>
          ) : null}
        </button>
        {trailingStatus ? (
          <span
            data-slot="activity-completion-status"
            className={cn(
              "pointer-events-none absolute top-1 right-1 inline-flex size-5 items-center justify-center",
              sidebarHoverRevealHideClassName("activity-row"),
            )}
          >
            <SidebarStatusTrailingGlyph status={trailingStatus} />
          </span>
        ) : null}
        <span
          className="absolute top-1 right-1 inline-flex items-center gap-1 opacity-0 transition-opacity group-hover/activity-row:opacity-100 group-focus-within/activity-row:opacity-100"
          // Double-clicking an action button toggles it twice; it must not also open
          // the row's rename dialog. Pointer-up is the touch/pen double-tap signal,
          // so keep action taps out of that detector too.
          onDoubleClick={stopRowActivation}
          onPointerUp={(event) => event.stopPropagation()}
        >
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
            icon={thread.snoozedUntil != null || isSettled ? Undo2Icon : CircleCheckIcon}
            label={thread.snoozedUntil != null ? "Return now" : isSettled ? "Undo" : "Done"}
            title={thread.snoozedUntil != null ? "Return now" : isSettled ? "Undo" : "Done"}
            iconClassName={SIDEBAR_TRAILING_ICON_CLASS}
            className={cn("hover:text-foreground/89", actionToneClassName)}
            onMouseDown={stopRowActivation}
            onClick={(event) => {
              stopRowActivation(event);
              if (thread.snoozedUntil != null) onReturnSnoozed();
              else onSetSettled(!isSettled);
            }}
          />
        </span>
      </TooltipTrigger>
      {renderHoverCard(hoverAnchorId)}
    </Tooltip>
  );
}

/** The same accessible Snoozed section serves Activity and the classic sidebar. */
export function SidebarSnoozedThreadsSection({
  threads,
  renderThreadRow,
  onVisibleThreadIdsChange,
}: {
  threads: readonly SidebarThreadSummary[];
  renderThreadRow: (thread: SidebarThreadSummary) => ReactNode;
  onVisibleThreadIdsChange?: (threadIds: readonly ThreadId[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [extraPages, setExtraPages] = useState(0);
  const paging = resolveSidebarThreadListPaging({
    totalCount: threads.length,
    baseLimit: ACTIVITY_LIST_BASE_LIMIT,
    pageSize: ACTIVITY_LIST_PAGE_SIZE,
    requestedExtraPages: extraPages,
  });
  const visibleThreadIds = useMemo(
    () => (open ? threads.slice(0, paging.previewLimit).map((thread) => thread.id) : []),
    [open, paging.previewLimit, threads],
  );
  const visibleThreadIdsFingerprint = visibleThreadIds.join("\0");
  const visibleThreadIdsRef = useRef(visibleThreadIds);
  visibleThreadIdsRef.current = visibleThreadIds;
  useEffect(() => {
    onVisibleThreadIdsChange?.(visibleThreadIdsRef.current);
  }, [onVisibleThreadIdsChange, visibleThreadIdsFingerprint]);
  useEffect(
    () => () => {
      onVisibleThreadIdsChange?.([]);
    },
    [onVisibleThreadIdsChange],
  );
  if (threads.length === 0) return null;
  return (
    <SidebarCollapsibleSection
      label="Snoozed"
      open={open}
      onToggle={() => setOpen((current) => !current)}
    >
      {threads.slice(0, paging.previewLimit).map(renderThreadRow)}
      <SidebarShowMoreRow
        canShowMore={paging.canShowMore}
        canShowLess={paging.canShowLess}
        onShowMore={() => setExtraPages(paging.effectiveExtraPages + 1)}
        onShowLess={() => setExtraPages(Math.max(0, paging.effectiveExtraPages - 1))}
      />
    </SidebarCollapsibleSection>
  );
}

/**
 * The header doubles as the activity scope switcher: clicking it opens the
 * project menu, and its label always reflects the currently visible scope.
 */
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
      ? "All activity"
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
          <div className="px-2 py-1 sm:text-ui leading-snug font-medium text-muted-foreground">
            Activity scope
          </div>
          <MenuRadioGroup
            value={scopeSelection ?? "all"}
            onValueChange={(value) => {
              onChangeScopeSelection(
                value === "all" ? null : value === "chats" ? "chats" : (value as ProjectId),
              );
            }}
          >
            <MenuRadioItem value="all" className="min-h-7 py-1 sm:text-ui leading-snug">
              All activity
            </MenuRadioItem>
            {options.map((option) => (
              <MenuRadioItem
                key={option.kind === "project" ? option.projectId : "chats"}
                value={option.kind === "project" ? option.projectId : "chats"}
                className="min-h-7 py-1 sm:text-ui leading-snug"
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

/**
 * Header filter control: picks how the feed groups its sections (by time or by
 * project) and hosts "Mark all as read" below that choice.
 */
function ActivityFilterMenu({
  groupMode,
  onChangeGroupMode,
  markAllReadDisabled,
  onMarkAllRead,
}: {
  groupMode: ActivityGroupMode;
  onChangeGroupMode: (mode: ActivityGroupMode) => void;
  markAllReadDisabled: boolean;
  onMarkAllRead: () => void;
}) {
  return (
    <Menu>
      <SidebarIconButton
        icon={SortIcon}
        label="Activity options"
        tooltip="Activity options"
        tooltipSide="bottom"
        render={<MenuTrigger />}
      />
      <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-ui leading-snug font-medium text-muted-foreground">
            Group by
          </div>
          <MenuRadioGroup
            value={groupMode}
            onValueChange={(value) => onChangeGroupMode(value as ActivityGroupMode)}
          >
            <MenuRadioItem value="time" className="min-h-7 py-1 sm:text-ui leading-snug">
              Time
            </MenuRadioItem>
            <MenuRadioItem value="project" className="min-h-7 py-1 sm:text-ui leading-snug">
              Project
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem
          className="min-h-7 py-1 sm:text-ui leading-snug"
          disabled={markAllReadDisabled}
          onClick={onMarkAllRead}
        >
          Mark all as read
        </MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

export function SidebarActivityView({
  threads,
  projectById,
  activeThreadId,
  pinnedThreadIdSet,
  settledOverrideByThreadId,
  threadsHydrated,
  scopeSelection,
  onScopeSelectionChange,
  resolveThreadStatus,
  onOpenThread,
  onOpenThreadPullRequest,
  onSetThreadSettled,
  onReturnSnoozedThread,
  onToggleThreadPinned,
  onArchiveThread,
  onMarkThreadRead,
  onRenameThread,
  onThreadRenamePointerUp,
  onThreadContextMenu,
  onProjectContextMenu,
  renderThreadHoverCard,
  prByThreadId,
  threadJumpLabelByThreadId,
  onVisibleThreadIdsChange,
  onCreateChat,
  onAddProject,
}: {
  threads: readonly SidebarThreadSummary[];
  projectById: ReadonlyMap<ProjectId, Project>;
  activeThreadId: ThreadId | null;
  pinnedThreadIdSet: ReadonlySet<ThreadId>;
  settledOverrideByThreadId: ReadonlyMap<ThreadId, boolean>;
  threadsHydrated: boolean;
  /** Owned by the sidebar so the scope survives this view unmounting (Settings, reloads). */
  scopeSelection: ActivityScopeSelection;
  onScopeSelectionChange: (selection: ActivityScopeSelection) => void;
  prByThreadId: ReadonlyMap<ThreadId, OrchestrationThreadPullRequest | null>;
  threadJumpLabelByThreadId: ReadonlyMap<ThreadId, string>;
  onVisibleThreadIdsChange: (threadIds: readonly ThreadId[]) => void;
  resolveThreadStatus: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
  onOpenThread: (threadId: ThreadId) => void;
  /** PR chip click: plain click opens it in the thread, cmd/ctrl/middle-click on GitHub. */
  onOpenThreadPullRequest: (
    event: MouseEvent<HTMLElement>,
    thread: SidebarThreadSummary,
    pr: OrchestrationThreadPullRequest,
  ) => void;
  onSetThreadSettled: (threadId: ThreadId, settled: boolean) => void;
  onReturnSnoozedThread: (threadId: ThreadId) => void;
  onToggleThreadPinned: (threadId: ThreadId) => void;
  onArchiveThread: (threadId: ThreadId) => void;
  /** Records a completion or snooze reminder as seen (the classic sidebar's markThreadVisited). */
  onMarkThreadRead: (threadId: ThreadId, readAt?: string) => void;
  /** Double-click a row (the classic sidebar's rename gesture). */
  onRenameThread: (threadId: ThreadId) => void;
  /** Touch/pen double-tap fallback for the same rename gesture. */
  onThreadRenamePointerUp: (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => void;
  /** Right-click a row: the full thread menu, including Copy Thread ID. */
  onThreadContextMenu: (threadId: ThreadId, position: SidebarRowContextMenuPosition) => void;
  /** Right-click a project block header: the same menu a classic project row opens. */
  onProjectContextMenu: (projectId: ProjectId, position: SidebarRowContextMenuPosition) => void;
  /** Same rich hover card the classic thread rows show at the sidebar edge. */
  renderThreadHoverCard: (thread: SidebarThreadSummary, anchorId: string) => ReactNode;
  /** Starts a new chat in the current or most recently used ordinary project. */
  onCreateChat: () => void;
  /** Same "Add project" action the Projects section header runs. */
  onAddProject: () => void;
}) {
  const [groupMode, setGroupMode] = useState<ActivityGroupMode>("time");
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [earlierExtraPages, setEarlierExtraPages] = useState(0);
  const [settledOpen, setSettledOpen] = useState(false);
  const [settledExtraPages, setSettledExtraPages] = useState(0);
  const [snoozedVisibleThreadIds, setSnoozedVisibleThreadIds] = useState<readonly ThreadId[]>([]);
  const [projectExtraPagesByKey, setProjectExtraPagesByKey] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  const draftThreadIdSet = useThreadIdsWithPendingDraft();
  const isRealProject = useCallback(
    (projectId: ProjectId) => projectById.get(projectId)?.kind === "project",
    [projectById],
  );
  // The feed derivations below are pure and `threads` is reference-stable
  // across most sidebar renders, so each is memoized on its own inputs instead
  // of re-running six passes and four sorts over every activity thread per render.
  // Scope options and the unread sweep intentionally ignore the active scope:
  // the menu must keep offering every project, and "Mark all as read" means all.
  const scopeOptions = useMemo(
    () => collectActivityScopeOptions(threads, isRealProject),
    [isRealProject, threads],
  );
  const unreadThreads = useMemo(() => collectUnreadActivityThreads(threads), [threads]);

  const { scope: activeScope, projectFilterIds } = resolveActivityScope(
    scopeSelection,
    scopeOptions,
  );
  // Before threads hydrate every option is missing, so dropping the selection
  // then would wipe the remembered scope on every remount.
  useEffect(() => {
    if (threadsHydrated && scopeSelection !== activeScope) onScopeSelectionChange(activeScope);
  }, [activeScope, onScopeSelectionChange, scopeSelection, threadsHydrated]);

  const model = useMemo(
    () =>
      buildActivityViewModel({
        threads,
        pinnedThreadIdSet,
        draftThreadIdSet,
        settledOverrideByThreadId,
        projectFilterIds,
      }),
    [draftThreadIdSet, pinnedThreadIdSet, projectFilterIds, settledOverrideByThreadId, threads],
  );
  const scopedPinnedThreads = model.pinned;
  const draftThreads = model.drafts;
  // Coarse clock so the date bucketing memo stays effective across renders that
  // happen within the same minute; buckets are day-granular anyway.
  const nowMs = Math.floor(Date.now() / 60_000) * 60_000;
  const { recent: recentThreads, rest: remainingActiveThreads } = useMemo(
    () => splitRecentActivityThreads(model.active, { nowMs }),
    [model.active, nowMs],
  );
  const dateBuckets = useMemo(
    () => splitActivityThreadsByDateBucket(remainingActiveThreads, nowMs),
    [nowMs, remainingActiveThreads],
  );
  const projectGroups = useMemo(
    () =>
      groupMode === "project"
        ? // Drafts go in first so they lead their project's block.
          groupActivityThreadsByProject([...model.drafts, ...model.active], isRealProject)
        : EMPTY_PROJECT_GROUPS,
    [groupMode, isRealProject, model.active, model.drafts],
  );

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
  const pagedProjectGroups = projectGroups.map((group) => {
    const paging = resolveSidebarThreadListPaging({
      totalCount: group.threads.length,
      baseLimit: ACTIVITY_LIST_BASE_LIMIT,
      pageSize: ACTIVITY_LIST_PAGE_SIZE,
      requestedExtraPages: projectExtraPagesByKey.get(group.key) ?? 0,
    });
    return {
      group,
      paging,
      threads: resolveActivitySectionRows(group.threads, {
        open: true,
        previewLimit: paging.previewLimit,
        activeThreadId,
      }).visible,
    };
  });
  const pinnedRows = useMemo(
    () =>
      resolveActivitySectionRows(scopedPinnedThreads, {
        open: pinnedOpen,
        previewLimit: scopedPinnedThreads.length,
        activeThreadId,
      }),
    [activeThreadId, pinnedOpen, scopedPinnedThreads],
  );
  const earlierRows = useMemo(
    () =>
      resolveActivitySectionRows(dateBuckets.earlier, {
        open: earlierOpen,
        previewLimit: earlierPaging.previewLimit,
        activeThreadId,
      }),
    [activeThreadId, dateBuckets.earlier, earlierOpen, earlierPaging.previewLimit],
  );
  const settledRows = useMemo(
    () =>
      resolveActivitySectionRows(model.settled, {
        open: settledOpen,
        previewLimit: settledPaging.previewLimit,
        activeThreadId,
      }),
    [activeThreadId, model.settled, settledOpen, settledPaging.previewLimit],
  );
  // The open thread stays on screen even when its section is collapsed.
  const revealedThreads = useMemo(
    () => ({
      pinned: pinnedRows.revealed,
      earlier: groupMode === "time" ? earlierRows.revealed : [],
      settled: settledRows.revealed,
    }),
    [earlierRows.revealed, groupMode, pinnedRows.revealed, settledRows.revealed],
  );
  const visibleThreadIds = useMemo(
    () => [
      ...collectVisibleActivityThreadIds({
        groupMode,
        pinnedOpen,
        pinned: scopedPinnedThreads,
        drafts: draftThreads,
        recent: recentThreads,
        today: dateBuckets.today,
        yesterday: dateBuckets.yesterday,
        earlierOpen,
        earlier: earlierRows.visible,
        projectGroups: pagedProjectGroups.map((group) => group.threads),
        settledOpen,
        settled: settledRows.visible,
        revealed: revealedThreads,
      }),
      ...snoozedVisibleThreadIds,
    ],
    [
      dateBuckets.today,
      dateBuckets.yesterday,
      draftThreads,
      earlierOpen,
      earlierRows.visible,
      groupMode,
      pagedProjectGroups,
      pinnedOpen,
      recentThreads,
      revealedThreads,
      scopedPinnedThreads,
      settledOpen,
      settledRows.visible,
      snoozedVisibleThreadIds,
    ],
  );
  const visibleThreadIdsFingerprint = visibleThreadIds.join("\0");
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  const lastActiveRevealKeyRef = useRef<string | null>(null);
  const activeRevealKey =
    activeThreadId !== null && visibleThreadIds.includes(activeThreadId)
      ? `${activeThreadId}:${groupMode}:${activeScope ?? "all"}`
      : null;
  useEffect(() => {
    if (activeRevealKey === null) {
      lastActiveRevealKeyRef.current = null;
      return;
    }
    if (lastActiveRevealKeyRef.current === activeRevealKey) return;
    const frameId = window.requestAnimationFrame(() => {
      const row = activeRowRef.current;
      const viewport = row?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
      if (!row || !viewport || viewport.clientHeight === 0 || row.getClientRects().length === 0) {
        return;
      }
      lastActiveRevealKeyRef.current = activeRevealKey;
      const rowBounds = row.getBoundingClientRect();
      const viewportBounds = viewport.getBoundingClientRect();
      // Move only this sidebar viewport and preserve focus in the chat/composer.
      // A later activity update must not pull a reader back to the selected row.
      if (rowBounds.top < viewportBounds.top) {
        viewport.scrollTop += rowBounds.top - viewportBounds.top;
      } else if (rowBounds.bottom > viewportBounds.bottom) {
        viewport.scrollTop += rowBounds.bottom - viewportBounds.bottom;
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [activeRevealKey, visibleThreadIdsFingerprint]);
  const visibleThreadIdsRef = useRef(visibleThreadIds);
  visibleThreadIdsRef.current = visibleThreadIds;
  useEffect(() => {
    onVisibleThreadIdsChange(visibleThreadIdsRef.current);
  }, [onVisibleThreadIdsChange, visibleThreadIdsFingerprint]);
  useEffect(
    () => () => {
      onVisibleThreadIdsChange([]);
    },
    [onVisibleThreadIdsChange],
  );

  const markAllRead = () => {
    for (const thread of unreadThreads) {
      onMarkThreadRead(thread.id, resolveActivityThreadReadAt(thread));
    }
  };

  const renderRow = (
    thread: SidebarThreadSummary,
    isSettled: boolean,
    registerActiveRow = true,
  ) => (
    <ActivityThreadRow
      key={thread.id}
      thread={thread}
      project={projectById.get(thread.projectId)}
      isActive={activeThreadId === thread.id}
      isSettled={isSettled}
      isPinned={pinnedThreadIdSet.has(thread.id)}
      hasPendingDraft={draftThreadIdSet.has(thread.id)}
      pr={
        // An explicit null from the resolver means the persisted PR was ruled out (e.g. the
        // checkout moved on); falling back to raw lastKnownPr would resurrect that stale
        // badge. Rows not yet covered (revealed by paging a paint before the parent's map
        // catches up) get the same resolution without live status instead.
        prByThreadId.has(thread.id)
          ? (prByThreadId.get(thread.id) ?? null)
          : resolveThreadPullRequestFallback({
              branch: thread.branch,
              hasDedicatedWorktree: thread.worktreePath !== null,
              lastKnownPr: thread.lastKnownPr ?? null,
            })
      }
      status={resolveThreadStatus(thread)}
      threadJumpLabel={threadJumpLabelByThreadId.get(thread.id) ?? null}
      onOpen={() => onOpenThread(thread.id)}
      onOpenPullRequest={(event, pr) => onOpenThreadPullRequest(event, thread, pr)}
      onSetSettled={(settled) => {
        if (settled) onMarkThreadRead(thread.id, resolveActivityThreadReadAt(thread));
        onSetThreadSettled(thread.id, settled);
      }}
      onReturnSnoozed={() => onReturnSnoozedThread(thread.id)}
      onTogglePinned={() => onToggleThreadPinned(thread.id)}
      onArchive={() => onArchiveThread(thread.id)}
      onRename={onRenameThread}
      onRenamePointerUp={onThreadRenamePointerUp}
      onContextMenu={onThreadContextMenu}
      renderHoverCard={(anchorId) => renderThreadHoverCard(thread, anchorId)}
      {...(registerActiveRow && activeThreadId === thread.id ? { rowRef: activeRowRef } : {})}
    />
  );
  const renderActiveRow = (thread: SidebarThreadSummary) =>
    renderRow(thread, isThreadSettledForActivity(thread, settledOverrideByThreadId));

  // The placeholder speaks for the whole surface, so it may only appear when no
  // section has rows — a feed with nothing active but a populated Pinned or Done
  // section is not empty.
  const isEmpty =
    model.active.length === 0 &&
    model.settled.length === 0 &&
    draftThreads.length === 0 &&
    model.snoozed.length === 0 &&
    scopedPinnedThreads.length === 0;
  const emptyLabel =
    activeScope === null
      ? "No activity yet"
      : activeScope === "chats"
        ? "No activity in Synara chats"
        : "No activity for this project";

  return (
    <div className="flex flex-col gap-3">
      {scopedPinnedThreads.length > 0 ? (
        <SidebarCollapsibleSection
          label="Pinned"
          open={pinnedOpen}
          onToggle={() => setPinnedOpen((open) => !open)}
          revealedChildren={pinnedRows.revealed.map(renderActiveRow)}
        >
          {scopedPinnedThreads.map((thread) =>
            renderRow(
              thread,
              isThreadSettledForActivity(thread, settledOverrideByThreadId),
              pinnedOpen,
            ),
          )}
        </SidebarCollapsibleSection>
      ) : null}

      {/* `group/project-header` is the marker SidebarSectionToolbar reveals on, so
          the header's create actions fade in exactly like a project row's. */}
      <div className="group/project-header relative flex h-7 items-center gap-1 px-2 py-0.5">
        <ActivityScopeMenu
          options={scopeOptions}
          projectById={projectById}
          scopeSelection={activeScope}
          onChangeScopeSelection={onScopeSelectionChange}
        />
        <SidebarSectionToolbar revealOnHover className="mr-0">
          <SidebarIconButton
            icon={NewThreadIcon}
            label="Start new chat in last used project"
            tooltip="New chat"
            tooltipSide="bottom"
            onClick={onCreateChat}
          />
          <SidebarIconButton
            icon={AddPlusIcon}
            label="Add project"
            tooltip="Add project"
            tooltipSide="bottom"
            onClick={onAddProject}
          />
        </SidebarSectionToolbar>
        <ActivityFilterMenu
          groupMode={groupMode}
          onChangeGroupMode={setGroupMode}
          markAllReadDisabled={unreadThreads.length === 0}
          onMarkAllRead={markAllRead}
        />
      </div>

      {isEmpty ? (
        <div className="px-2 pt-4 text-center text-ui text-muted-foreground/58">
          {threadsHydrated ? emptyLabel : "Loading activity..."}
        </div>
      ) : groupMode === "project" ? (
        pagedProjectGroups.map(({ group, paging, threads: visibleThreads }) => (
          <div key={group.key}>
            <SidebarSectionLabel
              label={
                group.kind === "chats"
                  ? "Synara"
                  : resolveThreadProjectLabel(projectById.get(group.projectId))
              }
              {...(group.kind === "project"
                ? {
                    onContextMenu: (position: SidebarRowContextMenuPosition) =>
                      onProjectContextMenu(group.projectId, position),
                  }
                : {})}
            />
            <div className="flex flex-col gap-0.5">
              {visibleThreads.map(renderActiveRow)}
              <SidebarShowMoreRow
                canShowMore={paging.canShowMore}
                canShowLess={paging.canShowLess}
                onShowMore={() => {
                  setProjectExtraPagesByKey((current) => {
                    const next = new Map(current);
                    next.set(group.key, paging.effectiveExtraPages + 1);
                    return next;
                  });
                }}
                onShowLess={() => {
                  setProjectExtraPagesByKey((current) => {
                    const next = new Map(current);
                    const extraPages = Math.max(0, paging.effectiveExtraPages - 1);
                    if (extraPages === 0) next.delete(group.key);
                    else next.set(group.key, extraPages);
                    return next;
                  });
                }}
              />
            </div>
          </div>
        ))
      ) : (
        <>
          {draftThreads.length > 0 ? (
            <div>
              <SidebarSectionLabel label="Drafts" />
              <div className="flex flex-col gap-0.5">{draftThreads.map(renderActiveRow)}</div>
            </div>
          ) : null}
          {recentThreads.length > 0 ? (
            <div>
              <SidebarSectionLabel label="Recent" />
              <div className="flex flex-col gap-0.5">{recentThreads.map(renderActiveRow)}</div>
            </div>
          ) : null}
          {dateBuckets.today.length > 0 ? (
            <div>
              <SidebarSectionLabel label="Today" />
              <div className="flex flex-col gap-0.5">{dateBuckets.today.map(renderActiveRow)}</div>
            </div>
          ) : null}
          {dateBuckets.yesterday.length > 0 ? (
            <div>
              <SidebarSectionLabel label="Yesterday" />
              <div className="flex flex-col gap-0.5">
                {dateBuckets.yesterday.map(renderActiveRow)}
              </div>
            </div>
          ) : null}
          {dateBuckets.earlier.length > 0 ? (
            <SidebarCollapsibleSection
              label="Earlier"
              open={earlierOpen}
              onToggle={() => setEarlierOpen((open) => !open)}
              revealedChildren={earlierRows.revealed.map(renderActiveRow)}
            >
              {earlierRows.visible.map(renderActiveRow)}
              <SidebarShowMoreRow
                canShowMore={earlierPaging.canShowMore}
                canShowLess={earlierPaging.canShowLess}
                onShowMore={() => setEarlierExtraPages(earlierPaging.effectiveExtraPages + 1)}
                onShowLess={() =>
                  setEarlierExtraPages(Math.max(0, earlierPaging.effectiveExtraPages - 1))
                }
              />
            </SidebarCollapsibleSection>
          ) : null}
        </>
      )}

      {model.settled.length > 0 ? (
        <SidebarCollapsibleSection
          label="Done"
          open={settledOpen}
          onToggle={() => setSettledOpen((open) => !open)}
          revealedChildren={settledRows.revealed.map((thread) => renderRow(thread, true))}
        >
          {settledRows.visible.map((thread) => renderRow(thread, true))}
          <SidebarShowMoreRow
            canShowMore={settledPaging.canShowMore}
            canShowLess={settledPaging.canShowLess}
            onShowMore={() => setSettledExtraPages(settledPaging.effectiveExtraPages + 1)}
            onShowLess={() =>
              setSettledExtraPages(Math.max(0, settledPaging.effectiveExtraPages - 1))
            }
          />
        </SidebarCollapsibleSection>
      ) : null}
      <SidebarSnoozedThreadsSection
        threads={model.snoozed}
        renderThreadRow={(thread) => renderRow(thread, false)}
        onVisibleThreadIdsChange={setSnoozedVisibleThreadIds}
      />
    </div>
  );
}
