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
  ClearReadIcon,
  ClockIcon,
  GitBranchIcon,
  GlobeIcon,
  NewThreadIcon,
  SortIcon,
  WorktreeIcon,
  FolderIcon,
} from "~/lib/icons";
import { beginThreadDrag, endThreadDrag } from "~/lib/threadDrag";
import { cn } from "~/lib/utils";
import {
  SIDEBAR_CHILD_STEM_CLASS_NAME,
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
import type { WorkspaceThreadEntry } from "../lib/hosts/workspaceSidebar";
import { WorkspaceThreadActions } from "./hosts/WorkspaceProjects";
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
  activityPriorityStatesEqual,
  buildActivityViewModel,
  collectActivityScopeOptions,
  collectUnreadActivityThreads,
  collectVisibleActivityThreadIds,
  excludeActivityPriorityThreads,
  resolveActivitySectionRows,
  groupActivityThreadsByProject,
  expandActivityFamilyThreadIds,
  groupActivityChildFamilies,
  isActivityThread,
  isThreadSettledForActivity,
  mostUrgentActivityPriorityTier,
  resolveActivityPriority,
  resolveActivityPriorityTier,
  resolveActivityScope,
  resolveChildThreadsTier,
  resolveChildThreadsTone,
  splitActivityFamilyChildren,
  resolveActivityThreadReadAt,
  splitActivityThreadsByDateBucket,
  type ActivityGroupMode,
  type ActivityPriorityState,
  type ActivityPriorityTier,
  type ActivityProjectGroup,
  type ActivityScopeOption,
  type ActivityScopeSelection,
  type ChildThreadsTone,
} from "./SidebarActivityView.logic";
import { SIDEBAR_TRAILING_ICON_CLASS, sidebarGlyphClass } from "./sidebarGlyphs";
import { SIDEBAR_HOVER_CARD_TRIGGER_PROPS } from "./sidebarHoverCardStyles";
import {
  createSidebarThreadRowGestures,
  type SidebarRowContextMenuPosition,
  type SidebarThreadRowGestureProps,
} from "./sidebarThreadRowGestures";
import { SidebarChildThreadsChip } from "./SidebarChildThreadsChip";
import { SidebarIconButton } from "./SidebarIconButton";
import {
  SidebarCollapsibleSection,
  SidebarSectionLabel,
  SidebarShowMoreRow,
} from "./SidebarListSection";
import { SidebarSectionToolbar } from "./SidebarSectionToolbar";
import { SidebarDraftGlyph, SidebarStatusTrailingGlyph } from "./SidebarStatusTrailingGlyph";
import { ThreadRowQuickActions } from "./ThreadRowQuickActions";
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
import { useTranslation } from "~/i18n";

const ACTIVITY_LIST_BASE_LIMIT = 20;
const ACTIVITY_LIST_PAGE_SIZE = 20;
const EMPTY_PROJECT_GROUPS: ActivityProjectGroup[] = [];
const EMPTY_THREADS: SidebarThreadSummary[] = [];

/** What a family's parent row needs to draw its child-count chip. */
interface ActivityRowChildThreads {
  count: number;
  collapsed: boolean;
  tone: ChildThreadsTone;
  /** Folded only: the most urgent hidden state, e.g. "1 needs you". */
  summary: string | null;
  onToggle: () => void;
}

interface ExternalActivityRow {
  hostName: string;
  onOpen: () => void;
  status: ThreadStatusPill | null;
  entry?: WorkspaceThreadEntry;
}

export function ActivityThreadRow({
  thread,
  project,
  external,
  isActive,
  isOpen = isActive,
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
  childThreads,
}: {
  thread: SidebarThreadSummary;
  project: Project | undefined;
  external?: ExternalActivityRow | undefined;
  isActive: boolean;
  isOpen?: boolean;
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
  /**
   * A parent of agent-created threads: its count chip takes the meta line's leading slot,
   * under the provider glyph, and the family's stem drops from it while unfolded.
   */
  childThreads?: ActivityRowChildThreads | undefined;
}) {
  const { t } = useTranslation();

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
    isActive: isOpen,
    slotOccupied: Boolean(threadJumpLabel),
  });
  // Rename/context-menu gestures live on the row wrapper (not the title button) so
  // they also fire over the trailing status and hover-action cluster, which are
  // absolutely positioned siblings of the button.
  const rowGestures = external
    ? undefined
    : createSidebarThreadRowGestures({
        threadId: thread.id,
        onRename,
        onRenamePointerUp,
        onContextMenu,
      });

  const rowContent = (
    <>
      <button
        ref={rowRef}
        aria-current={isActive ? "page" : undefined}
        type="button"
        onClick={onOpen}
        title={external ? `${thread.title} — ${external.hostName}` : undefined}
        aria-label={external ? `${thread.title}, ${external.hostName}` : undefined}
        // Same native drag as the classic thread rows: drop on a chat pane to
        // split, or on a composer to @mention the chat.
        draggable={!external}
        onDragStart={external ? undefined : (event) => beginThreadDrag(event, thread.id)}
        onDragEnd={external ? undefined : endThreadDrag}
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
            // Room for the status glyph only when there is one, so a remote row's globe
            // otherwise sits at the edge.
            trailingStatus && !threadJumpLabel && "pr-4",
            // Local and connected remote rows yield the same space to their three actions.
            (!external || external.entry) &&
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
          {external ? (
            <span
              data-slot="remote-thread-marker"
              className={cn(
                "inline-flex shrink-0",
                external.entry && sidebarHoverRevealHideClassName("activity-row"),
              )}
            >
              <GlobeIcon
                className={cn(SIDEBAR_TRAILING_ICON_CLASS, "text-sky-600 dark:text-sky-400")}
                aria-hidden
              />
            </span>
          ) : null}
          {thread.snoozedUntil != null ? (
            <ClockIcon
              className={sidebarGlyphClass("meta", "shrink-0 text-info")}
              aria-label={t("workspace:detail_scheduled")}
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
        <span className={cn("flex min-w-0 items-center gap-1.5", childThreads && "min-h-5")}>
          <span className={cn("inline-flex shrink-0", childThreads && "invisible")}>
            {project?.cwd && !external ? (
              <ProjectSidebarIcon
                cwd={project.cwd}
                expanded={false}
                appearance={project.appearance}
                glyphClassName={sidebarGlyphClass("meta", "text-muted-foreground/70")}
              />
            ) : (
              <FolderIcon
                className={sidebarGlyphClass("meta", "text-muted-foreground/70")}
                aria-hidden
              />
            )}
          </span>
          <span
            className={cn(
              "min-w-0 truncate text-ui-sm text-muted-foreground/80",
              !childThreads?.summary && "mr-auto",
            )}
          >
            {resolveThreadProjectLabel(project)}
          </span>
          {childThreads?.summary ? (
            <span
              className={cn(
                "mr-auto shrink-0 text-ui-sm",
                childThreads.tone === "waiting" ? "text-warning" : "text-muted-foreground/70",
              )}
            >
              {childThreads.summary}
            </span>
          ) : null}
          {isWorktree ? (
            <WorktreeIcon
              className={sidebarGlyphClass("meta", "text-muted-foreground/70")}
              aria-label={t("common:worktreeMode_worktree")}
            />
          ) : null}
          <span className="flex min-w-0 shrink-[100] items-center gap-1.5">
            {pr && !external ? (
              <PrStateChip
                pr={pr}
                className="min-h-5 min-w-5 shrink-0 justify-center [&_svg]:size-3"
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
      {childThreads ? (
        <>
          <SidebarChildThreadsChip
            count={childThreads.count}
            collapsed={childThreads.collapsed}
            tone={childThreads.tone}
            onToggle={childThreads.onToggle}
            className="absolute top-[33px] left-[7px]"
          />
          {childThreads.collapsed ? null : (
            <span
              aria-hidden="true"
              className={cn(SIDEBAR_CHILD_STEM_CLASS_NAME, "top-[51px] -bottom-px left-4 border-l")}
            />
          )}
        </>
      ) : null}
      {trailingStatus ? (
        <span
          data-slot="activity-completion-status"
          className={cn(
            "pointer-events-none absolute top-2 right-1 inline-flex size-5 items-center justify-center",
            sidebarHoverRevealHideClassName("activity-row"),
          )}
        >
          <SidebarStatusTrailingGlyph status={trailingStatus} />
        </span>
      ) : null}
      {!external ? (
        <span className="absolute top-2 right-1 inline-flex opacity-0 transition-opacity group-hover/activity-row:opacity-100 group-focus-within/activity-row:opacity-100">
          <ThreadRowQuickActions
            threadId={thread.id}
            isPinned={isPinned}
            isSettled={isSettled}
            isSnoozed={thread.snoozedUntil != null}
            toneClassName={actionToneClassName}
            onTogglePinned={onTogglePinned}
            onArchive={onArchive}
            onDone={() => {
              if (thread.snoozedUntil != null) onReturnSnoozed();
              else onSetSettled(!isSettled);
            }}
          />
        </span>
      ) : null}
    </>
  );
  // Every row, local or on another computer, opens the same hover card.
  const withHoverCard = (children: ReactNode, rowProps?: SidebarThreadRowGestureProps) => (
    <Tooltip>
      <TooltipTrigger
        {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
        render={
          <div
            data-thread-hover-anchor={hoverAnchorId}
            className="group/activity-row relative"
            data-thread-item
            {...rowProps}
          />
        }
      >
        {children}
      </TooltipTrigger>
      {renderHoverCard(hoverAnchorId)}
    </Tooltip>
  );
  if (external?.entry) {
    return (
      <WorkspaceThreadActions entry={external.entry}>
        {({ rowEvents, quickActions }) =>
          withHoverCard(
            <>
              {rowContent}
              <span className="absolute top-2 right-1 inline-flex opacity-0 transition-opacity group-hover/activity-row:opacity-100 group-focus-within/activity-row:opacity-100">
                {quickActions}
              </span>
            </>,
            rowEvents,
          )
        }
      </WorkspaceThreadActions>
    );
  }
  return withHoverCard(rowContent, external ? undefined : rowGestures);
}

/**
 * One agent-created child under its parent in the Activity feed: a single line (glyph, title,
 * status) hung on the family's stem, which hooks into the last row.
 */
function ActivityChildThreadRow({
  thread,
  isLast,
  isActive,
  isOpen,
  hasPendingDraft,
  threadJumpLabel,
  status,
  onOpen,
  onRename,
  onRenamePointerUp,
  onContextMenu,
  renderHoverCard,
  rowRef,
}: {
  thread: SidebarThreadSummary;
  isLast: boolean;
  isActive: boolean;
  isOpen: boolean;
  hasPendingDraft: boolean;
  threadJumpLabel: string | null;
  status: ThreadStatusPill | null;
  onOpen: () => void;
  onRename: (threadId: ThreadId) => void;
  onRenamePointerUp: (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => void;
  onContextMenu: (threadId: ThreadId, position: SidebarRowContextMenuPosition) => void;
  renderHoverCard: (anchorId: string) => ReactNode;
  rowRef?: Ref<HTMLButtonElement>;
}) {
  const provider = thread.session?.provider ?? thread.modelSelection.provider;
  const hoverAnchorId = createSidebarThreadHoverAnchorId({
    scope: "activity",
    threadId: thread.id,
  });
  const trailingStatus = resolveThreadStatusTrailingIndicator({
    status,
    isActive: isOpen,
    slotOccupied: Boolean(threadJumpLabel),
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
            {...createSidebarThreadRowGestures({
              threadId: thread.id,
              onRename,
              onRenamePointerUp,
              onContextMenu,
            })}
          />
        }
      >
        <span
          aria-hidden="true"
          className={cn(
            SIDEBAR_CHILD_STEM_CLASS_NAME,
            "left-4",
            isLast ? "top-0 h-1/2 w-2.5 rounded-bl-md border-b border-l" : "-inset-y-px border-l",
          )}
        />
        <button
          ref={rowRef}
          type="button"
          aria-current={isActive ? "page" : undefined}
          onClick={onOpen}
          draggable
          onDragStart={(event) => beginThreadDrag(event, thread.id)}
          onDragEnd={endThreadDrag}
          data-testid={`activity-child-thread-${thread.id}`}
          className={cn(
            "flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg pr-2 pl-7.5 text-left select-none",
            SIDEBAR_ROW_FOCUS_CLASS_NAME,
            isActive ? SIDEBAR_ROW_ACTIVE_CLASS_NAME : SIDEBAR_ROW_HOVER_CLASS_NAME,
            trailingStatus && !threadJumpLabel && "pr-6",
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
          {hasPendingDraft ? <SidebarDraftGlyph /> : null}
          {threadJumpLabel ? (
            <ShortcutKbd shortcutLabel={threadJumpLabel} title={threadJumpLabel} />
          ) : null}
        </button>
        {trailingStatus && !threadJumpLabel ? (
          <span className="pointer-events-none absolute top-1 right-1 inline-flex size-5 items-center justify-center">
            <SidebarStatusTrailingGlyph status={trailingStatus} />
          </span>
        ) : null}
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
  const { t } = useTranslation();

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
      label={t("workspace:snoozed")}
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
  const { t } = useTranslation();

  const [menuOpen, setMenuOpen] = useState(false);
  const scopeLabel =
    scopeSelection === null
      ? t("workspace:allActivity")
      : scopeSelection === "chats"
        ? "Synara"
        : resolveThreadProjectLabel(projectById.get(scopeSelection));

  return (
    <Menu onOpenChange={(open) => setMenuOpen(open)}>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={t("workspace:filterActivityByProject")}
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
            {t("workspace:activityScope")}
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
              {t("workspace:allActivity")}
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
 * project) and hosts "Mark all as read" and "Clear read from Priority" below that choice.
 */
function ActivityFilterMenu({
  groupMode,
  onChangeGroupMode,
  markAllReadDisabled,
  onMarkAllRead,
  clearReadPriorityDisabled,
  onClearReadPriority,
}: {
  groupMode: ActivityGroupMode;
  onChangeGroupMode: (mode: ActivityGroupMode) => void;
  markAllReadDisabled: boolean;
  onMarkAllRead: () => void;
  clearReadPriorityDisabled: boolean;
  onClearReadPriority: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Menu>
      <SidebarIconButton
        icon={SortIcon}
        label={t("workspace:activityOptions")}
        tooltip={t("workspace:activityOptions")}
        tooltipSide="bottom"
        render={<MenuTrigger />}
      />
      <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-ui leading-snug font-medium text-muted-foreground">
            {t("workspace:groupBy")}
          </div>
          <MenuRadioGroup
            value={groupMode}
            onValueChange={(value) => onChangeGroupMode(value as ActivityGroupMode)}
          >
            <MenuRadioItem value="time" className="min-h-7 py-1 sm:text-ui leading-snug">
              {t("workspace:schedule_time")}
            </MenuRadioItem>
            <MenuRadioItem value="project" className="min-h-7 py-1 sm:text-ui leading-snug">
              {t("chat:detail_project")}
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem
          className="min-h-7 py-1 sm:text-ui leading-snug"
          disabled={markAllReadDisabled}
          onClick={onMarkAllRead}
        >
          {t("workspace:markAllAsRead")}
        </MenuItem>
        <MenuItem
          className="min-h-7 py-1 sm:text-ui leading-snug"
          disabled={clearReadPriorityDisabled}
          onClick={onClearReadPriority}
        >
          {t("workspace:clearReadPriority")}
        </MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

export function SidebarActivityView({
  threads,
  projectById,
  externalRows,
  activeThreadId,
  visualActiveThreadId = activeThreadId,
  pinnedThreadIdSet,
  settledOverrideByThreadId: ownSettledOverrideByThreadId,
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
  groupMode,
  onChangeGroupMode,
  onCreateChat,
  onAddProject,
  childThreadNesting = null,
}: {
  threads: readonly SidebarThreadSummary[];
  projectById: ReadonlyMap<ProjectId, Project>;
  externalRows?: ReadonlyMap<ThreadId, ExternalActivityRow> | undefined;
  activeThreadId: ThreadId | null;
  /** A hidden child can select its root row while the real chat still owns unread/draft state. */
  visualActiveThreadId?: ThreadId | null;
  pinnedThreadIdSet: ReadonlySet<ThreadId>;
  settledOverrideByThreadId: ReadonlyMap<ThreadId, boolean>;
  threadsHydrated: boolean;
  /** Owned by the sidebar so the scope survives this view unmounting (Settings, reloads). */
  scopeSelection: ActivityScopeSelection;
  onScopeSelectionChange: (selection: ActivityScopeSelection) => void;
  prByThreadId: ReadonlyMap<ThreadId, OrchestrationThreadPullRequest | null>;
  threadJumpLabelByThreadId: ReadonlyMap<ThreadId, string>;
  onVisibleThreadIdsChange: (threadIds: readonly ThreadId[]) => void;
  groupMode: ActivityGroupMode;
  onChangeGroupMode: (mode: ActivityGroupMode) => void;
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
  /**
   * Agent-created threads fold under their creator, sharing the project list's fold state.
   * Null while the "Child threads" setting is off: every thread keeps its own row.
   */
  childThreadNesting?: {
    collapsedParentIds: ReadonlySet<ThreadId>;
    onToggleCollapsed: (threadId: ThreadId) => void;
  } | null;
}) {
  const { t } = useTranslation();

  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [earlierExtraPages, setEarlierExtraPages] = useState(0);
  const [settledOpen, setSettledOpen] = useState(false);
  const [settledExtraPages, setSettledExtraPages] = useState(0);
  const [snoozedVisibleThreadIds, setSnoozedVisibleThreadIds] = useState<readonly ThreadId[]>([]);
  const [projectExtraPagesByKey, setProjectExtraPagesByKey] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  // Families whose quiet (done, read) children were revealed with "+N done".
  const [quietChildrenShownRootIds, setQuietChildrenShownRootIds] = useState<ReadonlySet<ThreadId>>(
    () => new Set(),
  );
  // Priority's order lives as long as this view. "Clear read" bumps the generation for a
  // fresh sort; so do scope and grouping changes, through the key.
  const [priorityGeneration, setPriorityGeneration] = useState(0);
  const [storedPriority, setStoredPriority] = useState<{
    key: string;
    state: ActivityPriorityState;
  } | null>(null);

  // Remote rows carry the status resolved by their owner, never the controller's store.
  const resolveRowStatus = useCallback(
    (thread: SidebarThreadSummary) =>
      externalRows?.has(thread.id)
        ? externalRows.get(thread.id)!.status
        : resolveThreadStatus(thread),
    [externalRows, resolveThreadStatus],
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
  const preparingThreadIdSet = useMemo(
    () =>
      new Set(
        threads
          .filter((thread) => resolveRowStatus(thread)?.label === "Preparing worktree")
          .map((thread) => thread.id),
      ),
    [threads, resolveRowStatus],
  );
  const resolveOwnTier = useCallback(
    (thread: SidebarThreadSummary) => resolveActivityPriorityTier(resolveRowStatus(thread)),
    [resolveRowStatus],
  );
  // Agent-created threads ride under their creator as one family. Only same-project
  // children nest, as in the project list, so a project scope never hides a thread.
  const childFamilies = useMemo(() => {
    if (!childThreadNesting) return null;
    const eligible = threads.filter((thread) =>
      isActivityThread(thread, preparingThreadIdSet.has(thread.id)),
    );
    return groupActivityChildFamilies(eligible, pinnedThreadIdSet);
  }, [childThreadNesting, pinnedThreadIdSet, preparingThreadIdSet, threads]);
  // Section previews contain roots, so reveal the creator when the open chat is nested.
  const activeSectionThreadId = useMemo(() => {
    if (visualActiveThreadId !== null) {
      for (const [rootId, children] of childFamilies?.childrenByRootId ?? []) {
        if (children.some((child) => child.id === visualActiveThreadId)) return rootId;
      }
    }
    return visualActiveThreadId;
  }, [childFamilies, visualActiveThreadId]);
  const childTierByRootId = useMemo(() => {
    const tiers = new Map<ThreadId, ActivityPriorityTier | null>();
    for (const [rootId, children] of childFamilies?.childrenByRootId ?? []) {
      tiers.set(rootId, resolveChildThreadsTier(children, resolveOwnTier));
    }
    return tiers;
  }, [childFamilies, resolveOwnTier]);
  // A family ranks by its most urgent member, so a child waiting on the user lifts its parent.
  const resolveRowTier = useCallback(
    (thread: SidebarThreadSummary) =>
      mostUrgentActivityPriorityTier(
        resolveOwnTier(thread),
        childTierByRootId.get(thread.id) ?? null,
      ),
    [childTierByRootId, resolveOwnTier],
  );
  // Keep a family's current work or unread results visible without changing its saved Done state.
  const settledOverrideByThreadId = useMemo(() => {
    const reopened = [...childTierByRootId].filter(([, tier]) => tier !== null);
    if (reopened.length === 0) return ownSettledOverrideByThreadId;
    const overrides = new Map(ownSettledOverrideByThreadId);
    for (const [rootId] of reopened) overrides.set(rootId, false);
    return overrides;
  }, [childTierByRootId, ownSettledOverrideByThreadId]);
  const feedThreads = childFamilies?.roots ?? threads;
  const scopeOptions = useMemo(
    () => collectActivityScopeOptions(threads, isRealProject, preparingThreadIdSet),
    [isRealProject, threads, preparingThreadIdSet],
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
        threads: feedThreads,
        pinnedThreadIdSet,
        draftThreadIdSet,
        preparingThreadIdSet,
        activeThreadId,
        settledOverrideByThreadId,
        projectFilterIds,
      }),
    [
      activeThreadId,
      draftThreadIdSet,
      feedThreads,
      preparingThreadIdSet,
      pinnedThreadIdSet,
      projectFilterIds,
      settledOverrideByThreadId,
    ],
  );
  const priorityKey = `${groupMode}:${activeScope ?? "all"}:${priorityGeneration}`;
  const previousPriority = storedPriority?.key === priorityKey ? storedPriority.state : null;
  // Priority leads the time-grouped feed; the project grouping keeps its own blocks.
  const priority = useMemo(
    () =>
      groupMode === "time"
        ? resolveActivityPriority({
            candidates: [
              ...model.pinned.filter(
                (thread) => !isThreadSettledForActivity(thread, settledOverrideByThreadId),
              ),
              ...model.drafts,
              ...model.active,
            ],
            resolveTier: resolveRowTier,
            previous: previousPriority,
            nowMs: Date.now(),
          })
        : null,
    [groupMode, model, previousPriority, resolveRowTier, settledOverrideByThreadId],
  );
  useEffect(() => {
    // Before hydration every thread is missing; storing that would sort later rows as
    // late arrivals instead of ranking them.
    if (!threadsHydrated) return;
    if (priority === null) {
      // Project grouping ends the held order; returning to Time starts a fresh sort.
      setStoredPriority(null);
      return;
    }
    if (activityPriorityStatesEqual(previousPriority, priority.state)) return;
    setStoredPriority({ key: priorityKey, state: priority.state });
  }, [previousPriority, priority, priorityKey, threadsHydrated]);
  const priorityThreads = priority?.threads ?? EMPTY_THREADS;
  const {
    pinned: scopedPinnedThreads,
    drafts: draftThreads,
    active: remainingActiveThreads,
  } = useMemo(
    () => excludeActivityPriorityThreads(model, priorityThreads),
    [model, priorityThreads],
  );
  const clearReadPriorityDisabled = !priorityThreads.some(
    (thread) => resolveRowTier(thread) === null,
  );
  const clearReadPriority = () => setPriorityGeneration((generation) => generation + 1);
  // Coarse clock so the date bucketing memo stays effective across renders that
  // happen within the same minute; buckets are day-granular anyway.
  const nowMs = Math.floor(Date.now() / 60_000) * 60_000;
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
        activeThreadId: activeSectionThreadId,
      }).visible,
    };
  });
  const pinnedRows = useMemo(
    () =>
      resolveActivitySectionRows(scopedPinnedThreads, {
        open: pinnedOpen,
        previewLimit: scopedPinnedThreads.length,
        activeThreadId: activeSectionThreadId,
      }),
    [activeSectionThreadId, pinnedOpen, scopedPinnedThreads],
  );
  const earlierRows = useMemo(
    () =>
      resolveActivitySectionRows(dateBuckets.earlier, {
        open: earlierOpen,
        previewLimit: earlierPaging.previewLimit,
        activeThreadId: activeSectionThreadId,
      }),
    [activeSectionThreadId, dateBuckets.earlier, earlierOpen, earlierPaging.previewLimit],
  );
  const settledRows = useMemo(
    () =>
      resolveActivitySectionRows(model.settled, {
        open: settledOpen,
        previewLimit: settledPaging.previewLimit,
        activeThreadId: activeSectionThreadId,
      }),
    [activeSectionThreadId, model.settled, settledOpen, settledPaging.previewLimit],
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
  const familyChildRowsByRootId = useMemo(() => {
    const rows = new Map<
      ThreadId,
      { collapsed: boolean; visible: SidebarThreadSummary[]; quietCount: number }
    >();
    if (!childFamilies || !childThreadNesting) return rows;
    for (const [rootId, children] of childFamilies.childrenByRootId) {
      const collapsed = childThreadNesting.collapsedParentIds.has(rootId);
      rows.set(rootId, {
        collapsed,
        ...(collapsed
          ? { visible: [], quietCount: 0 }
          : splitActivityFamilyChildren(children, {
              resolveTier: resolveOwnTier,
              activeThreadId: visualActiveThreadId,
              showQuiet: quietChildrenShownRootIds.has(rootId),
            })),
      });
    }
    return rows;
  }, [
    childFamilies,
    childThreadNesting,
    quietChildrenShownRootIds,
    resolveOwnTier,
    visualActiveThreadId,
  ]);
  const visibleThreadIds = useMemo(
    () => [
      ...expandActivityFamilyThreadIds(
        collectVisibleActivityThreadIds({
          groupMode,
          pinnedOpen,
          pinned: scopedPinnedThreads,
          priority: priorityThreads,
          drafts: draftThreads,
          today: dateBuckets.today,
          yesterday: dateBuckets.yesterday,
          earlierOpen,
          earlier: earlierRows.visible,
          projectGroups: pagedProjectGroups.map((group) => group.threads),
          settledOpen,
          settled: settledRows.visible,
          revealed: revealedThreads,
        }),
        new Map(
          [...familyChildRowsByRootId].map(([rootId, rows]) => [
            rootId,
            rows.visible.map((child) => child.id),
          ]),
        ),
      ),
      ...snoozedVisibleThreadIds,
    ],
    [
      familyChildRowsByRootId,
      dateBuckets.today,
      dateBuckets.yesterday,
      draftThreads,
      earlierOpen,
      earlierRows.visible,
      groupMode,
      pagedProjectGroups,
      pinnedOpen,
      priorityThreads,
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
    visualActiveThreadId !== null && visibleThreadIds.includes(visualActiveThreadId)
      ? `${visualActiveThreadId}:${groupMode}:${activeScope ?? "all"}`
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
  }, [externalRows, onVisibleThreadIdsChange, visibleThreadIdsFingerprint]);
  useEffect(
    () => () => {
      onVisibleThreadIdsChange([]);
    },
    [onVisibleThreadIdsChange],
  );

  const markAllRead = () => {
    for (const thread of unreadThreads) {
      if (externalRows?.has(thread.id)) continue;
      onMarkThreadRead(thread.id, resolveActivityThreadReadAt(thread));
    }
  };

  const resolveRowChildThreads = (
    thread: SidebarThreadSummary,
  ): ActivityRowChildThreads | undefined => {
    const children = childFamilies?.childrenByRootId.get(thread.id);
    const rows = familyChildRowsByRootId.get(thread.id);
    if (!children || !rows || !childThreadNesting) return undefined;
    const tier = childTierByRootId.get(thread.id) ?? null;
    const tierCount = (wanted: ActivityPriorityTier) =>
      children.filter((child) => resolveOwnTier(child) === wanted).length;
    const summary = !rows.collapsed
      ? null
      : tier === "waiting"
        ? t("workspace:childThreadsWaiting", { count: tierCount("waiting") })
        : tier === "unread"
          ? t("workspace:childThreadsUnread", { count: tierCount("unread") })
          : tier === "working"
            ? t("workspace:childThreadsWorking", { count: tierCount("working") })
            : null;
    return {
      count: children.length,
      collapsed: rows.collapsed,
      tone: resolveChildThreadsTone(tier),
      summary,
      onToggle: () => childThreadNesting.onToggleCollapsed(thread.id),
    };
  };

  const renderChildRows = (rootId: ThreadId) => {
    const rows = familyChildRowsByRootId.get(rootId);
    if (!rows || rows.collapsed) return null;
    return (
      <div className="flex flex-col">
        {rows.visible.map((child, index) => (
          <ActivityChildThreadRow
            key={child.id}
            thread={child}
            isLast={index === rows.visible.length - 1 && rows.quietCount === 0}
            {...(visualActiveThreadId === child.id ? { rowRef: activeRowRef } : {})}
            isActive={visualActiveThreadId === child.id}
            isOpen={activeThreadId === child.id}
            hasPendingDraft={draftThreadIdSet.has(child.id)}
            threadJumpLabel={threadJumpLabelByThreadId.get(child.id) ?? null}
            status={resolveThreadStatus(child)}
            onOpen={() => onOpenThread(child.id)}
            onRename={onRenameThread}
            onRenamePointerUp={onThreadRenamePointerUp}
            onContextMenu={onThreadContextMenu}
            renderHoverCard={(anchorId) => renderThreadHoverCard(child, anchorId)}
          />
        ))}
        {rows.quietCount > 0 ? (
          <div className="relative">
            <span
              aria-hidden="true"
              className={cn(
                SIDEBAR_CHILD_STEM_CLASS_NAME,
                "top-0 left-4 h-1/2 w-2.5 rounded-bl-md border-b border-l",
              )}
            />
            <button
              type="button"
              className={cn(
                "flex h-6 w-full cursor-pointer items-center rounded-lg pr-2 pl-7.5 text-left text-ui-sm text-muted-foreground/70 hover:text-foreground",
                SIDEBAR_ROW_FOCUS_CLASS_NAME,
              )}
              onClick={() =>
                setQuietChildrenShownRootIds((current) => new Set(current).add(rootId))
              }
            >
              {t("workspace:childThreadsDoneCount", { count: rows.quietCount })}
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  const renderRow = (
    thread: SidebarThreadSummary,
    isSettled: boolean,
    registerActiveRow = true,
  ) => {
    const external = externalRows?.get(thread.id);
    const childThreads = external ? undefined : resolveRowChildThreads(thread);
    const row = (
      <ActivityThreadRow
        key={thread.id}
        thread={thread}
        project={projectById.get(thread.projectId)}
        external={external}
        {...(registerActiveRow && visualActiveThreadId === thread.id
          ? { rowRef: activeRowRef }
          : {})}
        isActive={visualActiveThreadId === thread.id}
        isOpen={activeThreadId === thread.id}
        isSettled={isSettled}
        isPinned={pinnedThreadIdSet.has(thread.id)}
        hasPendingDraft={!external && draftThreadIdSet.has(thread.id)}
        threadJumpLabel={threadJumpLabelByThreadId.get(thread.id) ?? null}
        pr={
          external
            ? null
            : // An explicit null from the resolver means the persisted PR was ruled out (e.g. the
              // checkout moved on); falling back to raw lastKnownPr would resurrect that stale
              // badge. Rows not yet covered (revealed by paging a paint before the parent's map
              // catches up) get the same resolution without live status instead.
              prByThreadId.has(thread.id)
              ? (prByThreadId.get(thread.id) ?? null)
              : resolveThreadPullRequestFallback({
                  branch: thread.branch,
                  hasDedicatedWorktree: thread.worktreePath !== null,
                  lastKnownPr: thread.lastKnownPr ?? null,
                  pullRequests: thread.pullRequests,
                })
        }
        status={external ? external.status : resolveThreadStatus(thread)}
        onOpen={external?.onOpen ?? (() => onOpenThread(thread.id))}
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
        childThreads={childThreads}
      />
    );
    if (!childThreads) return row;
    return (
      <div key={thread.id} className="flex flex-col">
        {row}
        {renderChildRows(thread.id)}
      </div>
    );
  };
  const renderActiveRow = (thread: SidebarThreadSummary) =>
    renderRow(thread, isThreadSettledForActivity(thread, settledOverrideByThreadId));

  // The placeholder speaks for the whole surface, so it may only appear when no
  // section has rows — a feed with nothing active but a populated Pinned or Done
  // section is not empty.
  const isEmpty =
    model.active.length === 0 &&
    model.settled.length === 0 &&
    model.drafts.length === 0 &&
    model.snoozed.length === 0 &&
    model.pinned.length === 0;
  const emptyLabel =
    activeScope === null
      ? t("workspace:noActivityYet")
      : activeScope === "chats"
        ? t("workspace:noActivityInSynaraChats")
        : t("workspace:noActivityForThisProject");

  return (
    <div className="flex flex-col gap-3">
      {scopedPinnedThreads.length > 0 ? (
        <SidebarCollapsibleSection
          label={t("common:app_pinned")}
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
            label={t("workspace:startNewChatInLastUsedProject")}
            tooltip={t("workspace:sections_newChat")}
            tooltipSide="bottom"
            onClick={onCreateChat}
          />
          <SidebarIconButton
            icon={AddPlusIcon}
            label={t("workspace:sections_addProject")}
            tooltip={t("workspace:sections_addProject")}
            tooltipSide="bottom"
            onClick={onAddProject}
          />
        </SidebarSectionToolbar>
        <ActivityFilterMenu
          groupMode={groupMode}
          onChangeGroupMode={onChangeGroupMode}
          markAllReadDisabled={!unreadThreads.some((thread) => !externalRows?.has(thread.id))}
          onMarkAllRead={markAllRead}
          clearReadPriorityDisabled={clearReadPriorityDisabled}
          onClearReadPriority={clearReadPriority}
        />
      </div>

      {isEmpty ? (
        <div className="px-2 pt-4 text-center text-ui text-muted-foreground/58">
          {threadsHydrated ? emptyLabel : t("workspace:loadingActivity")}
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
              {...(group.kind === "project" &&
              !group.threads.some((thread) => externalRows?.has(thread.id))
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
          {priorityThreads.length > 0 ? (
            <div>
              <SidebarSectionLabel
                label={t("workspace:priority")}
                action={
                  clearReadPriorityDisabled ? null : (
                    <SidebarIconButton
                      icon={ClearReadIcon}
                      label={t("workspace:clearReadPriority")}
                      tooltip={t("workspace:clearReadPriority")}
                      size="sm"
                      onClick={clearReadPriority}
                    />
                  )
                }
              />
              <div className="flex flex-col gap-0.5">{priorityThreads.map(renderActiveRow)}</div>
            </div>
          ) : null}
          {draftThreads.length > 0 ? (
            <div>
              <SidebarSectionLabel label={t("workspace:drafts")} />
              <div className="flex flex-col gap-0.5">{draftThreads.map(renderActiveRow)}</div>
            </div>
          ) : null}
          {dateBuckets.today.length > 0 ? (
            <div>
              <SidebarSectionLabel label={t("workspace:today")} />
              <div className="flex flex-col gap-0.5">{dateBuckets.today.map(renderActiveRow)}</div>
            </div>
          ) : null}
          {dateBuckets.yesterday.length > 0 ? (
            <div>
              <SidebarSectionLabel label={t("workspace:yesterday")} />
              <div className="flex flex-col gap-0.5">
                {dateBuckets.yesterday.map(renderActiveRow)}
              </div>
            </div>
          ) : null}
          {dateBuckets.earlier.length > 0 ? (
            <SidebarCollapsibleSection
              label={t("workspace:earlier")}
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
          label={t("git:detail_done")}
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
