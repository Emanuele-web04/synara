// FILE: Sidebar.tsx
// Purpose: Renders the project/thread sidebar, including row status, sorting, and thread actions.
// Exports: Sidebar

import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  GitPullRequestIcon,
  type LucideIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  Trash2,
  TriangleAlertIcon,
} from "~/lib/icons";
import { autoAnimate } from "@formkit/auto-animate";
import { FiGitBranch, FiPlus } from "react-icons/fi";
import { HiOutlineCheckCircle } from "react-icons/hi2";
import { HiOutlineFolderOpen } from "react-icons/hi2";
import { TbArrowsDiagonal, TbArrowsDiagonalMinimize2, TbCursorText } from "react-icons/tb";
import { IoFilter } from "react-icons/io5";
import { LuMessageSquareDashed, LuSplit } from "react-icons/lu";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type DesktopUpdateState,
  type OrchestrationReadModel,
  PROVIDER_DISPLAY_NAMES,
  ProjectId,
  ThreadId,
  type GitStatusResult,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { resolveThreadWorkspaceCwd } from "@t3tools/shared/threadEnvironment";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
  useAppSettings,
} from "../appSettings";
import { isElectron } from "../env";
import { APP_VERSION } from "../branding";
import { showConfirmDialogFallback } from "../confirmDialogFallback";
import { isMacPlatform, newCommandId, newProjectId } from "../lib/utils";
import { useStore } from "../store";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import {
  createSidebarDisplayThreadsSelector,
  createSidebarThreadSummariesSelector,
} from "../storeSelectors";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import { gitRemoveWorktreeMutationOptions, gitStatusQueryOptions } from "../lib/gitReactQuery";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadEnvironmentPresentation } from "../lib/threadEnvironment";
import { type SidebarThreadSummary, type Thread } from "../types";
import { ClaudeAI, OpenAI } from "./Icons";
import { ProjectSidebarIcon } from "./ProjectSidebarIcon";
import { ThreadPinToggleButton } from "./ThreadPinToggleButton";
import { RenameThreadDialog } from "./RenameThreadDialog";
import { SidebarSearchPalette } from "./SidebarSearchPalette";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useThreadHandoff } from "../hooks/useThreadHandoff";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { toastManager } from "./ui/toast";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonPresentation,
  getDesktopUpdateButtonTooltip,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldHighlightDesktopUpdateError,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import { ShortcutKbd } from "./ui/shortcut-kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenuAction,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  SidebarTrigger,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { isNonEmpty as isNonEmptyString } from "effect/String";
import {
  describeAddProjectError,
  buildProjectThreadTree,
  extractDuplicateProjectCreateProjectId,
  findWorkspaceRootMatch,
  getFallbackThreadIdAfterDelete,
  getPinnedThreadsForSidebar,
  getNextVisibleSidebarThreadId,
  getVisibleSidebarEntriesForPreview,
  getUnpinnedThreadsForSidebar,
  resolveProjectStatusIndicator,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  isDuplicateProjectCreateError,
  shouldPrunePinnedThreads,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic";
import { resolveSubagentPresentationForThread } from "../lib/subagentPresentation";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import {
  canCreateThreadHandoff,
  resolveHandoffTargetProvider,
  resolveThreadHandoffBadgeLabel,
} from "../lib/threadHandoff";
import { isTerminalFocused } from "../lib/terminalFocus";
import { parseDiffRouteSearch } from "../diffRouteSearch";
import {
  normalizeSettingsSection,
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_ITEMS,
} from "../settingsNavigation";
import {
  resolveSplitViewFocusedThreadId,
  resolveSplitViewPaneForThread,
  selectSplitView,
  type SplitView,
  type SplitViewPane,
  useSplitViewStore,
} from "../splitViewStore";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { usePinnedThreadsStore } from "../pinnedThreadsStore";
import { useWorkspaceStore, workspaceThreadId } from "../workspaceStore";
import type {
  SidebarSearchAction,
  SidebarSearchProject,
  SidebarSearchThread,
} from "./SidebarSearchPalette.logic";
import { useFocusedChatContext } from "../focusedChatContext";
import { showContextMenuFallback } from "../contextMenuFallback";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const THREAD_PREVIEW_LIMIT = 5;
const SIDEBAR_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
};
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;
const ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS = 6;
const ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS = 50;
const ADD_PROJECT_EXISTING_SYNC_ERROR =
  "This folder is already linked, but the existing project has not synced into the sidebar yet. Try again in a moment.";

const PROJECT_CONTEXT_MENU_FOLDER_ICON = renderToStaticMarkup(<HiOutlineFolderOpen />);
const PROJECT_CONTEXT_MENU_EDIT_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const PROJECT_CONTEXT_MENU_REMOVE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const PROJECT_CONTEXT_MENU_COPY_PATH_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function ProviderGlyph({
  provider,
  className,
}: {
  provider: "codex" | "claudeAgent";
  className?: string;
}) {
  if (provider === "claudeAgent") {
    return <ClaudeAI aria-hidden="true" className={cn("text-foreground", className)} />;
  }
  return <OpenAI aria-hidden="true" className={cn("text-muted-foreground/60", className)} />;
}

function HandoffProviderGlyph({
  sourceProvider,
  targetProvider,
}: {
  sourceProvider: "codex" | "claudeAgent";
  targetProvider: "codex" | "claudeAgent";
}) {
  return (
    <div className="relative h-4.5 w-5 shrink-0">
      <span className="absolute left-0 top-1/2 inline-flex size-3.5 -translate-y-1/2 items-center justify-center rounded-full border border-background bg-background shadow-xs">
        <ProviderGlyph provider={sourceProvider} className="size-2.5" />
      </span>
      <span className="absolute right-0 top-1/2 z-10 inline-flex size-3.5 -translate-y-1/2 items-center justify-center rounded-full border border-background bg-background shadow-xs">
        <ProviderGlyph provider={targetProvider} className="size-2.5" />
      </span>
    </div>
  );
}

function WorktreeBadgeGlyph({ className }: { className?: string }) {
  return <LuSplit aria-hidden="true" className={cn("rotate-90", className)} />;
}

function resolveWorktreeBadgeLabel(
  thread: Pick<Thread, "envMode" | "worktreePath">,
): string | null {
  return resolveThreadEnvironmentPresentation({
    envMode: thread.envMode,
    worktreePath: thread.worktreePath,
  }).worktreeBadgeLabel;
}

function ThreadRowMetaBadge({
  tooltip,
  children,
}: {
  tooltip: string | null;
  children?: ReactNode;
}) {
  const content = (
    <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      {children ?? null}
    </span>
  );
  if (!tooltip || !children) {
    return <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center" />;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={content} />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function resolveThreadRowMetaBadge(input: {
  thread: Pick<Thread, "forkSourceThreadId" | "envMode" | "worktreePath" | "handoff">;
  includeHandoffBadge: boolean;
}): {
  tooltip: string;
  icon: ReactNode;
} | null {
  const forkBadgeLabel = input.thread.forkSourceThreadId ? "Forked thread" : null;
  if (forkBadgeLabel) {
    return {
      tooltip: forkBadgeLabel,
      icon: <GitPullRequestIcon className="size-3 text-emerald-600 dark:text-emerald-300/90" />,
    };
  }

  const worktreeBadgeLabel = resolveWorktreeBadgeLabel(input.thread);
  if (worktreeBadgeLabel) {
    return {
      tooltip: worktreeBadgeLabel,
      icon: <WorktreeBadgeGlyph className="size-3 text-muted-foreground/55" />,
    };
  }

  const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(input.thread);
  if (input.includeHandoffBadge && handoffBadgeLabel) {
    return {
      tooltip: handoffBadgeLabel,
      icon: <FiGitBranch className="size-3 text-muted-foreground/55" />,
    };
  }

  return null;
}

type SidebarSplitPreview = {
  title: string;
  provider: "codex" | "claudeAgent";
  threadId: ThreadId | null;
};

type SidebarProjectEntry =
  | {
      kind: "thread";
      rowId: ThreadId;
      rootRowId: ThreadId;
      thread: SidebarThreadSummary;
      depth: number;
      childCount: number;
      isExpanded: boolean;
    }
  | {
      kind: "split";
      rowId: ThreadId;
      rootRowId: ThreadId;
      splitView: SplitView;
    };

function renderSubagentLabel(input: {
  threadId: string;
  parentThreadId?: string | null | undefined;
  agentId?: string | null | undefined;
  nickname?: string | null | undefined;
  role?: string | null | undefined;
  title?: string | null | undefined;
  threads?: ReadonlyArray<Thread> | undefined;
  titleClassName?: string;
  roleClassName?: string;
}) {
  const presentation = resolveSubagentPresentationForThread({
    thread: {
      id: input.threadId,
      parentThreadId: input.parentThreadId,
      subagentAgentId: input.agentId,
      subagentNickname: input.nickname,
      subagentRole: input.role,
      title: input.title,
    },
    threads: input.threads,
  });
  const supportingLabel =
    presentation.role ??
    (presentation.nickname && presentation.title && presentation.title !== presentation.nickname
      ? presentation.title
      : null);

  return (
    <span className="min-w-0 truncate">
      <span
        className={cn("font-medium", input.titleClassName)}
        style={{ color: presentation.accentColor }}
      >
        {presentation.nickname ?? presentation.primaryLabel}
      </span>
      {supportingLabel ? (
        <span className={cn("ml-1 text-muted-foreground/48", input.roleClassName)}>
          {presentation.role ? `(${presentation.role})` : supportingLabel}
        </span>
      ) : null}
    </span>
  );
}

function resolveSplitPreviewTitle(input: {
  thread: Thread | null;
  draftPrompt: string | null;
}): string {
  if (input.thread?.title) {
    return input.thread.title;
  }
  const draftPrompt = input.draftPrompt?.trim() ?? "";
  if (draftPrompt.length > 0) {
    return draftPrompt;
  }
  return "New chat";
}

export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

interface TerminalStatusIndicator {
  label: "Terminal input needed" | "Terminal task completed" | "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

type ThreadPr = GitStatusResult["pr"];

function terminalStatusFromThreadState(input: {
  runningTerminalIds: string[];
  terminalAttentionStatesById: Record<string, "attention" | "review">;
}): TerminalStatusIndicator | null {
  const terminalAttentionStates = Object.values(input.terminalAttentionStatesById ?? {});
  if (terminalAttentionStates.includes("attention")) {
    return {
      label: "Terminal input needed",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      pulse: false,
    };
  }
  if ((input.runningTerminalIds?.length ?? 0) > 0) {
    return {
      label: "Terminal process running",
      colorClass: "text-teal-600 dark:text-teal-300/90",
      pulse: true,
    };
  }
  if (terminalAttentionStates.includes("review")) {
    return {
      label: "Terminal task completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      pulse: false,
    };
  }
  return null;
}

function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

function T3Wordmark() {
  return (
    <span
      aria-label="DP"
      className="shrink-0 text-[14px] font-semibold tracking-tight text-foreground"
    >
      DP
    </span>
  );
}

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function ProjectSortMenu({
  projectSortOrder,
  threadSortOrder,
  onProjectSortOrderChange,
  onThreadSortOrderChange,
}: {
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={<MenuTrigger className="sidebar-icon-button inline-flex size-5 cursor-pointer" />}
        >
          <IoFilter className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sort projects</TooltipPopup>
      </Tooltip>
      <MenuPopup
        align="end"
        side="bottom"
        className="min-w-44 rounded-lg border-border bg-popover shadow-lg"
      >
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">
            Sort projects
          </div>
          <MenuRadioGroup
            value={projectSortOrder}
            onValueChange={(value) => {
              onProjectSortOrderChange(value as SidebarProjectSortOrder);
            }}
          >
            {(Object.entries(SIDEBAR_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>).map(
              ([value, label]) => (
                <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                  {label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 sm:text-xs font-medium text-muted-foreground">
            Sort threads
          </div>
          <MenuRadioGroup
            value={threadSortOrder}
            onValueChange={(value) => {
              onThreadSortOrderChange(value as SidebarThreadSortOrder);
            }}
          >
            {(
              Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function SidebarPrimaryAction({
  icon: Icon,
  label,
  onClick,
  active = false,
  disabled = false,
  shortcutLabel,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  shortcutLabel?: string | null;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="default"
        data-active={active}
        aria-current={active ? "page" : undefined}
        className="group/sidebar-primary-action h-8 gap-2.5 rounded-lg px-2 font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-foreground/82 transition-colors hover:bg-accent/55 hover:text-foreground data-[active=true]:bg-accent/65"
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={onClick}
      >
        <span className="inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground/72">
          <Icon className="size-[15px]" />
        </span>
        <span className="truncate">{label}</span>
        {shortcutLabel ? (
          <ShortcutKbd
            shortcutLabel={shortcutLabel}
            groupClassName="ml-auto opacity-0 transition-opacity group-hover/sidebar-primary-action:opacity-100 group-focus-visible/sidebar-primary-action:opacity-100"
            className="h-4.5 min-w-4.5 px-1 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground/72"
          />
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function SortableProjectItem({
  projectId,
  disabled = false,
  children,
}: {
  projectId: ProjectId;
  disabled?: boolean;
  children: (handleProps: SortableProjectHandleProps) => React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: projectId, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

function SidebarSegmentedPicker({
  activeView,
  onSelectView,
}: {
  activeView: "threads" | "workspace";
  onSelectView: (view: "threads" | "workspace") => void;
}) {
  return (
    <div className="px-3 pb-2.5">
      <div className="inline-flex w-full rounded-md bg-muted/40 p-0.5">
        {(["threads", "workspace"] as const).map((view) => {
          const active = activeView === view;
          return (
            <button
              key={view}
              type="button"
              className={cn(
                "flex-1 rounded-sm px-2.5 py-1 text-[11.5px] font-medium tracking-tight transition-colors",
                active
                  ? "bg-background dark:bg-neutral-800 text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => onSelectView(view)}
            >
              {view === "threads" ? "Threads" : "Workspace"}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SortableWorkspaceItem({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: (handleProps: SortableProjectHandleProps) => React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: workspaceId });

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

export default function Sidebar() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const sidebarThreadSummaryById = useStore((store) => store.sidebarThreadSummaryById);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const markThreadUnread = useStore((store) => store.markThreadUnread);
  const toggleProject = useStore((store) => store.toggleProject);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const setAllProjectsExpanded = useStore((store) => store.setAllProjectsExpanded);
  const collapseProjectsExcept = useStore((store) => store.collapseProjectsExcept);
  const reorderProjects = useStore((store) => store.reorderProjects);
  const renameProjectLocally = useStore((store) => store.renameProjectLocally);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const openChatThreadPage = useTerminalStateStore((state) => state.openChatThreadPage);
  const openTerminalThreadPage = useTerminalStateStore((state) => state.openTerminalThreadPage);
  const clearProjectDraftThreads = useComposerDraftStore((store) => store.clearProjectDraftThreads);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const composerDraftsByThreadId = useComposerDraftStore((store) => store.draftsByThreadId);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const temporaryThreadIds = useTemporaryThreadStore((store) => store.temporaryThreadIds);
  const clearTemporaryThread = useTemporaryThreadStore((store) => store.clearTemporaryThread);
  const pinnedThreadIds = usePinnedThreadsStore((store) => store.pinnedThreadIds);
  const togglePinnedThread = usePinnedThreadsStore((store) => store.togglePinnedThread);
  const unpinThread = usePinnedThreadsStore((store) => store.unpinThread);
  const prunePinnedThreads = usePinnedThreadsStore((store) => store.prunePinnedThreads);
  const workspacePages = useWorkspaceStore((store) => store.workspacePages);
  const createWorkspace = useWorkspaceStore((store) => store.createWorkspace);
  const renameWorkspace = useWorkspaceStore((store) => store.renameWorkspace);
  const deleteWorkspace = useWorkspaceStore((store) => store.deleteWorkspace);
  const reorderWorkspace = useWorkspaceStore((store) => store.reorderWorkspace);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const isOnSettings = useLocation({ select: (loc) => loc.pathname === "/settings" });
  const isOnWorkspace = pathname.startsWith("/workspace");
  const { settings: appSettings, updateSettings } = useAppSettings();
  const { handleNewThread } = useHandleNewThread();
  const { createThreadHandoff } = useThreadHandoff();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const routeWorkspaceId = useParams({
    strict: false,
    select: (params) => (typeof params.workspaceId === "string" ? params.workspaceId : null),
  });
  const routeSearch = useSearch({
    strict: false,
    select: (search) => parseDiffRouteSearch(search),
  });
  const settingsSectionSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const activeSettingsSection = normalizeSettingsSection(settingsSectionSearch.section);
  const activeSplitView = useSplitViewStore(selectSplitView(routeSearch.splitViewId ?? null));
  const splitViewsById = useSplitViewStore((store) => store.splitViewsById);
  const setSplitFocusedPane = useSplitViewStore((store) => store.setFocusedPane);
  const removeSplitView = useSplitViewStore((store) => store.removeSplitView);
  const removeThreadFromSplitViews = useSplitViewStore((store) => store.removeThreadFromSplitViews);
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const { activeProjectId: focusedProjectId } = useFocusedChatContext();
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [showManualPathInput, setShowManualPathInput] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectErrorMeaning = useMemo(
    () => (addProjectError ? describeAddProjectError(addProjectError) : null),
    [addProjectError],
  );
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [renameDialogThreadId, setRenameDialogThreadId] = useState<ThreadId | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<ProjectId | null>(null);
  const [renamingProjectName, setRenamingProjectName] = useState("");
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const [expandedSubagentParentIds, setExpandedSubagentParentIds] = useState<ReadonlySet<ThreadId>>(
    () => new Set(),
  );
  const autoRevealedSubagentThreadIdRef = useRef<ThreadId | null>(null);
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const renamingProjectCommittedRef = useRef(false);
  const renamingProjectInputRef = useRef<HTMLInputElement | null>(null);
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null);
  const [renamingWorkspaceTitle, setRenamingWorkspaceTitle] = useState("");
  const [installingDesktopUpdate, setInstallingDesktopUpdate] = useState(false);
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  // Keep every platform on the same explicit submit path so desktop picker
  // results do not depend on a separate immediate-add branch.
  const shouldShowProjectPathEntry = addingProject;
  const activeSidebarThreadId = activeSplitView?.sourceThreadId ?? routeThreadId;
  const selectSidebarThreads = useMemo(() => createSidebarThreadSummariesSelector(), []);
  const selectSidebarDisplayThreads = useMemo(() => createSidebarDisplayThreadsSelector(), []);
  const sidebarThreads = useStore(selectSidebarThreads);
  const sidebarDisplayThreads = useStore(selectSidebarDisplayThreads);
  const terminalOpen = routeThreadId
    ? selectThreadTerminalState(terminalStateByThreadId, routeThreadId).terminalOpen
    : false;
  const splitViews = useMemo(
    () =>
      Object.values(splitViewsById).filter(
        (splitView): splitView is SplitView => splitView !== undefined,
      ),
    [splitViewsById],
  );
  const pinnedThreadIdSet = useMemo(() => new Set(pinnedThreadIds), [pinnedThreadIds]);
  const pinnedThreads = useMemo(
    () => getPinnedThreadsForSidebar(sidebarDisplayThreads, pinnedThreadIds),
    [pinnedThreadIds, sidebarDisplayThreads],
  );
  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const workspaceRows = useMemo(
    () =>
      workspacePages.map((workspace) => {
        const terminalState = selectThreadTerminalState(
          terminalStateByThreadId,
          workspaceThreadId(workspace.id),
        );
        return {
          ...workspace,
          terminalCount: terminalState.terminalOpen ? terminalState.terminalIds.length : 0,
          terminalStatus: terminalStatusFromThreadState({
            runningTerminalIds: terminalState.runningTerminalIds,
            terminalAttentionStatesById: terminalState.terminalAttentionStatesById,
          }),
          runningTerminalIds: terminalState.runningTerminalIds,
        };
      }),
    [terminalStateByThreadId, workspacePages],
  );
  const threadGitTargets = useMemo(
    () =>
      threads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        cwd: resolveThreadWorkspaceCwd({
          projectCwd: projectCwdById.get(thread.projectId) ?? null,
          envMode: thread.envMode,
          worktreePath: thread.worktreePath,
        }),
      })),
    [projectCwdById, threads],
  );
  const threadGitStatusCwds = useMemo(
    () => [
      ...new Set(
        threadGitTargets
          .filter((target) => target.branch !== null)
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [threadGitTargets],
  );
  const threadGitStatusQueries = useQueries({
    queries: threadGitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions(cwd),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });
  const prByThreadId = useMemo(() => {
    const statusByCwd = new Map<string, GitStatusResult>();
    for (let index = 0; index < threadGitStatusCwds.length; index += 1) {
      const cwd = threadGitStatusCwds[index];
      if (!cwd) continue;
      const status = threadGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status);
      }
    }

    const map = new Map<ThreadId, ThreadPr>();
    for (const target of threadGitTargets) {
      const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [threadGitStatusCwds, threadGitStatusQueries, threadGitTargets]);

  const openPrLink = useCallback((event: React.MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, []);

  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      const latestThread = sortThreadsForSidebar(
        sidebarThreads.filter((thread) => thread.projectId === projectId),
        appSettings.sidebarThreadSortOrder,
      )[0];
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [appSettings.sidebarThreadSortOrder, navigate, sidebarThreads],
  );

  const openExistingProjectLocally = useCallback(
    (projectId: ProjectId) => {
      const hasProjectThread = sidebarThreads.some((thread) => thread.projectId === projectId);
      if (hasProjectThread) {
        focusMostRecentThreadForProject(projectId);
        return;
      }

      setProjectExpanded(projectId, true);
    },
    [focusMostRecentThreadForProject, setProjectExpanded, sidebarThreads],
  );

  const openOrCreateProjectThreadFromSnapshot = useCallback(
    async (projectId: ProjectId, snapshot: OrchestrationReadModel) => {
      const latestThread = sortThreadsForSidebar(
        snapshot.threads
          .filter(
            (thread) =>
              thread.projectId === projectId &&
              thread.deletedAt === null &&
              (thread.archivedAt ?? null) === null,
          )
          .map((thread) => ({
            id: thread.id,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            messages: thread.messages,
          })),
        appSettings.sidebarThreadSortOrder,
      )[0];
      if (latestThread) {
        await navigate({
          to: "/$threadId",
          params: { threadId: latestThread.id },
        });
        return;
      }

      await handleNewThread(projectId, {
        envMode: appSettings.defaultThreadEnvMode,
      }).catch(() => undefined);
    },
    [
      appSettings.defaultThreadEnvMode,
      appSettings.sidebarThreadSortOrder,
      handleNewThread,
      navigate,
    ],
  );

  const openExistingProjectFromSnapshot = useCallback(
    async (projectId: ProjectId, snapshot: OrchestrationReadModel): Promise<boolean> => {
      const existingProject =
        snapshot.projects.find(
          (candidate) => candidate.id === projectId && candidate.deletedAt === null,
        ) ?? null;
      if (!existingProject) {
        return false;
      }

      const latestThread = sortThreadsForSidebar(
        snapshot.threads
          .filter(
            (thread) =>
              thread.projectId === projectId &&
              thread.deletedAt === null &&
              (thread.archivedAt ?? null) === null,
          )
          .map((thread) => ({
            id: thread.id,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            messages: thread.messages,
          })),
        appSettings.sidebarThreadSortOrder,
      )[0];
      if (latestThread) {
        await navigate({
          to: "/$threadId",
          params: { threadId: latestThread.id },
        });
        return true;
      }

      setProjectExpanded(projectId, true);
      return true;
    },
    [appSettings.sidebarThreadSortOrder, navigate, setProjectExpanded],
  );

  // Poll the server read model briefly after project.create so we only recover from fresh state.
  const waitForProjectInSnapshot = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      projectId: ProjectId,
    ): Promise<{
      project: OrchestrationReadModel["projects"][number] | null;
      snapshot: OrchestrationReadModel | null;
    }> => {
      let latestSnapshot: OrchestrationReadModel | null = null;

      for (let attempt = 1; attempt <= ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS; attempt += 1) {
        const snapshot = await api.orchestration.getSnapshot().catch(() => null);
        if (snapshot) {
          latestSnapshot = snapshot;
          const project =
            snapshot.projects.find(
              (candidate) => candidate.id === projectId && candidate.deletedAt === null,
            ) ?? null;
          if (project) {
            return { project, snapshot };
          }
        }

        if (attempt < ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS) {
          await wait(ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS * attempt);
        }
      }

      return {
        project: null,
        snapshot: latestSnapshot,
      };
    },
    [],
  );

  const waitForProjectWorkspaceRootInSnapshot = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      workspaceRoot: string,
    ): Promise<{
      project: OrchestrationReadModel["projects"][number] | null;
      snapshot: OrchestrationReadModel | null;
    }> => {
      let latestSnapshot: OrchestrationReadModel | null = null;

      for (let attempt = 1; attempt <= ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS; attempt += 1) {
        const snapshot = await api.orchestration.getSnapshot().catch(() => null);
        if (snapshot) {
          latestSnapshot = snapshot;
          const project =
            snapshot.projects.find(
              (candidate) =>
                candidate.deletedAt === null &&
                findWorkspaceRootMatch([candidate], workspaceRoot, (item) => item.workspaceRoot) !==
                  undefined,
            ) ?? null;
          if (project) {
            return { project, snapshot };
          }
        }

        if (attempt < ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS) {
          await wait(ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS * attempt);
        }
      }

      return {
        project: null,
        snapshot: latestSnapshot,
      };
    },
    [],
  );

  // Keep add-project recovery on the same fresh-snapshot path for create, duplicate, and existing-project flows.
  const recoverProjectThreadFromServer = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      projectId: ProjectId,
    ): Promise<boolean> => {
      const { project, snapshot } = await waitForProjectInSnapshot(api, projectId);
      if (snapshot) {
        syncServerReadModel(snapshot);
      }
      if (!project || !snapshot) {
        return false;
      }

      await openOrCreateProjectThreadFromSnapshot(project.id, snapshot);
      return true;
    },
    [openOrCreateProjectThreadFromSnapshot, syncServerReadModel, waitForProjectInSnapshot],
  );

  const recoverExistingProjectFromServer = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      projectId: ProjectId,
    ): Promise<boolean> => {
      const { project, snapshot } = await waitForProjectInSnapshot(api, projectId);
      if (snapshot) {
        syncServerReadModel(snapshot);
      }
      if (!project || !snapshot) {
        return false;
      }

      return openExistingProjectFromSnapshot(project.id, snapshot);
    },
    [openExistingProjectFromSnapshot, syncServerReadModel, waitForProjectInSnapshot],
  );

  const recoverExistingProjectByWorkspaceRootFromServer = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      workspaceRoot: string,
    ): Promise<boolean> => {
      const { project, snapshot } = await waitForProjectWorkspaceRootInSnapshot(api, workspaceRoot);
      if (snapshot) {
        syncServerReadModel(snapshot);
      }
      if (!project || !snapshot) {
        return false;
      }

      return openExistingProjectFromSnapshot(project.id, snapshot);
    },
    [openExistingProjectFromSnapshot, syncServerReadModel, waitForProjectWorkspaceRootInSnapshot],
  );

  const handleOpenProjectFromSearch = useCallback(
    (projectId: string) => {
      const typedProjectId = ProjectId.makeUnsafe(projectId);
      const hasProjectThread = sidebarThreads.some((thread) => thread.projectId === typedProjectId);
      if (hasProjectThread) {
        focusMostRecentThreadForProject(typedProjectId);
        return;
      }

      void handleNewThread(typedProjectId, {
        envMode: resolveSidebarNewThreadEnvMode({
          defaultEnvMode: appSettings.defaultThreadEnvMode,
        }),
      });
    },
    [
      appSettings.defaultThreadEnvMode,
      focusMostRecentThreadForProject,
      handleNewThread,
      sidebarThreads,
    ],
  );

  const navigateToWorkspace = useCallback(
    (workspaceId: string, options?: { replace?: boolean }) => {
      void navigate({
        to: "/workspace/$workspaceId",
        params: { workspaceId },
        ...(options?.replace ? { replace: true } : {}),
      });
    },
    [navigate],
  );

  const handleSidebarViewChange = useCallback(
    (view: "threads" | "workspace") => {
      if (view === "workspace") {
        const fallbackWorkspaceId = workspacePages[0]?.id;
        if (!fallbackWorkspaceId) {
          return;
        }
        navigateToWorkspace(routeWorkspaceId ?? fallbackWorkspaceId);
        return;
      }
      void navigate({ to: "/" });
    },
    [navigate, navigateToWorkspace, routeWorkspaceId, workspacePages],
  );

  const handleCreateWorkspace = useCallback(() => {
    const workspaceId = createWorkspace();
    navigateToWorkspace(workspaceId);
  }, [createWorkspace, navigateToWorkspace]);

  const beginWorkspaceRename = useCallback((workspaceId: string, title: string) => {
    setRenamingWorkspaceId(workspaceId);
    setRenamingWorkspaceTitle(title);
  }, []);

  const commitWorkspaceRename = useCallback(() => {
    if (!renamingWorkspaceId) {
      return;
    }
    renameWorkspace(renamingWorkspaceId, renamingWorkspaceTitle);
    setRenamingWorkspaceId(null);
  }, [renameWorkspace, renamingWorkspaceId, renamingWorkspaceTitle]);

  const handleDeleteWorkspace = useCallback(
    async (workspaceId: string) => {
      const workspaceThread = workspaceThreadId(workspaceId);
      const api = readNativeApi();
      const terminalState = selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadId,
        workspaceThread,
      );

      if (api && typeof api.terminal.close === "function") {
        await Promise.allSettled(
          terminalState.terminalIds.map((terminalId) =>
            api.terminal.close({
              threadId: workspaceThread,
              terminalId,
              deleteHistory: true,
            }),
          ),
        );
      }

      clearTerminalState(workspaceThread);
      deleteWorkspace(workspaceId);

      const nextWorkspaceId = useWorkspaceStore.getState().workspacePages[0]?.id ?? null;
      if (routeWorkspaceId === workspaceId && nextWorkspaceId) {
        navigateToWorkspace(nextWorkspaceId, { replace: true });
      }
    },
    [clearTerminalState, deleteWorkspace, navigateToWorkspace, routeWorkspaceId],
  );

  const handleWorkspaceDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }
      const nextIndex = workspacePages.findIndex((workspace) => workspace.id === String(over.id));
      if (nextIndex < 0) {
        return;
      }
      reorderWorkspace(String(active.id), nextIndex);
    },
    [reorderWorkspace, workspacePages],
  );

  const addProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;
      const api = readNativeApi();
      if (!api) return;

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setNewCwd("");
        setAddProjectError(null);
        setAddingProject(false);
      };

      const existing = findWorkspaceRootMatch(projects, cwd, (project) => project.cwd);
      if (existing) {
        finishAddingProject();
        openExistingProjectLocally(existing.id);
        return;
      }

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          createdAt,
        });
        const recovered = await recoverProjectThreadFromServer(api, projectId);
        if (recovered) {
          finishAddingProject();
          return;
        }

        // The command already committed successfully at this point. If the projection
        // snapshot is just slow to catch up, continue with the local new-thread flow
        // instead of surfacing a false-negative sidebar sync error.
        setProjectExpanded(projectId, true);
        await handleNewThread(projectId, {
          envMode: appSettings.defaultThreadEnvMode,
        }).catch(() => undefined);
        finishAddingProject();
        return;
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        if (isDuplicateProjectCreateError(description)) {
          const duplicateProjectId = extractDuplicateProjectCreateProjectId(description);
          const recovered = duplicateProjectId
            ? await recoverExistingProjectFromServer(api, ProjectId.makeUnsafe(duplicateProjectId))
            : await recoverExistingProjectByWorkspaceRootFromServer(api, cwd);
          if (recovered) {
            finishAddingProject();
            return;
          }

          setIsAddingProject(false);
          setAddProjectError(ADD_PROJECT_EXISTING_SYNC_ERROR);
          return;
        }
        setIsAddingProject(false);
        setAddProjectError(description);
        return;
      }
    },
    [
      appSettings.defaultThreadEnvMode,
      handleNewThread,
      isAddingProject,
      openExistingProjectLocally,
      projects,
      recoverExistingProjectFromServer,
      recoverExistingProjectByWorkspaceRootFromServer,
      recoverProjectThreadFromServer,
      setProjectExpanded,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const canAddProject = newCwd.trim().length > 0 && !isAddingProject;

  // Keep the native folder picker and project creation in one awaited flow so
  // the UI can show whether we're still opening the dialog or creating the project.
  const handlePickFolder = useCallback(async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    try {
      const pickedPath = await api.dialogs.pickFolder();
      setIsPickingFolder(false);
      if (pickedPath) {
        setAddProjectError(null);
        await addProjectFromPath(pickedPath);
      }
    } catch (error) {
      const description =
        error instanceof Error ? error.message : "Unable to open the folder picker.";
      setAddProjectError(description);
      toastManager.add({
        type: "error",
        title: "Unable to open folder picker",
        description,
      });
      setIsPickingFolder(false);
    }
  }, [isPickingFolder, addProjectFromPath]);

  const handleStartAddProject = useCallback(() => {
    setAddProjectError(null);
    setShowManualPathInput(false);
    setAddingProject((prev) => !prev);
  }, []);

  const handlePrimaryNewThread = useCallback(() => {
    const activeProjectId =
      (routeThreadId ? threads.find((thread) => thread.id === routeThreadId)?.projectId : null) ??
      projects[0]?.id ??
      null;

    if (activeProjectId) {
      void handleNewThread(activeProjectId, {
        envMode: resolveSidebarNewThreadEnvMode({
          defaultEnvMode: appSettings.defaultThreadEnvMode,
        }),
      });
      return;
    }

    handleStartAddProject();
  }, [
    appSettings.defaultThreadEnvMode,
    handleNewThread,
    handleStartAddProject,
    projects,
    routeThreadId,
    threads,
  ]);

  const cancelRename = useCallback(() => {
    setRenamingThreadId(null);
    renamingInputRef.current = null;
  }, []);

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingThreadId((current) => {
          if (current !== threadId) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
    [],
  );

  /**
   * Delete a single thread: stop session, close terminal, dispatch delete,
   * clean up drafts/state, and optionally remove orphaned worktree.
   * Callers handle thread-level confirmation; this still prompts for worktree removal.
   */
  const deleteThread = useCallback(
    async (
      threadId: ThreadId,
      opts: { deletedThreadIds?: ReadonlySet<ThreadId> } = {},
    ): Promise<void> => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((t) => t.id === threadId);
      if (!thread) return;
      const threadProject = projects.find((project) => project.id === thread.projectId);
      // When bulk-deleting, exclude the other threads being deleted so
      // getOrphanedWorktreePathForThread correctly detects that no surviving
      // threads will reference this worktree.
      const deletedIds = opts.deletedThreadIds;
      const survivingThreads =
        deletedIds && deletedIds.size > 0
          ? threads.filter((t) => t.id === threadId || !deletedIds.has(t.id))
          : threads;
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(survivingThreads, threadId);
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree = orphanedWorktreePath !== null && threadProject !== undefined;
      const shouldDeleteWorktree =
        canDeleteWorktree &&
        (await api.dialogs.confirm(
          [
            "This thread is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
        ));

      if (thread.session && thread.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }

      try {
        await api.terminal.close({ threadId, deleteHistory: true });
      } catch {
        // Terminal may already be closed
      }

      const allDeletedIds = deletedIds ?? new Set<ThreadId>();
      const shouldNavigateToFallback = routeThreadId === threadId;
      const fallbackThreadId = getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: threadId,
        deletedThreadIds: allDeletedIds,
        sortOrder: appSettings.sidebarThreadSortOrder,
      });
      const activeSplitViewId = routeSearch.splitViewId ?? null;
      const deletedPaneInActiveSplit = activeSplitView
        ? resolveSplitViewPaneForThread(activeSplitView, threadId)
        : null;
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId,
      });
      unpinThread(threadId);
      clearComposerDraftForThread(threadId);
      clearProjectDraftThreadById(thread.projectId, thread.id);
      clearTerminalState(threadId);
      removeThreadFromSplitViews(threadId);
      clearTemporaryThread(threadId);

      if (activeSplitViewId && deletedPaneInActiveSplit) {
        const nextActiveSplitView =
          useSplitViewStore.getState().splitViewsById[activeSplitViewId] ?? null;
        const nextFocusedThreadId = nextActiveSplitView
          ? resolveSplitViewFocusedThreadId(nextActiveSplitView)
          : null;
        if (nextActiveSplitView && nextFocusedThreadId) {
          void navigate({
            to: "/$threadId",
            params: { threadId: nextFocusedThreadId },
            replace: true,
            search: () => ({ splitViewId: nextActiveSplitView.id }),
          });
        } else if (shouldNavigateToFallback && fallbackThreadId) {
          void navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        } else if (shouldNavigateToFallback) {
          void navigate({ to: "/", replace: true });
        }
      } else if (shouldNavigateToFallback) {
        if (fallbackThreadId) {
          void navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        } else {
          void navigate({ to: "/", replace: true });
        }
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
        return;
      }

      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: threadProject.cwd,
          path: orphanedWorktreePath,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
        console.error("Failed to remove orphaned worktree after thread deletion", {
          threadId,
          projectCwd: threadProject.cwd,
          worktreePath: orphanedWorktreePath,
          error,
        });
        toastManager.add({
          type: "error",
          title: "Thread deleted, but worktree removal failed",
          description: `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`,
        });
      }
    },
    [
      appSettings.sidebarThreadSortOrder,
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      navigate,
      projects,
      removeWorktreeMutation,
      routeThreadId,
      routeSearch.splitViewId,
      activeSplitView,
      removeThreadFromSplitViews,
      clearTemporaryThread,
      threads,
      unpinThread,
    ],
  );

  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy thread ID",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const handoffThread = useCallback(
    async (thread: (typeof threads)[number]) => {
      try {
        await createThreadHandoff(thread);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not create handoff thread",
          description:
            error instanceof Error
              ? error.message
              : "An error occurred while creating the handoff thread.",
        });
      }
    },
    [createThreadHandoff],
  );
  const confirmAndDeleteThread = useCallback(
    async (threadId: ThreadId) => {
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (!thread) return;

      if (appSettings.confirmThreadDelete) {
        const api = readNativeApi();
        const confirmationMessage = [
          `Delete thread "${thread.title}"?`,
          "This permanently clears conversation history for this thread.",
        ].join("\n");
        const confirmed = api
          ? await api.dialogs.confirm(confirmationMessage)
          : await showConfirmDialogFallback(confirmationMessage);
        if (!confirmed) return;
      }

      await deleteThread(threadId);
    },
    [appSettings.confirmThreadDelete, deleteThread, threads],
  );
  const handleThreadContextMenu = useCallback(
    async (
      threadId: ThreadId,
      position: { x: number; y: number },
      options?: {
        extraItems?: Array<{
          id: "return-to-single-chat";
          label: string;
        }>;
        onExtraAction?: (itemId: "return-to-single-chat") => Promise<void> | void;
      },
    ) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((t) => t.id === threadId);
      if (!thread) return;
      const threadSummary = sidebarThreadSummaryById[threadId];
      const isPinned = pinnedThreadIdSet.has(threadId);
      const hasPendingApprovals =
        threadSummary?.hasPendingApprovals ?? derivePendingApprovals(thread.activities).length > 0;
      const hasPendingUserInput =
        threadSummary?.hasPendingUserInput ?? derivePendingUserInputs(thread.activities).length > 0;
      const canHandoff = canCreateThreadHandoff({
        thread,
        hasPendingApprovals,
        hasPendingUserInput,
      });
      const handoffLabel = canHandoff
        ? `Handoff to ${PROVIDER_DISPLAY_NAMES[resolveHandoffTargetProvider(thread.modelSelection.provider)]}`
        : null;
      const threadWorkspacePath = resolveThreadWorkspaceCwd({
        projectCwd: projectCwdById.get(thread.projectId) ?? null,
        envMode: thread.envMode,
        worktreePath: thread.worktreePath,
      });
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          { id: "toggle-pin", label: isPinned ? "Unpin thread" : "Pin thread" },
          { id: "mark-unread", label: "Mark unread" },
          ...(handoffLabel ? [{ id: "handoff", label: handoffLabel }] : []),
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          ...(options?.extraItems ?? []),
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "rename") {
        setRenamingThreadId(threadId);
        setRenamingTitle(thread.title);
        renamingCommittedRef.current = false;
        return;
      }
      if (clicked === "toggle-pin") {
        togglePinnedThread(threadId);
        return;
      }

      if (clicked === "mark-unread") {
        markThreadUnread(threadId);
        return;
      }
      if (clicked === "handoff") {
        await handoffThread(thread);
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add({
            type: "error",
            title: "Path unavailable",
            description: "This thread does not have a workspace path to copy.",
          });
          return;
        }
        copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(threadId, { threadId });
        return;
      }
      if (clicked === "return-to-single-chat") {
        await options?.onExtraAction?.("return-to-single-chat");
        return;
      }
      if (clicked !== "delete") return;
      await confirmAndDeleteThread(threadId);
    },
    [
      confirmAndDeleteThread,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      handoffThread,
      markThreadUnread,
      pinnedThreadIdSet,
      projectCwdById,
      sidebarThreadSummaryById,
      togglePinnedThread,
      threads,
    ],
  );
  const returnSplitViewToSingleChat = useCallback(
    (splitView: SplitView, pane: SplitViewPane) => {
      const nextThreadId =
        (pane === "left" ? splitView.leftThreadId : splitView.rightThreadId) ??
        splitView.leftThreadId ??
        splitView.rightThreadId;
      removeSplitView(splitView.id);
      if (!nextThreadId) {
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
        search: (previous) => ({
          ...previous,
          splitViewId: undefined,
        }),
      });
    },
    [navigate, removeSplitView],
  );
  const handleSplitContextMenu = useCallback(
    async (splitView: SplitView, pane: SplitViewPane, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;

      const paneThreadId = pane === "left" ? splitView.leftThreadId : splitView.rightThreadId;
      setSplitFocusedPane(splitView.id, pane);

      if (paneThreadId) {
        await handleThreadContextMenu(paneThreadId, position, {
          extraItems: [{ id: "return-to-single-chat", label: "Return to single chat" }],
          onExtraAction: async () => {
            returnSplitViewToSingleChat(splitView, pane);
          },
        });
        return;
      }

      const clicked = await api.contextMenu.show(
        [{ id: "return-to-single-chat", label: "Return to single chat" }],
        position,
      );
      if (clicked === "return-to-single-chat") {
        returnSplitViewToSingleChat(splitView, pane);
      }
    },
    [handleThreadContextMenu, returnSplitViewToSingleChat, setSplitFocusedPane],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const ids = [...selectedThreadIds];
      if (ids.length === 0) return;
      const count = ids.length;

      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const id of ids) {
          markThreadUnread(id);
        }
        clearSelection();
        return;
      }

      if (clicked !== "delete") return;

      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} thread${count === 1 ? "" : "s"}?`,
            "This permanently clears conversation history for these threads.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      const deletedIds = new Set<ThreadId>(ids);
      for (const id of ids) {
        await deleteThread(id, { deletedThreadIds: deletedIds });
      }
      removeFromSelection(ids);
    },
    [
      appSettings.confirmThreadDelete,
      clearSelection,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      selectedThreadIds,
    ],
  );

  // Keep clicks, keyboard activation, and Alt+Tab cycling aligned on the same thread-open path.
  const navigateToSplitView = useCallback(
    (splitView: SplitView, nextThreadId?: ThreadId | null) => {
      const focusedThreadId = nextThreadId ?? resolveSplitViewFocusedThreadId(splitView);
      if (!focusedThreadId) return;
      void navigate({
        to: "/$threadId",
        params: { threadId: focusedThreadId },
        search: () => ({ splitViewId: splitView.id }),
      });
    },
    [navigate],
  );

  const activateSplitPane = useCallback(
    (splitView: SplitView, pane: "left" | "right") => {
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }

      const paneThreadId = pane === "left" ? splitView.leftThreadId : splitView.rightThreadId;
      const nextThreadId = paneThreadId ?? splitView.leftThreadId ?? splitView.rightThreadId;

      setSelectionAnchor(paneThreadId ?? splitView.sourceThreadId);
      setSplitFocusedPane(splitView.id, pane);

      if (!nextThreadId) {
        return;
      }

      void navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
        search: () => ({ splitViewId: splitView.id }),
      });
    },
    [clearSelection, navigate, selectedThreadIds.size, setSelectionAnchor, setSplitFocusedPane],
  );

  const activateThread = useCallback(
    (threadId: ThreadId) => {
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      const sourceSplitView = splitViews.find((splitView) => splitView.sourceThreadId === threadId);
      if (sourceSplitView) {
        navigateToSplitView(sourceSplitView);
        return;
      }

      const threadEntryPoint = selectThreadTerminalState(
        terminalStateByThreadId,
        threadId,
      ).entryPoint;
      if (threadEntryPoint === "terminal") {
        openTerminalThreadPage(threadId);
      } else {
        openChatThreadPage(threadId);
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [
      clearSelection,
      navigate,
      navigateToSplitView,
      openChatThreadPage,
      openTerminalThreadPage,
      selectedThreadIds.size,
      setSelectionAnchor,
      splitViews,
      terminalStateByThreadId,
    ],
  );

  const handleProjectContextMenu = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;
      const clicked = await showContextMenuFallback(
        [
          {
            id: "open-in-finder",
            label: "Open in Finder",
            icon: PROJECT_CONTEXT_MENU_FOLDER_ICON,
          },
          {
            id: "copy-path",
            label: "Copy Path",
            icon: PROJECT_CONTEXT_MENU_COPY_PATH_ICON,
          },
          {
            id: "rename",
            label: "Edit name",
            icon: PROJECT_CONTEXT_MENU_EDIT_ICON,
          },
          {
            id: "delete",
            label: "Remove",
            destructive: true,
            icon: PROJECT_CONTEXT_MENU_REMOVE_ICON,
          },
        ],
        position,
      );

      if (clicked === "open-in-finder") {
        try {
          await api.shell.showInFolder(project.cwd);
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Unable to open in Finder",
            description:
              error instanceof Error
                ? error.message
                : "An unknown error occurred opening the folder.",
          });
        }
        return;
      }
      if (clicked === "copy-path") {
        copyPathToClipboard(project.cwd, { path: project.cwd });
        return;
      }
      if (clicked === "rename") {
        renamingProjectCommittedRef.current = false;
        setRenamingProjectId(projectId);
        setRenamingProjectName(project.localName ?? project.name);
        return;
      }
      if (clicked !== "delete") return;

      const projectThreads = threads.filter((thread) => thread.projectId === projectId);
      if (projectThreads.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Project is not empty",
          description: "Delete all threads in this project before removing it.",
        });
        return;
      }

      const confirmed = await api.dialogs.confirm(`Remove project "${project.name}"?`);
      if (!confirmed) return;

      try {
        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: newCommandId(),
          projectId,
        });
        clearProjectDraftThreads(projectId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing project.";
        console.error("Failed to remove project", { projectId, error });
        toastManager.add({
          type: "error",
          title: `Failed to remove "${project.name}"`,
          description: message,
        });
      }
    },
    [clearProjectDraftThreads, copyPathToClipboard, projects, threads],
  );

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        dragInProgressRef.current = false;
        return;
      }
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = projects.find((project) => project.id === active.id);
      const overProject = projects.find((project) => project.id === over.id);
      if (!activeProject || !overProject) return;
      reorderProjects(activeProject.id, overProject.id);
    },
    [appSettings.sidebarProjectSortOrder, projects, reorderProjects],
  );

  const handleProjectDragStart = useCallback(
    (_event: DragStartEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        return;
      }
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [appSettings.sidebarProjectSortOrder],
  );

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const animatedProjectListsRef = useRef(new WeakSet<HTMLElement>());
  const attachProjectListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedProjectListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedProjectListsRef.current.add(node);
  }, []);

  const animatedThreadListsRef = useRef(new WeakSet<HTMLElement>());
  const attachThreadListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedThreadListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedThreadListsRef.current.add(node);
  }, []);
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread] as const)),
    [threads],
  );
  const splitViewBySourceThreadId = useMemo(
    () => new Map(splitViews.map((splitView) => [splitView.sourceThreadId, splitView] as const)),
    [splitViews],
  );
  const resolveSplitPreview = useCallback(
    (threadId: ThreadId | null): SidebarSplitPreview => {
      const thread = threadId ? (threadById.get(threadId) ?? null) : null;
      const draftProvider =
        threadId && composerDraftsByThreadId[threadId]?.activeProvider
          ? composerDraftsByThreadId[threadId].activeProvider
          : null;
      return {
        threadId,
        title: resolveSplitPreviewTitle({
          thread,
          draftPrompt: threadId ? (composerDraftsByThreadId[threadId]?.prompt ?? null) : null,
        }),
        provider: thread?.modelSelection.provider ?? draftProvider ?? "codex",
      };
    },
    [composerDraftsByThreadId, threadById],
  );

  const handleProjectTitlePointerDownCapture = useCallback(() => {
    suppressProjectClickAfterDragRef.current = false;
  }, []);

  const cancelProjectRename = useCallback(() => {
    renamingProjectCommittedRef.current = false;
    setRenamingProjectId(null);
    renamingProjectInputRef.current = null;
  }, []);

  const commitProjectRename = useCallback(
    (projectId: ProjectId, nextName: string, previousLocalName: string | null) => {
      const trimmed = nextName.trim();
      const normalizedPrevious = previousLocalName?.trim() ?? "";
      if (trimmed === normalizedPrevious) {
        cancelProjectRename();
        return;
      }
      renameProjectLocally(projectId, trimmed.length > 0 ? trimmed : null);
      cancelProjectRename();
    },
    [cancelProjectRename, renameProjectLocally],
  );

  const sortedProjects = useMemo(
    () => sortProjectsForSidebar(projects, sidebarThreads, appSettings.sidebarProjectSortOrder),
    [appSettings.sidebarProjectSortOrder, projects, sidebarThreads],
  );
  const allProjectsExpanded = useMemo(
    () => projects.length > 0 && projects.every((project) => project.expanded),
    [projects],
  );

  useEffect(() => {
    if (!shouldPrunePinnedThreads({ threadsHydrated })) {
      return;
    }
    prunePinnedThreads(sidebarThreads.map((thread) => thread.id));
  }, [prunePinnedThreads, sidebarThreads, threadsHydrated]);

  useEffect(() => {
    if (!activeSidebarThreadId) {
      autoRevealedSubagentThreadIdRef.current = null;
      return;
    }
    if (autoRevealedSubagentThreadIdRef.current === activeSidebarThreadId) {
      return;
    }

    const forcedExpandedParentIds = new Set<ThreadId>();
    let currentThreadId: ThreadId | null =
      threadById.get(activeSidebarThreadId)?.parentThreadId ??
      sidebarThreadSummaryById[activeSidebarThreadId]?.parentThreadId ??
      null;

    while (currentThreadId) {
      forcedExpandedParentIds.add(currentThreadId);
      currentThreadId =
        threadById.get(currentThreadId)?.parentThreadId ??
        sidebarThreadSummaryById[currentThreadId]?.parentThreadId ??
        null;
    }

    autoRevealedSubagentThreadIdRef.current = activeSidebarThreadId;

    if (forcedExpandedParentIds.size === 0) {
      return;
    }

    setExpandedSubagentParentIds((previous) => {
      const next = new Set(previous);
      let changed = false;
      for (const parentThreadId of forcedExpandedParentIds) {
        if (next.has(parentThreadId)) continue;
        next.add(parentThreadId);
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [activeSidebarThreadId, sidebarThreadSummaryById, threadById]);

  const toggleSubagentParent = useCallback((threadId: ThreadId) => {
    setExpandedSubagentParentIds((previous) => {
      const next = new Set(previous);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  }, []);

  const handleThreadClick = useCallback(
    (
      event: MouseEvent,
      threadId: ThreadId,
      orderedProjectThreadIds: readonly ThreadId[],
      options?: {
        isActive?: boolean;
        canToggleSubagents?: boolean;
      },
    ) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadId);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadId, orderedProjectThreadIds);
        return;
      }

      if (options?.isActive && options.canToggleSubagents) {
        toggleSubagentParent(threadId);
        return;
      }

      activateThread(threadId);
    },
    [activateThread, rangeSelectTo, toggleSubagentParent, toggleThreadSelection],
  );

  const visibleSidebarThreadIds = useMemo(() => {
    const visibleThreadIds = pinnedThreads.map((thread) => thread.id);

    for (const project of sortedProjects) {
      const projectThreads = sortThreadsForSidebar(
        getUnpinnedThreadsForSidebar(
          sidebarDisplayThreads.filter((thread) => thread.projectId === project.id),
          pinnedThreadIds,
        ),
        appSettings.sidebarThreadSortOrder,
      );
      const projectThreadTree = buildProjectThreadTree({
        threads: projectThreads,
        expandedParentThreadIds: expandedSubagentParentIds,
      });
      const projectSplitViews = splitViews.filter(
        (splitView) =>
          splitView.ownerProjectId === project.id &&
          !pinnedThreadIdSet.has(splitView.sourceThreadId),
      );
      const replacedThreadIds = new Set(
        projectSplitViews.map((splitView) => splitView.sourceThreadId),
      );
      const orderedEntries = projectThreadTree.map((row) => ({
        rowId: splitViewBySourceThreadId.get(row.thread.id)?.sourceThreadId ?? row.thread.id,
        rootRowId: row.rootThreadId,
      }));
      for (const splitView of projectSplitViews) {
        if (
          replacedThreadIds.has(splitView.sourceThreadId) &&
          orderedEntries.some((entry) => entry.rowId === splitView.sourceThreadId)
        ) {
          continue;
        }
        if (!orderedEntries.some((entry) => entry.rowId === splitView.sourceThreadId)) {
          orderedEntries.push({
            rowId: splitView.sourceThreadId,
            rootRowId: splitView.sourceThreadId,
          });
        }
      }

      const { visibleEntries } = getVisibleSidebarEntriesForPreview({
        entries: orderedEntries,
        activeEntryId: activeSidebarThreadId ?? undefined,
        isExpanded: expandedThreadListsByProject.has(project.id),
        previewLimit: THREAD_PREVIEW_LIMIT,
      });
      const activeEntryId =
        activeSidebarThreadId &&
        orderedEntries.some((entry) => entry.rowId === activeSidebarThreadId)
          ? activeSidebarThreadId
          : null;
      if (!project.expanded) {
        if (activeEntryId) {
          visibleThreadIds.push(activeEntryId);
        }
        continue;
      }

      visibleThreadIds.push(...visibleEntries.map((entry) => entry.rowId));
    }

    return visibleThreadIds;
  }, [
    activeSidebarThreadId,
    appSettings.sidebarThreadSortOrder,
    expandedSubagentParentIds,
    expandedThreadListsByProject,
    pinnedThreadIdSet,
    pinnedThreadIds,
    pinnedThreads,
    sidebarDisplayThreads,
    splitViewBySourceThreadId,
    splitViews,
    sortedProjects,
  ]);
  const isManualProjectSorting = appSettings.sidebarProjectSortOrder === "manual";

  // Pinned rows should show the user-facing project label, not the raw folder basename.
  function resolvePinnedThreadProjectLabel(projectId: ProjectId): string | null {
    const project = projectById.get(projectId);
    if (!project) return null;
    return project.name ?? project.folderName ?? null;
  }

  // Keep hover actions in the same trailing slot used by the timestamp they replace.
  function renderThreadDeleteButton(
    threadId: ThreadId,
    toneClassName: string,
    options?: {
      compact?: boolean;
    },
  ) {
    const compact = options?.compact === true;
    return (
      <button
        type="button"
        aria-label="Delete thread"
        title="Delete thread"
        className={cn(
          "sidebar-icon-button pointer-events-none absolute inset-y-0 right-0 my-auto inline-flex justify-center opacity-0 transition-[opacity,color] hover:text-foreground/82",
          compact ? "size-[18px]" : "size-5",
          "group-hover/thread-row:pointer-events-auto group-hover/thread-row:opacity-100 group-focus-within/thread-row:pointer-events-auto group-focus-within/thread-row:opacity-100",
          toneClassName,
        )}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void confirmAndDeleteThread(threadId);
        }}
      >
        <Trash2 className={cn("shrink-0", compact ? "size-[11px]" : "size-3")} />
      </button>
    );
  }

  function renderPinnedThreadRow(thread: SidebarThreadSummary) {
    const threadEntryPoint = selectThreadTerminalState(
      terminalStateByThreadId,
      thread.id,
    ).entryPoint;
    const isActive = !activeSplitView && routeThreadId === thread.id;
    const projectLabel = resolvePinnedThreadProjectLabel(thread.projectId);
    const rightMetaBadge = resolveThreadRowMetaBadge({
      thread,
      includeHandoffBadge: true,
    });
    const isSubagentThread = Boolean(thread.parentThreadId);
    const pinnedTimestampClassName = isSubagentThread
      ? "w-[1.2rem] text-right text-[10px] leading-none tabular-nums text-muted-foreground/26 transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0"
      : "w-[1.625rem] text-right text-[length:var(--app-font-size-ui-meta,11px)] leading-none tabular-nums text-muted-foreground/38 transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0";

    return (
      <div key={thread.id} className="group/thread-row relative w-full">
        <button
          type="button"
          data-thread-item
          className={cn(
            "relative flex h-8 w-full items-center gap-2 rounded-md px-2 pr-9 text-left text-[length:var(--app-font-size-ui,12px)] transition-colors",
            isActive
              ? "bg-accent/62 text-foreground/90 dark:bg-accent/42"
              : "text-foreground/72 hover:bg-accent/40 hover:text-foreground/90",
          )}
          onClick={() => activateThread(thread.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            void handleThreadContextMenu(thread.id, {
              x: event.clientX,
              y: event.clientY,
            });
          }}
        >
          <ThreadPinToggleButton
            pinned
            presentation="inline"
            toneClassName="text-muted-foreground/50"
            onToggle={(event) => {
              event.preventDefault();
              event.stopPropagation();
              togglePinnedThread(thread.id);
            }}
          />
          {threadEntryPoint === "terminal" ? (
            <TerminalIcon aria-hidden="true" className="size-3.5 shrink-0 text-teal-600/85" />
          ) : (
            <ProviderGlyph
              provider={thread.modelSelection.provider}
              className="size-3.5 shrink-0"
            />
          )}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className="min-w-0 flex-1 truncate"
                    data-testid={`thread-title-${thread.id}`}
                  >
                    {isSubagentThread
                      ? renderSubagentLabel({
                          threadId: thread.id,
                          parentThreadId: thread.parentThreadId,
                          agentId: thread.subagentAgentId,
                          nickname: thread.subagentNickname,
                          role: thread.subagentRole,
                          title: thread.title,
                          threads,
                        })
                      : thread.title}
                  </span>
                }
              />
              <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
                {thread.title}
              </TooltipPopup>
            </Tooltip>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5 pr-1">
            {projectLabel ? (
              <span className="max-w-24 truncate text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/38">
                {projectLabel}
              </span>
            ) : null}
          </div>
          <div
            className={cn(
              "absolute top-1/2 flex -translate-y-1/2 items-center",
              isSubagentThread ? "right-2" : "right-2.5",
            )}
          >
            <div className="relative flex shrink-0 items-center justify-end gap-1">
              <ThreadRowMetaBadge tooltip={rightMetaBadge?.tooltip ?? null}>
                {rightMetaBadge?.icon}
              </ThreadRowMetaBadge>
              <span className={pinnedTimestampClassName}>
                {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
              </span>
              {renderThreadDeleteButton(thread.id, "text-muted-foreground/42", {
                compact: isSubagentThread,
              })}
            </div>
          </div>
        </button>
      </div>
    );
  }

  function renderThreadRow(
    thread: SidebarThreadSummary,
    orderedProjectThreadIds: readonly ThreadId[],
    depth = 0,
    childCount = 0,
    isExpanded = false,
  ) {
    const threadTerminalState = selectThreadTerminalState(terminalStateByThreadId, thread.id);
    const threadEntryPoint = threadTerminalState.entryPoint;
    const isActive = !activeSplitView && routeThreadId === thread.id;
    const isPinned = pinnedThreadIdSet.has(thread.id);
    const isSelected = selectedThreadIds.has(thread.id);
    const isHighlighted = isActive || isSelected;
    const threadStatus = resolveThreadStatusPill({
      thread,
      hasPendingApprovals: thread.hasPendingApprovals,
      hasPendingUserInput: thread.hasPendingUserInput,
    });
    const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(thread);
    const prStatus = prStatusIndicator(prByThreadId.get(thread.id) ?? null);
    const terminalStatus = terminalStatusFromThreadState({
      runningTerminalIds: threadTerminalState.runningTerminalIds,
      terminalAttentionStatesById: threadTerminalState.terminalAttentionStatesById,
    });
    const terminalCount = threadTerminalState.terminalIds.length;
    const isDisposableThread =
      temporaryThreadIds[thread.id] === true ||
      draftThreadsByThreadId[thread.id]?.isTemporary === true;
    const secondaryMetaClass = isHighlighted
      ? "text-foreground/54 dark:text-foreground/64"
      : "text-muted-foreground/34";
    const rightMetaBadge = resolveThreadRowMetaBadge({
      thread,
      includeHandoffBadge: !isDisposableThread,
    });
    const isSubagentThread = Boolean(thread.parentThreadId);
    const leadingPrStatus = isSubagentThread || thread.forkSourceThreadId ? null : prStatus;
    const subagentPresentation = isSubagentThread
      ? resolveSubagentPresentationForThread({
          thread: {
            id: thread.id,
            parentThreadId: thread.parentThreadId,
            subagentAgentId: thread.subagentAgentId,
            subagentNickname: thread.subagentNickname,
            subagentRole: thread.subagentRole,
            title: thread.title,
          },
          threads,
        })
      : null;
    const canToggleSubagents = childCount > 0;
    const subagentIndentPx = Math.max(0, Math.min(depth - 1, 3) * 10);
    const showCompactMeta = !isSubagentThread;
    const childCountLabel = `${childCount} subagent${childCount === 1 ? "" : "s"}`;
    const trailingTimestampClassName = isSubagentThread
      ? cn(
          "w-[1.2rem] text-right text-[10px] leading-none tabular-nums tracking-[-0.01em] transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
          isHighlighted ? "text-foreground/38 dark:text-foreground/46" : "text-muted-foreground/24",
        )
      : cn(
          "w-[1.625rem] text-right text-[length:var(--app-font-size-ui-meta,11px)] leading-none tabular-nums transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
          secondaryMetaClass,
        );
    const toggleButtonClassName = isHighlighted
      ? "border-foreground/10 bg-background/75 text-foreground/58 hover:bg-background/88 hover:text-foreground/80"
      : "border-border/45 bg-background/58 text-muted-foreground/56 hover:border-border/75 hover:bg-background/78 hover:text-foreground/76";

    return (
      <SidebarMenuSubItem key={thread.id} className="group/thread-row w-full" data-thread-item>
        <ThreadPinToggleButton
          pinned={isPinned}
          presentation="overlay"
          toneClassName={secondaryMetaClass}
          onToggle={(event) => {
            event.preventDefault();
            event.stopPropagation();
            togglePinnedThread(thread.id);
          }}
        />
        {threadStatus &&
          (threadStatus.label === "Completed" ? (
            <HiOutlineCheckCircle
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute left-2 top-1/2 z-10 size-4 -translate-y-1/2 transition-opacity",
                threadStatus.colorClass,
                isPinned
                  ? "opacity-0"
                  : "opacity-100 group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
              )}
            />
          ) : threadStatus.pulse ? (
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute left-2.5 top-1/2 z-10 size-3 -translate-y-1/2 animate-spin rounded-full text-muted-foreground/55 transition-opacity [animation-duration:1.3s]",
                isPinned
                  ? "opacity-0"
                  : "opacity-100 group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
              )}
              style={{
                background: "conic-gradient(from 0deg, transparent 25%, currentColor)",
                mask: "radial-gradient(farthest-side, transparent calc(100% - 1.5px), black calc(100% - 1.5px))",
                WebkitMask:
                  "radial-gradient(farthest-side, transparent calc(100% - 1.5px), black calc(100% - 1.5px))",
              }}
            />
          ) : (
            <span
              className={cn(
                "pointer-events-none absolute left-3 top-1/2 z-10 h-1.5 w-1.5 -translate-y-1/2 rounded-full transition-opacity",
                threadStatus.dotClass,
                isPinned
                  ? "opacity-0"
                  : "opacity-100 group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
              )}
            />
          ))}
        <SidebarMenuSubButton
          render={<div role="button" tabIndex={0} />}
          data-thread-entry-point={threadEntryPoint}
          size="sm"
          isActive={isActive}
          className={cn(
            resolveThreadRowClassName({
              isActive,
              isSelected,
            }),
            isSubagentThread ? "h-7 pr-7.5" : undefined,
          )}
          onClick={(event) =>
            handleThreadClick(event, thread.id, orderedProjectThreadIds, {
              isActive,
              canToggleSubagents,
            })
          }
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setRenameDialogThreadId(thread.id);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            activateThread(thread.id);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            if (selectedThreadIds.size > 0 && selectedThreadIds.has(thread.id)) {
              void handleMultiSelectContextMenu({
                x: event.clientX,
                y: event.clientY,
              });
            } else {
              if (selectedThreadIds.size > 0) {
                clearSelection();
              }
              void handleThreadContextMenu(thread.id, {
                x: event.clientX,
                y: event.clientY,
              });
            }
          }}
        >
          {isSubagentThread ? (
            <span
              aria-hidden="true"
              className="relative inline-flex h-3.5 w-[18px] shrink-0 items-center"
              style={{ marginLeft: `${subagentIndentPx}px` }}
            >
              <span className="absolute left-1.5 top-0 bottom-0 w-px rounded-full bg-border/35" />
              <span className="absolute left-1.5 top-1/2 h-px w-2.5 -translate-y-1/2 bg-border/35" />
              <span
                className="absolute left-1.5 top-1/2 size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{ backgroundColor: subagentPresentation?.accentColor }}
              />
            </span>
          ) : threadEntryPoint === "terminal" ? (
            <TerminalIcon aria-hidden="true" className="size-3.5 shrink-0 text-teal-600/85" />
          ) : handoffBadgeLabel && thread.handoff ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex shrink-0 items-center">
                    <HandoffProviderGlyph
                      sourceProvider={thread.handoff.sourceProvider}
                      targetProvider={thread.modelSelection.provider}
                    />
                  </span>
                }
              />
              <TooltipPopup side="top">{handoffBadgeLabel}</TooltipPopup>
            </Tooltip>
          ) : (
            <ProviderGlyph
              provider={thread.modelSelection.provider}
              className="size-3.5 shrink-0"
            />
          )}
          <div
            className={cn(
              "flex min-w-0 flex-1 items-center text-left",
              isSubagentThread ? "gap-[5px]" : "gap-1.5",
            )}
          >
            {leadingPrStatus && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={leadingPrStatus.tooltip}
                      className={`inline-flex items-center justify-center ${leadingPrStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                      onClick={(event) => {
                        openPrLink(event, leadingPrStatus.url);
                      }}
                    >
                      <GitPullRequestIcon className="size-3" />
                    </button>
                  }
                />
                <TooltipPopup side="top">{leadingPrStatus.tooltip}</TooltipPopup>
              </Tooltip>
            )}
            {renamingThreadId === thread.id ? (
              <input
                ref={(el) => {
                  if (el && renamingInputRef.current !== el) {
                    renamingInputRef.current = el;
                    el.focus();
                    el.select();
                  }
                }}
                className="min-w-0 flex-1 truncate rounded-md border border-ring bg-transparent px-1.5 py-0.5 text-[length:var(--app-font-size-ui,12px)] outline-none"
                value={renamingTitle}
                onChange={(e) => setRenamingTitle(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    renamingCommittedRef.current = true;
                    void commitRename(thread.id, renamingTitle, thread.title);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    renamingCommittedRef.current = true;
                    cancelRename();
                  }
                }}
                onBlur={() => {
                  if (!renamingCommittedRef.current) {
                    void commitRename(thread.id, renamingTitle, thread.title);
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] text-foreground/86",
                  isSubagentThread ? "leading-[18px] text-foreground/80" : "leading-5",
                )}
              >
                {isSubagentThread
                  ? renderSubagentLabel({
                      threadId: thread.id,
                      parentThreadId: thread.parentThreadId,
                      agentId: thread.subagentAgentId,
                      nickname: thread.subagentNickname,
                      role: thread.subagentRole,
                      title: thread.title,
                      threads,
                      roleClassName: "text-muted-foreground/42",
                    })
                  : thread.title}
              </span>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5 pr-1">
            {canToggleSubagents ? (
              <button
                type="button"
                data-thread-selection-safe
                aria-label={`${isExpanded ? "Collapse" : "Expand"} ${childCountLabel}`}
                title={childCountLabel}
                className={cn(
                  "inline-flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full border px-[5px] transition-colors",
                  toggleButtonClassName,
                )}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleSubagentParent(thread.id);
                }}
              >
                <span className="text-[9px] font-medium leading-none tabular-nums">
                  {childCount}
                </span>
                {isExpanded ? (
                  <ChevronDownIcon className="size-3" />
                ) : (
                  <ChevronRightIcon className="size-3" />
                )}
              </button>
            ) : null}
            {showCompactMeta && terminalCount > 1 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      className={`inline-flex items-center gap-0.5 ${
                        terminalStatus ? terminalStatus.colorClass : "text-muted-foreground/55"
                      }`}
                    >
                      <span className="text-[length:var(--app-font-size-ui-2xs,9px)] leading-none">
                        {terminalCount}
                      </span>
                      <TerminalIcon
                        className={`size-3 ${terminalStatus?.pulse ? "animate-pulse" : ""}`}
                      />
                    </span>
                  }
                />
                <TooltipPopup side="top">
                  {terminalCount} terminal{terminalCount === 1 ? "" : "s"} open
                </TooltipPopup>
              </Tooltip>
            ) : showCompactMeta && terminalStatus ? (
              <span
                role="img"
                aria-label={terminalStatus.label}
                title={terminalStatus.label}
                className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
              >
                <TerminalIcon className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`} />
              </span>
            ) : null}
            {showCompactMeta && isDisposableThread ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex shrink-0 items-center text-muted-foreground/55">
                      <LuMessageSquareDashed className="size-3" />
                    </span>
                  }
                />
                <TooltipPopup side="top">Disposable chat</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
          <div
            className={cn(
              "absolute top-1/2 flex -translate-y-1/2 items-center",
              isSubagentThread ? "right-2" : "right-2.5",
            )}
          >
            <div className="relative flex shrink-0 items-center justify-end gap-1">
              {showCompactMeta ? (
                <ThreadRowMetaBadge tooltip={rightMetaBadge?.tooltip ?? null}>
                  {rightMetaBadge?.icon}
                </ThreadRowMetaBadge>
              ) : null}
              <span className={trailingTimestampClassName}>
                {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
              </span>
              {renderThreadDeleteButton(thread.id, secondaryMetaClass, {
                compact: isSubagentThread,
              })}
            </div>
          </div>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    );
  }

  function renderProjectItem(
    project: (typeof sortedProjects)[number],
    dragHandleProps: SortableProjectHandleProps | null,
  ) {
    const isRenamingProject = renamingProjectId === project.id;
    const allProjectThreads = sortThreadsForSidebar(
      sidebarDisplayThreads.filter((thread) => thread.projectId === project.id),
      appSettings.sidebarThreadSortOrder,
    );
    const projectThreads = getUnpinnedThreadsForSidebar(allProjectThreads, pinnedThreadIds);
    const activeThreadId = activeSidebarThreadId ?? undefined;
    const projectThreadTree = buildProjectThreadTree({
      threads: projectThreads,
      expandedParentThreadIds: expandedSubagentParentIds,
    });
    const projectSplitViews = splitViews.filter(
      (splitView) =>
        splitView.ownerProjectId === project.id && !pinnedThreadIdSet.has(splitView.sourceThreadId),
    );
    const projectStatus = resolveProjectStatusIndicator(
      allProjectThreads.map((thread) =>
        resolveThreadStatusPill({
          thread,
          hasPendingApprovals: thread.hasPendingApprovals,
          hasPendingUserInput: thread.hasPendingUserInput,
        }),
      ),
    );
    const isThreadListExpanded = expandedThreadListsByProject.has(project.id);
    const replacedThreadIds = new Set(
      projectSplitViews.map((splitView) => splitView.sourceThreadId),
    );
    const orderedEntries: SidebarProjectEntry[] = projectThreadTree.map(
      ({ thread, depth, rootThreadId, childCount, isExpanded }) => {
        const splitView = splitViewBySourceThreadId.get(thread.id);
        if (!splitView) {
          return {
            kind: "thread",
            rowId: thread.id,
            rootRowId: rootThreadId,
            thread,
            depth,
            childCount,
            isExpanded,
          };
        }
        return {
          kind: "split",
          rowId: splitView.sourceThreadId,
          rootRowId: rootThreadId,
          splitView,
        };
      },
    );
    for (const splitView of projectSplitViews) {
      if (replacedThreadIds.has(splitView.sourceThreadId)) continue;
      orderedEntries.push({
        kind: "split",
        rowId: splitView.sourceThreadId,
        rootRowId: splitView.sourceThreadId,
        splitView,
      });
    }
    const activeEntry =
      activeThreadId === undefined
        ? null
        : (orderedEntries.find((entry) => entry.rowId === activeThreadId) ?? null);
    const { hasHiddenEntries: hasHiddenThreads, visibleEntries: renderedEntries } =
      getVisibleSidebarEntriesForPreview({
        entries: orderedEntries,
        activeEntryId: activeEntry?.rowId,
        isExpanded: isThreadListExpanded,
        previewLimit: THREAD_PREVIEW_LIMIT,
      });
    const pinnedCollapsedEntry = !project.expanded && activeEntry ? activeEntry : null;
    const visibleEntries = pinnedCollapsedEntry ? [pinnedCollapsedEntry] : renderedEntries;
    const orderedProjectThreadIds = projectThreads.map((thread) => thread.id);
    const renderSplitRow = (splitView: SplitView) => {
      const leftPreview = resolveSplitPreview(splitView.leftThreadId);
      const rightPreview = resolveSplitPreview(splitView.rightThreadId);
      const isActive = routeSearch.splitViewId === splitView.id;

      return (
        <SidebarMenuSubItem key={`split:${splitView.id}`} className="w-full" data-thread-item>
          <SidebarMenuSubButton
            render={<div role="button" tabIndex={0} />}
            size="sm"
            isActive={isActive}
            className={resolveThreadRowClassName({
              isActive,
              isSelected: false,
            })}
            onClick={() => activateSplitPane(splitView, splitView.focusedPane)}
            onContextMenu={(event) => {
              event.preventDefault();
              void handleSplitContextMenu(splitView, splitView.focusedPane, {
                x: event.clientX,
                y: event.clientY,
              });
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              activateSplitPane(splitView, splitView.focusedPane);
            }}
          >
            <div className="-ml-1.5 flex min-w-0 flex-1 items-center gap-0.5">
              {[
                { pane: "left" as const, preview: leftPreview },
                { pane: "right" as const, preview: rightPreview },
              ].map(({ pane, preview }) => (
                <div
                  key={pane}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    "flex min-w-0 flex-1 select-none items-center gap-1 rounded-md px-1.5 py-0.5 text-left outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-ring",
                    splitView.focusedPane === pane
                      ? "bg-background shadow-xs dark:bg-foreground/12"
                      : "hover:bg-accent/35",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    activateSplitPane(splitView, pane);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleSplitContextMenu(splitView, pane, {
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                  onMouseDown={(event) => {
                    if (event.detail > 1) {
                      event.preventDefault();
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    activateSplitPane(splitView, pane);
                  }}
                >
                  <ProviderGlyph provider={preview.provider} className="size-3 shrink-0" />
                  <span className="min-w-0 truncate text-[length:var(--app-font-size-ui-sm,11px)] leading-5 text-foreground/86">
                    {preview.threadId ? preview.title : "Select chat"}
                  </span>
                </div>
              ))}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/40">
                {formatRelativeTime(splitView.updatedAt)}
              </span>
            </div>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      );
    };

    return (
      <div className="group/collapsible">
        <div className="group/project-header relative">
          <SidebarMenuButton
            ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
            size="sm"
            className={`h-7.5 gap-2 rounded-lg px-2 py-0.5 text-left text-[length:var(--app-font-size-ui,12px)] font-normal hover:bg-accent/55 group-hover/project-header:bg-accent/55 group-hover/project-header:text-sidebar-accent-foreground ${
              isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
            }`}
            {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
            {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
            onPointerDownCapture={handleProjectTitlePointerDownCapture}
            onClick={(event) => handleProjectTitleClick(event, project.id)}
            onKeyDown={(event) => handleProjectTitleKeyDown(event, project.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              void handleProjectContextMenu(project.id, {
                x: event.clientX,
                y: event.clientY,
              });
            }}
          >
            <span className="relative inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/72">
              <ProjectSidebarIcon cwd={project.cwd} expanded={project.expanded} />
              {projectStatus ? (
                <span
                  aria-hidden="true"
                  title={projectStatus.label}
                  className={cn(
                    "absolute -right-0.5 top-0.5 size-1.5 rounded-full",
                    projectStatus.dotClass,
                    projectStatus.pulse ? "animate-pulse" : "",
                  )}
                />
              ) : null}
            </span>
            <div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
              {isRenamingProject ? (
                <input
                  ref={(element) => {
                    if (element && renamingProjectInputRef.current !== element) {
                      renamingProjectInputRef.current = element;
                      element.focus();
                      element.select();
                    }
                  }}
                  className="min-w-0 flex-1 rounded-md border border-ring bg-transparent px-1.5 py-0.5 text-[length:var(--app-font-size-ui,12px)] font-normal text-foreground outline-none"
                  value={renamingProjectName}
                  placeholder={project.folderName}
                  onChange={(event) => setRenamingProjectName(event.target.value)}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      event.preventDefault();
                      renamingProjectCommittedRef.current = true;
                      commitProjectRename(project.id, renamingProjectName, project.localName);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      renamingProjectCommittedRef.current = true;
                      cancelProjectRename();
                    }
                  }}
                  onBlur={() => {
                    if (!renamingProjectCommittedRef.current) {
                      commitProjectRename(project.id, renamingProjectName, project.localName);
                    }
                  }}
                />
              ) : (
                <>
                  <span className="truncate font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/72">
                    {project.name}
                  </span>
                  {project.localName ? (
                    <span className="shrink-0 truncate text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/40">
                      {project.folderName}
                    </span>
                  ) : null}
                </>
              )}
            </div>
          </SidebarMenuButton>
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuAction
                  render={
                    <button
                      type="button"
                      aria-label={`Create new terminal thread in ${project.name}`}
                    />
                  }
                  showOnHover
                  className="sidebar-icon-button top-1 right-[1.875rem] size-5 p-0"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleNewThread(project.id, {
                      envMode: resolveSidebarNewThreadEnvMode({
                        defaultEnvMode: appSettings.defaultThreadEnvMode,
                      }),
                      entryPoint: "terminal",
                    });
                  }}
                >
                  <TerminalIcon className="size-3.5" />
                </SidebarMenuAction>
              }
            />
            <TooltipPopup side="top">
              {newTerminalThreadShortcutLabel
                ? `New terminal thread (${newTerminalThreadShortcutLabel})`
                : "New terminal thread"}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuAction
                  render={
                    <button
                      type="button"
                      aria-label={`Create disposable thread in ${project.name}`}
                    />
                  }
                  showOnHover
                  className="sidebar-icon-button top-1 right-[3.375rem] size-5 p-0"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleNewThread(project.id, {
                      envMode: resolveSidebarNewThreadEnvMode({
                        defaultEnvMode: appSettings.defaultThreadEnvMode,
                      }),
                      temporary: true,
                    });
                  }}
                >
                  <LuMessageSquareDashed className="size-3.5" />
                </SidebarMenuAction>
              }
            />
            <TooltipPopup side="top">New disposable thread</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuAction
                  render={
                    <button
                      type="button"
                      aria-label={`Create new thread in ${project.name}`}
                      data-testid="new-thread-button"
                    />
                  }
                  showOnHover
                  className="sidebar-icon-button top-1 right-1.5 size-5 p-0"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleNewThread(project.id, {
                      envMode: resolveSidebarNewThreadEnvMode({
                        defaultEnvMode: appSettings.defaultThreadEnvMode,
                      }),
                    });
                  }}
                >
                  <SquarePenIcon className="size-3.5" />
                </SidebarMenuAction>
              }
            />
            <TooltipPopup side="top">
              {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
            </TooltipPopup>
          </Tooltip>
        </div>

        <div
          className={cn(
            "grid pt-1 transition-[grid-template-rows,opacity] duration-220 ease-out",
            project.expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <SidebarMenuSub
              ref={attachThreadListAutoAnimateRef}
              className={cn(
                "mx-0 my-0 w-full translate-x-0 gap-0.5 border-l-0 px-0 py-0 transition-transform duration-220 ease-out",
                project.expanded ? "translate-y-0" : "-translate-y-1 pointer-events-none",
              )}
            >
              {visibleEntries.map((entry) =>
                entry.kind === "thread"
                  ? renderThreadRow(
                      entry.thread,
                      orderedProjectThreadIds,
                      entry.depth,
                      entry.childCount,
                      entry.isExpanded,
                    )
                  : renderSplitRow(entry.splitView),
              )}

              {hasHiddenThreads && !isThreadListExpanded && (
                <SidebarMenuSubItem className="w-full">
                  <SidebarMenuSubButton
                    render={<button type="button" />}
                    data-thread-selection-safe
                    size="sm"
                    className="h-7 w-full translate-x-0 justify-start rounded-lg pr-2 pl-8 text-left text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/72 hover:bg-accent/55 hover:text-foreground"
                    onClick={() => {
                      expandThreadListForProject(project.id);
                    }}
                  >
                    <span>Show more</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              )}
              {hasHiddenThreads && isThreadListExpanded && (
                <SidebarMenuSubItem className="w-full">
                  <SidebarMenuSubButton
                    render={<button type="button" />}
                    data-thread-selection-safe
                    size="sm"
                    className="h-7 w-full translate-x-0 justify-start rounded-lg pr-2 pl-8 text-left text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/72 hover:bg-accent/55 hover:text-foreground"
                    onClick={() => {
                      collapseThreadListForProject(project.id);
                    }}
                  >
                    <span>Show less</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              )}
            </SidebarMenuSub>
          </div>
        </div>
      </div>
    );
  }

  const handleProjectTitleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (renamingProjectId === projectId) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        // Consume the synthetic click emitted after a drag release.
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      toggleProject(projectId);
    },
    [clearSelection, renamingProjectId, selectedThreadIds.size, toggleProject],
  );

  const handleProjectTitleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (renamingProjectId === projectId) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      toggleProject(projectId);
    },
    [renamingProjectId, toggleProject],
  );

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedThreadIds.size === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection, selectedThreadIds.size]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if ((event.metaKey || event.ctrlKey) && event.key === "o") {
        event.preventDefault();
        event.stopPropagation();
        handleStartAddProject();
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        event.key === "k" &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        setSearchPaletteOpen((prev) => !prev);
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });
      if (command === "sidebar.search") {
        event.preventDefault();
        event.stopPropagation();
        setSearchPaletteOpen((prev) => !prev);
        return;
      }
      if (command !== "chat.visible.next" && command !== "chat.visible.previous") {
        return;
      }

      const nextThreadId = getNextVisibleSidebarThreadId({
        visibleThreadIds: visibleSidebarThreadIds,
        activeThreadId: activeSidebarThreadId ?? undefined,
        direction: command === "chat.visible.previous" ? "backward" : "forward",
      });
      if (!nextThreadId || nextThreadId === activeSidebarThreadId) return;

      event.preventDefault();
      event.stopPropagation();
      activateThread(nextThreadId);
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [
    activateThread,
    activeSidebarThreadId,
    handleStartAddProject,
    isOnWorkspace,
    keybindings,
    terminalOpen,
    visibleSidebarThreadIds,
  ]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const showDesktopUpdateButton = isElectron && shouldShowDesktopUpdateButton(desktopUpdateState);

  const desktopUpdateTooltip = desktopUpdateState
    ? getDesktopUpdateButtonTooltip(desktopUpdateState, {
        installing: installingDesktopUpdate,
      })
    : "Update available";

  const desktopUpdateButtonDisabled =
    isDesktopUpdateButtonDisabled(desktopUpdateState) || installingDesktopUpdate;
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const desktopUpdateButtonPresentation = getDesktopUpdateButtonPresentation(desktopUpdateState, {
    installing: installingDesktopUpdate,
  });
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const desktopUpdateButtonInteractivityClasses = desktopUpdateButtonDisabled
    ? "cursor-not-allowed opacity-60"
    : "hover:brightness-110";
  const desktopUpdateButtonClasses = installingDesktopUpdate
    ? "bg-sky-500 hover:bg-sky-600"
    : desktopUpdateState?.status === "downloaded"
      ? "bg-emerald-500 hover:bg-emerald-600"
      : desktopUpdateState?.status === "downloading"
        ? "bg-sky-500 hover:bg-sky-600"
        : shouldHighlightDesktopUpdateError(desktopUpdateState)
          ? "bg-rose-500 hover:bg-rose-600"
          : "bg-[var(--info-foreground)] hover:brightness-110";
  const desktopUpdateRowButtonClasses = cn(
    "inline-flex min-h-8 shrink-0 items-center justify-between gap-2 rounded-full px-2.5 py-1 text-left text-white transition-colors",
    desktopUpdateButtonInteractivityClasses,
    desktopUpdateButtonClasses,
  );
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal") ??
    shortcutLabelForCommand(keybindings, "chat.new");
  const newTerminalThreadShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newTerminal");
  const searchShortcutLabel =
    shortcutLabelForCommand(keybindings, "sidebar.search") ??
    (isMacPlatform(navigator.platform) ? "⌘K" : "Ctrl+K");
  const searchPaletteProjects = useMemo<SidebarSearchProject[]>(
    () =>
      projects.map((project) => ({
        id: project.id,
        name: project.name,
        remoteName: project.remoteName,
        folderName: project.folderName,
        localName: project.localName,
        cwd: project.cwd,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      })),
    [projects],
  );
  const searchPaletteThreads = useMemo<SidebarSearchThread[]>(
    () =>
      threads.map((thread) => ({
        id: thread.id,
        title: thread.title,
        projectId: thread.projectId,
        projectName: projectById.get(thread.projectId)?.name ?? "Unknown project",
        projectRemoteName: projectById.get(thread.projectId)?.remoteName ?? "Unknown project",
        provider: thread.modelSelection.provider,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        messages: thread.messages.map((message) => ({
          text: message.text,
        })),
      })),
    [projectById, threads],
  );
  const searchPaletteActions = useMemo<SidebarSearchAction[]>(
    () => [
      {
        id: "new-thread",
        label: "New thread",
        description: "Start a fresh chat in the current project.",
        keywords: ["chat", "new"],
        shortcutLabel: newThreadShortcutLabel,
      },
      {
        id: "add-project",
        label: "Add project",
        description: "Open a repository or folder in the sidebar.",
        keywords: ["folder", "repo", "repository", "open"],
      },
      {
        id: "settings",
        label: "Settings",
        description: "Open app settings.",
        keywords: ["preferences", "config"],
      },
    ],
    [newThreadShortcutLabel],
  );

  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    // Keep the sidebar action as the single visible entry point for manual checks.
    if (desktopUpdateButtonAction === "check") {
      void bridge
        .checkForUpdates()
        .then((nextState) => {
          setInstallingDesktopUpdate(false);
          setDesktopUpdateState(nextState);
          if (nextState.status === "available") {
            toastManager.add({
              type: "success",
              title: "Update available",
              description: `Version ${nextState.availableVersion ?? "available"} is ready to download.`,
            });
            return;
          }

          if (nextState.status === "up-to-date") {
            toastManager.add({
              type: "info",
              title: "You're up to date",
              description: `DP Code ${nextState.currentVersion} is already the newest version.`,
            });
            return;
          }

          if (nextState.status === "error") {
            toastManager.add({
              type: "error",
              title: "Could not check for updates",
              description: nextState.message ?? "An unexpected error occurred.",
            });
          }
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setInstallingDesktopUpdate(false);
          setDesktopUpdateState(result.state);
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      setInstallingDesktopUpdate(true);
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateState(result.state);
          setInstallingDesktopUpdate(false);
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: actionError,
          });
        })
        .catch((error) => {
          setInstallingDesktopUpdate(false);
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
    }
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  const expandThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  }, []);

  const handleToggleProjects = useCallback(() => {
    if (allProjectsExpanded) {
      collapseProjectsExcept(focusedProjectId);
      return;
    }
    setAllProjectsExpanded(true);
  }, [allProjectsExpanded, collapseProjectsExcept, focusedProjectId, setAllProjectsExpanded]);

  const wordmark = (
    <div className="flex w-full items-center gap-1.5">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 font-system-ui">
              <div className="flex min-w-0 items-center gap-1">
                <T3Wordmark />
                <span className="truncate text-[14px] font-normal tracking-tight text-foreground/82">
                  Code
                </span>
              </div>
            </div>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
      <SidebarTrigger
        className="hidden size-7 shrink-0 text-muted-foreground/75 hover:text-foreground md:inline-flex ml-auto"
        aria-label="Toggle thread sidebar"
      />
    </div>
  );

  return (
    <>
      {isElectron ? (
        <>
          <SidebarHeader
            className={cn(
              "drag-region h-[48px] flex-row items-center gap-2 px-4 py-0 font-system-ui",
              appSettings.sidebarSide === "left" && "pl-[90px]",
            )}
          >
            {wordmark}
          </SidebarHeader>
        </>
      ) : (
        <SidebarHeader className="gap-3 px-3 py-2.5 font-system-ui sm:gap-2.5 sm:px-4 sm:py-3">
          {wordmark}
        </SidebarHeader>
      )}

      <SidebarContent className="gap-0 font-system-ui">
        {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
          <SidebarGroup className="px-2 pt-2 pb-0">
            <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
              <TriangleAlertIcon />
              <AlertTitle>Intel build on Apple Silicon</AlertTitle>
              <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
              {desktopUpdateButtonAction !== "none" ? (
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={desktopUpdateButtonDisabled}
                    onClick={handleDesktopUpdateButtonClick}
                  >
                    {desktopUpdateButtonAction === "download"
                      ? "Download ARM build"
                      : desktopUpdateButtonAction === "install"
                        ? "Install ARM build"
                        : "Check for ARM build update"}
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          </SidebarGroup>
        ) : null}
        {isOnSettings ? (
          <SidebarGroup className="px-1.5 py-1.5">
            <SidebarMenu className="gap-0.5">
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="default"
                  className="h-8 gap-2.5 rounded-lg px-2 text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/72 hover:bg-accent/55 hover:text-foreground"
                  onClick={() => void navigate({ to: "/" })}
                >
                  <ArrowLeftIcon className="size-[15px]" />
                  <span>Back to app</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>

            <div className="-mx-1.5 my-1.5 h-px bg-border/70" />
            <div className="space-y-4 pt-2">
              {SETTINGS_NAV_GROUPS.map((group, groupIndex) => {
                const items = SETTINGS_NAV_ITEMS.filter((item) => item.group === group.id);
                if (items.length === 0) {
                  return null;
                }

                return (
                  <div key={group.id} className={groupIndex > 0 ? "pt-4" : undefined}>
                    <div className="mb-1.5 px-2">
                      <span className="text-[length:var(--app-font-size-ui,12px)] font-normal tracking-tight text-muted-foreground/58">
                        {group.label}
                      </span>
                    </div>

                    <SidebarMenuSub className="mx-0 translate-x-0 border-l-0 px-0 py-0">
                      {items.map((item) => {
                        const Icon = item.icon;
                        const isActive = item.id === activeSettingsSection;
                        return (
                          <SidebarMenuSubItem key={item.id} className="w-full">
                            <SidebarMenuSubButton
                              render={<button type="button" />}
                              size="sm"
                              isActive={isActive}
                              className="h-7.5 w-full justify-start gap-2 rounded-lg px-2 py-0.5 text-[length:var(--app-font-size-ui,12px)] font-normal hover:bg-accent"
                              onClick={() => {
                                void navigate({
                                  to: "/settings",
                                  search: (previous) => ({
                                    ...previous,
                                    section: item.id === "general" ? undefined : item.id,
                                  }),
                                });
                              }}
                            >
                              <Icon className="size-3.5 shrink-0" />
                              <span className="truncate text-[length:var(--app-font-size-ui,12px)] leading-5">
                                {item.label}
                              </span>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        );
                      })}
                    </SidebarMenuSub>
                  </div>
                );
              })}
            </div>
          </SidebarGroup>
        ) : (
          <>
            <SidebarSegmentedPicker
              activeView={isOnWorkspace ? "workspace" : "threads"}
              onSelectView={handleSidebarViewChange}
            />
            {/* Primary sidebar actions stay limited to features we currently ship. */}
            <SidebarGroup className="px-1.5 pt-1 pb-1.5">
              <SidebarMenu className="gap-0.5">
                {isOnWorkspace ? (
                  <SidebarPrimaryAction
                    icon={TerminalIcon}
                    label="New workspace"
                    onClick={handleCreateWorkspace}
                  />
                ) : (
                  <>
                    <SidebarPrimaryAction
                      icon={SquarePenIcon}
                      label="New thread"
                      onClick={handlePrimaryNewThread}
                    />
                    <SidebarPrimaryAction
                      icon={SearchIcon}
                      label="Search"
                      active={searchPaletteOpen}
                      onClick={() => {
                        setSearchPaletteOpen(true);
                      }}
                      shortcutLabel={searchShortcutLabel}
                    />
                  </>
                )}
              </SidebarMenu>
            </SidebarGroup>

            {isOnWorkspace ? (
              <SidebarGroup className="px-1.5 pt-1 pb-1.5">
                <div className="my-2 h-px w-full bg-border" />
                <div className="mb-1.5 flex items-center px-2">
                  <span className="text-[length:var(--app-font-size-ui,12px)] font-normal tracking-tight text-muted-foreground/58">
                    Workspace
                  </span>
                </div>

                <DndContext
                  sensors={projectDnDSensors}
                  collisionDetection={closestCorners}
                  modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
                  onDragEnd={handleWorkspaceDragEnd}
                >
                  <SidebarMenu className="gap-0.5">
                    <SortableContext
                      items={workspaceRows.map((workspace) => workspace.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {workspaceRows.map((workspace) => {
                        const isActive = routeWorkspaceId === workspace.id;
                        const isRenaming = renamingWorkspaceId === workspace.id;
                        return (
                          <SortableWorkspaceItem key={workspace.id} workspaceId={workspace.id}>
                            {(dragHandleProps) =>
                              isRenaming ? (
                                <div className="px-1.5 py-0.5">
                                  <input
                                    autoFocus
                                    value={renamingWorkspaceTitle}
                                    onChange={(event) => {
                                      setRenamingWorkspaceTitle(event.target.value);
                                    }}
                                    onBlur={commitWorkspaceRename}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") {
                                        event.preventDefault();
                                        commitWorkspaceRename();
                                      }
                                      if (event.key === "Escape") {
                                        event.preventDefault();
                                        setRenamingWorkspaceId(null);
                                        setRenamingWorkspaceTitle(workspace.title);
                                      }
                                    }}
                                    className="h-7 w-full rounded-md border border-border bg-background px-2 text-[length:var(--app-font-size-ui,12px)] outline-none focus:border-ring"
                                  />
                                </div>
                              ) : (
                                <SidebarMenuItem>
                                  <SidebarMenuButton
                                    size="sm"
                                    isActive={isActive}
                                    className="group/ws h-8 gap-2 rounded-lg px-2 font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-foreground/82 transition-colors hover:bg-accent/55 hover:text-foreground data-[active=true]:bg-accent/65"
                                    onClick={() => {
                                      navigateToWorkspace(workspace.id);
                                    }}
                                    onContextMenu={(event) => {
                                      event.preventDefault();
                                      beginWorkspaceRename(workspace.id, workspace.title);
                                    }}
                                  >
                                    <span
                                      ref={dragHandleProps.setActivatorNodeRef}
                                      {...dragHandleProps.attributes}
                                      {...dragHandleProps.listeners}
                                      className="inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground/65"
                                    >
                                      <TerminalIcon className="size-3.5" />
                                    </span>
                                    <span className="min-w-0 flex-1 truncate">
                                      {workspace.title}
                                    </span>
                                    {workspace.terminalStatus && (
                                      <span
                                        className={cn(
                                          "inline-flex size-1.5 shrink-0 rounded-full",
                                          workspace.terminalStatus.label === "Terminal input needed"
                                            ? "bg-amber-500 dark:bg-amber-300/90"
                                            : workspace.terminalStatus.label ===
                                                "Terminal process running"
                                              ? "bg-teal-500 dark:bg-teal-300/90"
                                              : "bg-emerald-500 dark:bg-emerald-300/90",
                                        )}
                                      />
                                    )}
                                    {workspace.terminalCount > 0 && (
                                      <span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] tabular-nums text-muted-foreground/50">
                                        {workspace.terminalCount}
                                      </span>
                                    )}
                                    <button
                                      type="button"
                                      className="sidebar-icon-button ml-auto inline-flex size-5 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover/ws:opacity-100"
                                      aria-label="Delete workspace"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void handleDeleteWorkspace(workspace.id);
                                      }}
                                    >
                                      <Trash2 className="size-3" />
                                    </button>
                                  </SidebarMenuButton>
                                </SidebarMenuItem>
                              )
                            }
                          </SortableWorkspaceItem>
                        );
                      })}
                    </SortableContext>
                  </SidebarMenu>
                </DndContext>
              </SidebarGroup>
            ) : (
              <SidebarGroup className="px-1.5 py-1.5">
                {pinnedThreads.length > 0 ? (
                  <>
                    <div className="flex flex-col gap-0.5">
                      {pinnedThreads.map((thread) => renderPinnedThreadRow(thread))}
                    </div>
                    <div className="-mx-1.5 my-1.5 h-px bg-border/70" />
                  </>
                ) : (
                  <div className="-mx-1.5 my-1 h-px bg-border" />
                )}
                <div className="my-2 flex items-center justify-between px-2 py-2">
                  <span className="text-[length:var(--app-font-size-ui,12px)] font-normal tracking-tight text-muted-foreground/58">
                    Threads
                  </span>
                  <div className="-mr-1 flex items-center gap-1.5">
                    {projects.length > 0 ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label={
                                allProjectsExpanded
                                  ? focusedProjectId
                                    ? "Collapse all projects except the active project"
                                    : "Collapse all projects"
                                  : "Expand all projects"
                              }
                              className="sidebar-icon-button inline-flex size-5 disabled:cursor-default disabled:opacity-45"
                              onClick={handleToggleProjects}
                            >
                              {allProjectsExpanded ? (
                                <TbArrowsDiagonalMinimize2 className="size-3.5" />
                              ) : (
                                <TbArrowsDiagonal className="size-3.5" />
                              )}
                            </button>
                          }
                        >
                          {allProjectsExpanded ? (
                            <TbArrowsDiagonalMinimize2 className="size-3.5" />
                          ) : (
                            <TbArrowsDiagonal className="size-3.5" />
                          )}
                        </TooltipTrigger>
                        <TooltipPopup side="bottom">
                          {allProjectsExpanded
                            ? focusedProjectId
                              ? "Collapse all projects except the active chat's project"
                              : "Collapse all projects"
                            : "Expand all projects"}
                        </TooltipPopup>
                      </Tooltip>
                    ) : null}
                    <ProjectSortMenu
                      projectSortOrder={appSettings.sidebarProjectSortOrder}
                      threadSortOrder={appSettings.sidebarThreadSortOrder}
                      onProjectSortOrderChange={(sortOrder) => {
                        updateSettings({ sidebarProjectSortOrder: sortOrder });
                      }}
                      onThreadSortOrderChange={(sortOrder) => {
                        updateSettings({ sidebarThreadSortOrder: sortOrder });
                      }}
                    />
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label={
                              shouldShowProjectPathEntry ? "Cancel add project" : "Add project"
                            }
                            aria-pressed={shouldShowProjectPathEntry}
                            className="sidebar-icon-button inline-flex size-5 cursor-pointer"
                            onClick={handleStartAddProject}
                          />
                        }
                      >
                        <FiPlus className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipPopup side="right">
                        {shouldShowProjectPathEntry ? "Cancel add project" : "Add project"}
                      </TooltipPopup>
                    </Tooltip>
                  </div>
                </div>

                {shouldShowProjectPathEntry && (
                  <div className="mb-2.5 px-1">
                    {!showManualPathInput ? (
                      <div className="flex gap-1.5">
                        {isElectron && (
                          <button
                            type="button"
                            className="flex h-8 flex-1 items-center justify-center gap-2 rounded-lg bg-accent/40 px-2 text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/72 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                            onClick={() => void handlePickFolder()}
                            disabled={isPickingFolder || isAddingProject}
                          >
                            <FolderIcon className="size-3.5" />
                            {isPickingFolder
                              ? "Opening..."
                              : isAddingProject
                                ? "Adding..."
                                : "Browse"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="flex h-8 flex-1 items-center justify-center gap-2 rounded-lg bg-accent/40 px-2 text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/72 transition-colors hover:bg-accent hover:text-foreground"
                          onClick={() => setShowManualPathInput(true)}
                        >
                          <TbCursorText className="size-3.5" />
                          Type path
                        </button>
                      </div>
                    ) : (
                      <div
                        className={`flex items-center rounded-lg border bg-secondary transition-colors ${
                          addProjectError
                            ? "border-red-500/70 focus-within:border-red-500"
                            : "border-border focus-within:border-ring"
                        }`}
                      >
                        <input
                          ref={addProjectInputRef}
                          className="min-w-0 flex-1 bg-transparent pl-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
                          placeholder="/path/to/project"
                          value={newCwd}
                          onChange={(event) => {
                            setNewCwd(event.target.value);
                            setAddProjectError(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") handleAddProject();
                            if (event.key === "Escape") {
                              setShowManualPathInput(false);
                              setAddProjectError(null);
                            }
                          }}
                          autoFocus
                        />
                        <button
                          type="button"
                          className="shrink-0 px-2.5 py-1.5 text-xs font-medium text-muted-foreground/50 transition-colors hover:text-foreground disabled:opacity-40"
                          onClick={handleAddProject}
                          disabled={!canAddProject}
                          aria-label="Add project"
                        >
                          {isAddingProject ? "..." : "↵"}
                        </button>
                      </div>
                    )}
                    {addProjectError && (
                      <div className="mt-1 space-y-1 px-0.5">
                        <p className="text-xs leading-tight text-red-400">{addProjectError}</p>
                        {addProjectErrorMeaning && (
                          <p className="text-xs leading-tight text-muted-foreground/70">
                            {addProjectErrorMeaning}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {isManualProjectSorting ? (
                  <DndContext
                    sensors={projectDnDSensors}
                    collisionDetection={projectCollisionDetection}
                    modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
                    onDragStart={handleProjectDragStart}
                    onDragEnd={handleProjectDragEnd}
                    onDragCancel={handleProjectDragCancel}
                  >
                    <SidebarMenu className="gap-3">
                      <SortableContext
                        items={sortedProjects.map((project) => project.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        {sortedProjects.map((project) => (
                          <SortableProjectItem key={project.id} projectId={project.id}>
                            {(dragHandleProps) => renderProjectItem(project, dragHandleProps)}
                          </SortableProjectItem>
                        ))}
                      </SortableContext>
                    </SidebarMenu>
                  </DndContext>
                ) : (
                  <SidebarMenu ref={attachProjectListAutoAnimateRef} className="gap-3">
                    {sortedProjects.map((project) => (
                      <SidebarMenuItem key={project.id} className="rounded-md">
                        {renderProjectItem(project, null)}
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                )}

                {projects.length === 0 && !shouldShowProjectPathEntry && (
                  <div className="px-2 pt-4 text-center text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/58">
                    No projects yet
                  </div>
                )}
              </SidebarGroup>
            )}
          </>
        )}
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-1.5 font-system-ui">
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center gap-2">
              {isOnSettings ? (
                <SidebarMenuButton
                  size="default"
                  className="h-8 flex-1 gap-2.5 rounded-lg px-2 text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/72 hover:bg-accent/55 hover:text-foreground"
                  isActive
                >
                  <SettingsIcon className="size-[15px]" />
                  <span>Settings</span>
                </SidebarMenuButton>
              ) : (
                <SidebarMenuButton
                  size="default"
                  className="h-8 flex-1 gap-2.5 rounded-lg px-2 text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/72 hover:bg-accent/55 hover:text-foreground"
                  onClick={() => void navigate({ to: "/settings" })}
                >
                  <SettingsIcon className="size-[15px]" />
                  <span>Settings</span>
                </SidebarMenuButton>
              )}
              {showDesktopUpdateButton ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={desktopUpdateTooltip}
                        aria-disabled={desktopUpdateButtonDisabled || undefined}
                        disabled={desktopUpdateButtonDisabled}
                        className={desktopUpdateRowButtonClasses}
                        onClick={handleDesktopUpdateButtonClick}
                      >
                        <span className="flex min-w-0 flex-1 flex-col leading-tight">
                          <span className="truncate text-[10px] font-semibold">
                            {desktopUpdateButtonPresentation.label}
                          </span>
                          {desktopUpdateButtonPresentation.detail ? (
                            <span className="truncate text-[8.5px] font-normal text-white/86">
                              {desktopUpdateButtonPresentation.detail}
                            </span>
                          ) : null}
                        </span>
                        {desktopUpdateButtonPresentation.progressPercent !== null ? (
                          <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-white/95">
                            {desktopUpdateButtonPresentation.progressPercent}%
                          </span>
                        ) : null}
                      </button>
                    }
                  />
                  <TooltipPopup side="top">{desktopUpdateTooltip}</TooltipPopup>
                </Tooltip>
              ) : null}
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <RenameThreadDialog
        open={renameDialogThreadId !== null}
        currentTitle={threads.find((t) => t.id === renameDialogThreadId)?.title ?? ""}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setRenameDialogThreadId(null);
        }}
        onSave={(newTitle) => {
          if (renameDialogThreadId === null) return;
          const target = threads.find((t) => t.id === renameDialogThreadId);
          if (!target) return;
          void commitRename(target.id, newTitle, target.title);
        }}
      />

      <SidebarSearchPalette
        open={searchPaletteOpen}
        onOpenChange={setSearchPaletteOpen}
        actions={searchPaletteActions}
        projects={searchPaletteProjects}
        threads={searchPaletteThreads}
        onCreateThread={handlePrimaryNewThread}
        onAddProject={() => void handlePickFolder()}
        onOpenSettings={() => {
          void navigate({ to: "/settings" });
        }}
        onOpenProject={handleOpenProjectFromSearch}
        onOpenThread={(threadId) => {
          activateThread(ThreadId.makeUnsafe(threadId));
        }}
      />
    </>
  );
}
