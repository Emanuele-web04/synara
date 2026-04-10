import {
  ArrowLeftIcon,
  FolderIcon,
  GitPullRequestIcon,
  type LucideIcon,
  PinIcon,
  PlugIcon,
  RocketIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  Trash2,
  TriangleAlertIcon,
} from "~/lib/icons";
import { autoAnimate } from "@formkit/auto-animate";
import { FiGitBranch } from "react-icons/fi";
import { TbFolderPlus } from "react-icons/tb";
import { IoFilter } from "react-icons/io5";
import { LuMessageCircleDashed } from "react-icons/lu";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
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
  PROVIDER_DISPLAY_NAMES,
  ProjectId,
  ThreadId,
  type GitStatusResult,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { resolveThreadWorkspaceCwd } from "@t3tools/shared/threadEnvironment";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
  useAppSettings,
} from "../appSettings";
import { isElectron } from "../env";
import { APP_VERSION } from "../branding";
import { isLinuxPlatform, isMacPlatform, newCommandId, newProjectId } from "../lib/utils";
import { useStore } from "../store";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import { gitRemoveWorktreeMutationOptions, gitStatusQueryOptions } from "../lib/gitReactQuery";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { type Thread } from "../types";
import { ClaudeAI, OpenAI } from "./Icons";
import { ProjectSidebarIcon } from "./ProjectSidebarIcon";
import { ThreadPinToggleButton } from "./ThreadPinToggleButton";
import { SidebarSearchPalette } from "./SidebarSearchPalette";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useThreadHandoff } from "../hooks/useThreadHandoff";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { toastManager } from "./ui/toast";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
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
  getFallbackThreadIdAfterDelete,
  getPinnedThreadsForSidebar,
  getNextVisibleSidebarThreadId,
  getUnpinnedThreadsForSidebar,
  resolveProjectStatusIndicator,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic";
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

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const THREAD_PREVIEW_LIMIT = 6;
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

function ProviderGlyph({
  provider,
  className,
}: {
  provider: "codex" | "claudeAgent";
  className?: string;
}) {
  if (provider === "claudeAgent") {
    return <ClaudeAI aria-hidden="true" className={cn("text-[#d97757]", className)} />;
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

type SidebarSplitPreview = {
  title: string;
  provider: "codex" | "claudeAgent";
  threadId: ThreadId | null;
};

type SidebarProjectEntry =
  | {
      kind: "thread";
      rowId: ThreadId;
      thread: Thread;
    }
  | {
      kind: "split";
      rowId: ThreadId;
      splitView: SplitView;
    };

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
  label: "Terminal process running";
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

function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
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
          render={
            <MenuTrigger className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground" />
          }
        >
          <IoFilter className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sort projects</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-44">
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
        className="group/sidebar-primary-action h-8 gap-2.5 rounded-lg px-2 font-system-ui text-[13px] font-normal text-foreground/82 transition-colors hover:bg-accent/55 hover:text-foreground data-[active=true]:bg-accent/65"
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
            className="h-4.5 min-w-4.5 px-1 text-[10px] text-muted-foreground/72"
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
  const markThreadUnread = useStore((store) => store.markThreadUnread);
  const toggleProject = useStore((store) => store.toggleProject);
  const reorderProjects = useStore((store) => store.reorderProjects);
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
  const isOnPlugins = useLocation({ select: (loc) => loc.pathname === "/plugins" });
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
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null);
  const [renamingWorkspaceTitle, setRenamingWorkspaceTitle] = useState("");
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const isLinuxDesktop = isElectron && isLinuxPlatform(navigator.platform);
  const shouldBrowseForProjectImmediately = isElectron && !isLinuxDesktop;
  const shouldShowProjectPathEntry = addingProject && !shouldBrowseForProjectImmediately;
  const activeSidebarThreadId = activeSplitView?.sourceThreadId ?? routeThreadId;
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
    () => getPinnedThreadsForSidebar(threads, pinnedThreadIds),
    [pinnedThreadIds, threads],
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
        threads.filter((thread) => thread.projectId === projectId),
        appSettings.sidebarThreadSortOrder,
      )[0];
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [appSettings.sidebarThreadSortOrder, navigate, threads],
  );

  const handleOpenProjectFromSearch = useCallback(
    (projectId: string) => {
      const typedProjectId = ProjectId.makeUnsafe(projectId);
      const hasProjectThread = threads.some((thread) => thread.projectId === typedProjectId);
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
    [appSettings.defaultThreadEnvMode, focusMostRecentThreadForProject, handleNewThread, threads],
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

      const existing = projects.find((project) => project.cwd === cwd);
      if (existing) {
        focusMostRecentThreadForProject(existing.id);
        finishAddingProject();
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
        await handleNewThread(projectId, {
          envMode: appSettings.defaultThreadEnvMode,
        }).catch(() => undefined);
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        setIsAddingProject(false);
        if (shouldBrowseForProjectImmediately) {
          toastManager.add({
            type: "error",
            title: "Failed to add project",
            description,
          });
        } else {
          setAddProjectError(description);
        }
        return;
      }
      finishAddingProject();
    },
    [
      focusMostRecentThreadForProject,
      handleNewThread,
      isAddingProject,
      projects,
      shouldBrowseForProjectImmediately,
      appSettings.defaultThreadEnvMode,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const canAddProject = newCwd.trim().length > 0 && !isAddingProject;

  const handlePickFolder = useCallback(async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      // Ignore picker failures and leave the current thread selection unchanged.
    }
    if (pickedPath) {
      await addProjectFromPath(pickedPath);
    } else if (!shouldBrowseForProjectImmediately) {
      addProjectInputRef.current?.focus();
    }
    setIsPickingFolder(false);
  }, [addProjectFromPath, isPickingFolder, shouldBrowseForProjectImmediately]);

  const handleStartAddProject = useCallback(() => {
    setAddProjectError(null);
    if (shouldBrowseForProjectImmediately) {
      void handlePickFolder();
      return;
    }
    setAddingProject((prev) => !prev);
  }, [handlePickFolder, shouldBrowseForProjectImmediately]);

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
      const isPinned = pinnedThreadIdSet.has(threadId);
      const hasPendingApprovals = derivePendingApprovals(thread.activities).length > 0;
      const hasPendingUserInput = derivePendingUserInputs(thread.activities).length > 0;
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
      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }
      await deleteThread(threadId);
    },
    [
      appSettings.confirmThreadDelete,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      handoffThread,
      markThreadUnread,
      pinnedThreadIdSet,
      projectCwdById,
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

  const handleThreadClick = useCallback(
    (event: MouseEvent, threadId: ThreadId, orderedProjectThreadIds: readonly ThreadId[]) => {
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

      activateThread(threadId);
    },
    [activateThread, rangeSelectTo, toggleThreadSelection],
  );

  const handleProjectContextMenu = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [{ id: "delete", label: "Remove project", destructive: true }],
        position,
      );
      if (clicked !== "delete") return;

      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;

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
    [clearProjectDraftThreads, projects, threads],
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

  const sortedProjects = useMemo(
    () => sortProjectsForSidebar(projects, threads, appSettings.sidebarProjectSortOrder),
    [appSettings.sidebarProjectSortOrder, projects, threads],
  );

  useEffect(() => {
    prunePinnedThreads(threads.map((thread) => thread.id));
  }, [prunePinnedThreads, threads]);

  const visibleSidebarThreadIds = useMemo(() => {
    const visibleThreadIds = pinnedThreads.map((thread) => thread.id);

    for (const project of sortedProjects) {
      const projectThreads = sortThreadsForSidebar(
        getUnpinnedThreadsForSidebar(
          threads.filter((thread) => thread.projectId === project.id),
          pinnedThreadIds,
        ),
        appSettings.sidebarThreadSortOrder,
      );
      const projectSplitViews = splitViews.filter(
        (splitView) =>
          splitView.ownerProjectId === project.id &&
          !pinnedThreadIdSet.has(splitView.sourceThreadId),
      );
      const replacedThreadIds = new Set(
        projectSplitViews.map((splitView) => splitView.sourceThreadId),
      );
      const orderedEntryIds = projectThreads.map(
        (thread) => splitViewBySourceThreadId.get(thread.id)?.sourceThreadId ?? thread.id,
      );
      for (const splitView of projectSplitViews) {
        if (
          replacedThreadIds.has(splitView.sourceThreadId) &&
          orderedEntryIds.includes(splitView.sourceThreadId)
        ) {
          continue;
        }
        if (!orderedEntryIds.includes(splitView.sourceThreadId)) {
          orderedEntryIds.push(splitView.sourceThreadId);
        }
      }

      const hasHiddenEntries = orderedEntryIds.length > THREAD_PREVIEW_LIMIT;
      if (!hasHiddenEntries || expandedThreadListsByProject.has(project.id)) {
        visibleThreadIds.push(...orderedEntryIds);
        continue;
      }

      const previewIds = orderedEntryIds.slice(0, THREAD_PREVIEW_LIMIT);
      if (!activeSidebarThreadId || previewIds.includes(activeSidebarThreadId)) {
        visibleThreadIds.push(...previewIds);
        continue;
      }

      const activeEntryId = orderedEntryIds.includes(activeSidebarThreadId)
        ? activeSidebarThreadId
        : null;
      if (!activeEntryId) {
        visibleThreadIds.push(...previewIds);
        continue;
      }

      const includedIds = new Set([...previewIds, activeEntryId]);
      for (const entryId of orderedEntryIds) {
        if (includedIds.has(entryId)) {
          visibleThreadIds.push(entryId);
        }
      }
    }

    return visibleThreadIds;
  }, [
    activeSidebarThreadId,
    appSettings.sidebarThreadSortOrder,
    expandedThreadListsByProject,
    pinnedThreadIdSet,
    pinnedThreadIds,
    pinnedThreads,
    splitViewBySourceThreadId,
    splitViews,
    sortedProjects,
    threads,
  ]);
  const isManualProjectSorting = appSettings.sidebarProjectSortOrder === "manual";

  function orderedThreadIdsForProject(projectId: ProjectId): ThreadId[] {
    return sortThreadsForSidebar(
      threads.filter((thread) => thread.projectId === projectId),
      appSettings.sidebarThreadSortOrder,
    ).map((thread) => thread.id);
  }

  function resolveThreadFolderLabel(projectId: ProjectId): string | null {
    const project = projectById.get(projectId);
    if (!project) return null;
    const folderName = project.cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? null;
    return folderName ?? project.name ?? null;
  }

  function renderPinnedThreadRow(thread: Thread) {
    const isActive = !activeSplitView && routeThreadId === thread.id;
    const folderLabel = resolveThreadFolderLabel(thread.projectId);

    return (
      <button
        key={thread.id}
        type="button"
        data-thread-item
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors",
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
        <PinIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/50" />
        <ProviderGlyph provider={thread.modelSelection.provider} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {folderLabel ? (
            <span className="max-w-24 truncate text-[11px] text-muted-foreground/38">
              {folderLabel}
            </span>
          ) : null}
          <span className="shrink-0 text-[11px] text-muted-foreground/38">
            {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
          </span>
        </div>
      </button>
    );
  }

  function renderThreadRow(thread: Thread, orderedProjectThreadIds: readonly ThreadId[]) {
    const threadTerminalState = selectThreadTerminalState(terminalStateByThreadId, thread.id);
    const threadEntryPoint = threadTerminalState.entryPoint;
    const isActive = !activeSplitView && routeThreadId === thread.id;
    const isPinned = pinnedThreadIdSet.has(thread.id);
    const isSelected = selectedThreadIds.has(thread.id);
    const isHighlighted = isActive || isSelected;
    const hasPendingApprovals = derivePendingApprovals(thread.activities).length > 0;
    const hasPendingUserInput = derivePendingUserInputs(thread.activities).length > 0;
    const threadStatus = resolveThreadStatusPill({
      thread,
      hasPendingApprovals,
      hasPendingUserInput,
    });
    const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(thread);
    const prStatus = prStatusIndicator(prByThreadId.get(thread.id) ?? null);
    const terminalStatus = terminalStatusFromRunningIds(threadTerminalState.runningTerminalIds);
    const terminalCount = threadTerminalState.terminalIds.length;
    const isDisposableThread =
      temporaryThreadIds[thread.id] === true ||
      draftThreadsByThreadId[thread.id]?.isTemporary === true;
    const folderLabel = resolveThreadFolderLabel(thread.projectId);
    const secondaryMetaClass = isHighlighted
      ? "text-foreground/54 dark:text-foreground/64"
      : "text-muted-foreground/34";

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
        {threadStatus && (
          <span
            className={cn(
              "pointer-events-none absolute left-3 top-1/2 z-10 h-1.5 w-1.5 -translate-y-1/2 rounded-full transition-opacity",
              threadStatus.dotClass,
              threadStatus.pulse ? "animate-pulse" : "",
              isPinned
                ? "opacity-0"
                : "opacity-100 group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
            )}
          />
        )}
        <SidebarMenuSubButton
          render={<div role="button" tabIndex={0} />}
          data-thread-entry-point={threadEntryPoint}
          size="sm"
          isActive={isActive}
          className={resolveThreadRowClassName({
            isActive,
            isSelected,
          })}
          onClick={(event) => handleThreadClick(event, thread.id, orderedProjectThreadIds)}
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
          {threadEntryPoint === "terminal" ? (
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
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            {prStatus && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={prStatus.tooltip}
                      className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                      onClick={(event) => {
                        openPrLink(event, prStatus.url);
                      }}
                    >
                      <GitPullRequestIcon className="size-3" />
                    </button>
                  }
                />
                <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
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
                className="min-w-0 flex-1 truncate rounded-md border border-ring bg-transparent px-1.5 py-0.5 text-[13px] outline-none"
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
              <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground/86">
                {thread.title}
              </span>
            )}
            {!isDisposableThread && handoffBadgeLabel ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex shrink-0 items-center text-muted-foreground/55">
                      <FiGitBranch className="size-3" />
                    </span>
                  }
                />
                <TooltipPopup side="top">{handoffBadgeLabel}</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {terminalCount > 1 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      className={`inline-flex items-center gap-0.5 ${
                        terminalStatus ? terminalStatus.colorClass : "text-muted-foreground/55"
                      }`}
                    >
                      <span className="text-[10px] leading-none">{terminalCount}</span>
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
            ) : terminalStatus ? (
              <span
                role="img"
                aria-label={terminalStatus.label}
                title={terminalStatus.label}
                className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
              >
                <TerminalIcon className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`} />
              </span>
            ) : null}
            {isDisposableThread ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex shrink-0 items-center text-muted-foreground/55">
                      <LuMessageCircleDashed className="size-3" />
                    </span>
                  }
                />
                <TooltipPopup side="top">Disposable chat</TooltipPopup>
              </Tooltip>
            ) : null}
            <span className={`shrink-0 text-[12px] ${secondaryMetaClass}`}>
              {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
            </span>
          </div>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    );
  }

  function renderProjectItem(
    project: (typeof sortedProjects)[number],
    dragHandleProps: SortableProjectHandleProps | null,
  ) {
    const allProjectThreads = sortThreadsForSidebar(
      threads.filter((thread) => thread.projectId === project.id),
      appSettings.sidebarThreadSortOrder,
    );
    const projectThreads = getUnpinnedThreadsForSidebar(allProjectThreads, pinnedThreadIds);
    const projectSplitViews = splitViews.filter(
      (splitView) =>
        splitView.ownerProjectId === project.id && !pinnedThreadIdSet.has(splitView.sourceThreadId),
    );
    const projectStatus = resolveProjectStatusIndicator(
      allProjectThreads.map((thread) =>
        resolveThreadStatusPill({
          thread,
          hasPendingApprovals: derivePendingApprovals(thread.activities).length > 0,
          hasPendingUserInput: derivePendingUserInputs(thread.activities).length > 0,
        }),
      ),
    );
    const activeThreadId = activeSidebarThreadId ?? undefined;
    const isThreadListExpanded = expandedThreadListsByProject.has(project.id);
    const replacedThreadIds = new Set(
      projectSplitViews.map((splitView) => splitView.sourceThreadId),
    );
    const orderedEntries: SidebarProjectEntry[] = projectThreads.map((thread) => {
      const splitView = splitViewBySourceThreadId.get(thread.id);
      if (!splitView) {
        return {
          kind: "thread",
          rowId: thread.id,
          thread,
        };
      }
      return {
        kind: "split",
        rowId: splitView.sourceThreadId,
        splitView,
      };
    });
    for (const splitView of projectSplitViews) {
      if (replacedThreadIds.has(splitView.sourceThreadId)) continue;
      orderedEntries.push({
        kind: "split",
        rowId: splitView.sourceThreadId,
        splitView,
      });
    }
    const hasHiddenThreads = orderedEntries.length > THREAD_PREVIEW_LIMIT;
    const previewEntries = orderedEntries.slice(0, THREAD_PREVIEW_LIMIT);
    const activeEntry =
      activeThreadId === undefined
        ? null
        : (orderedEntries.find((entry) => entry.rowId === activeThreadId) ?? null);
    const renderedEntries =
      !hasHiddenThreads || isThreadListExpanded
        ? orderedEntries
        : activeEntry && !previewEntries.some((entry) => entry.rowId === activeEntry.rowId)
          ? orderedEntries.filter((entry) =>
              new Set([
                ...previewEntries.map((candidate) => candidate.rowId),
                activeEntry.rowId,
              ]).has(entry.rowId),
            )
          : previewEntries;
    const pinnedCollapsedEntry = !project.expanded && activeEntry ? activeEntry : null;
    const visibleEntries = pinnedCollapsedEntry ? [pinnedCollapsedEntry] : renderedEntries;
    const shouldShowThreadPanel = project.expanded;
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
                  <span className="min-w-0 truncate text-[12px] leading-5 text-foreground/86">
                    {preview.threadId ? preview.title : "Select chat"}
                  </span>
                </div>
              ))}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <span className="text-[12px] text-muted-foreground/40">
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
            className={`h-7.5 gap-2 rounded-lg px-2 py-0.5 text-left text-[13px] font-normal hover:bg-accent/55 group-hover/project-header:bg-accent/55 group-hover/project-header:text-sidebar-accent-foreground ${
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
                  className={`absolute -right-0.5 top-0.5 size-1.5 rounded-full ${projectStatus.dotClass} ${
                    projectStatus.pulse ? "animate-pulse" : ""
                  }`}
                />
              ) : null}
            </span>
            <span className="flex-1 truncate font-system-ui text-[13px] font-normal text-muted-foreground/72">
              {project.name}
            </span>
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
                  className="top-1 right-7 size-5 rounded-md p-0 text-muted-foreground/60 hover:bg-white/8 hover:text-foreground"
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
                  className="top-1 right-[3.25rem] size-5 rounded-md p-0 text-muted-foreground/60 hover:bg-white/8 hover:text-foreground"
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
                  <LuMessageCircleDashed className="size-3.5" />
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
                  className="top-1 right-1 size-5 rounded-md p-0 text-muted-foreground/60 hover:bg-white/8 hover:text-foreground"
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

        {shouldShowThreadPanel ? (
          <SidebarMenuSub
            ref={attachThreadListAutoAnimateRef}
            className="mx-0 my-0 w-full translate-x-0 gap-0.5 border-l-0 px-0 py-0"
          >
            {visibleEntries.map((entry) =>
              entry.kind === "thread"
                ? renderThreadRow(entry.thread, orderedProjectThreadIds)
                : renderSplitRow(entry.splitView),
            )}

            {hasHiddenThreads && !isThreadListExpanded && (
              <SidebarMenuSubItem className="w-full">
                <SidebarMenuSubButton
                  render={<button type="button" />}
                  data-thread-selection-safe
                  size="sm"
                  className="h-7 w-full translate-x-0 justify-start rounded-lg pr-2 pl-8 text-left text-[13px] text-muted-foreground/72 hover:bg-accent/55 hover:text-foreground"
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
                  className="h-7 w-full translate-x-0 justify-start rounded-lg pr-2 pl-8 text-left text-[13px] text-muted-foreground/72 hover:bg-accent/55 hover:text-foreground"
                  onClick={() => {
                    collapseThreadListForProject(project.id);
                  }}
                >
                  <span>Show less</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            )}
          </SidebarMenuSub>
        ) : null}
      </div>
    );
  }

  const handleProjectTitleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
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
    [clearSelection, selectedThreadIds.size, toggleProject],
  );

  const handleProjectTitleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      toggleProject(projectId);
    },
    [toggleProject],
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

      if ((event.metaKey || event.ctrlKey) && event.key === "k" && !event.shiftKey && !event.altKey) {
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
    ? getDesktopUpdateButtonTooltip(desktopUpdateState)
    : "Update available";

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const desktopUpdateButtonInteractivityClasses = desktopUpdateButtonDisabled
    ? "cursor-not-allowed opacity-60"
    : "hover:bg-accent hover:text-foreground";
  const desktopUpdateButtonClasses =
    desktopUpdateState?.status === "downloaded"
      ? "text-emerald-500"
      : desktopUpdateState?.status === "downloading"
        ? "text-sky-400"
        : shouldHighlightDesktopUpdateError(desktopUpdateState)
          ? "text-rose-500 animate-pulse"
          : "text-amber-500 animate-pulse";
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
        provider: thread.modelSelection.provider,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
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

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
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
      void bridge
        .installUpdate()
        .then((result) => {
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

  const wordmark = (
    <div className="flex items-center gap-1.5">
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
              <SidebarTrigger
                className="hidden size-7 shrink-0 text-muted-foreground/75 hover:text-foreground md:inline-flex"
                aria-label="Toggle thread sidebar"
              />
            </div>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
    </div>
  );

  return (
    <>
      {isElectron ? (
        <>
          <SidebarHeader className="drag-region h-[48px] flex-row items-center gap-2 px-4 py-0 pl-[90px] font-system-ui">
            {wordmark}
            {showDesktopUpdateButton && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={desktopUpdateTooltip}
                      aria-disabled={desktopUpdateButtonDisabled || undefined}
                      disabled={desktopUpdateButtonDisabled}
                      className={`inline-flex size-7 ml-auto mt-1.5 items-center justify-center rounded-md text-muted-foreground transition-colors ${desktopUpdateButtonInteractivityClasses} ${desktopUpdateButtonClasses}`}
                      onClick={handleDesktopUpdateButtonClick}
                    >
                      <RocketIcon className="size-3.5" />
                    </button>
                  }
                />
                <TooltipPopup side="bottom">{desktopUpdateTooltip}</TooltipPopup>
              </Tooltip>
            )}
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
                      : "Install ARM build"}
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          </SidebarGroup>
        ) : null}
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
                <SidebarPrimaryAction
                  icon={PlugIcon}
                  label="Plugins"
                  active={isOnPlugins}
                  onClick={() => {
                    void navigate({ to: "/plugins" });
                  }}
                />
              </>
            )}
          </SidebarMenu>
        </SidebarGroup>

        {isOnWorkspace ? (
          <SidebarGroup className="px-1.5 pt-1 pb-1.5">
            <div className="my-2 h-px w-full bg-border" />
            <div className="mb-1.5 flex items-center px-2">
              <span className="text-[13px] font-normal tracking-tight text-muted-foreground/58">
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
                                className="h-7 w-full rounded-md border border-border bg-background px-2 text-[13px] outline-none focus:border-ring"
                              />
                            </div>
                          ) : (
                            <SidebarMenuItem>
                              <SidebarMenuButton
                                size="sm"
                                isActive={isActive}
                                className="group/ws h-8 gap-2 rounded-lg px-2 font-system-ui text-[13px] font-normal text-foreground/82 transition-colors hover:bg-accent/55 hover:text-foreground data-[active=true]:bg-accent/65"
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
                                <span className="min-w-0 flex-1 truncate">{workspace.title}</span>
                                {workspace.runningTerminalIds.length > 0 && (
                                  <span className="inline-flex size-1.5 shrink-0 rounded-full bg-emerald-500/80" />
                                )}
                                {workspace.terminalCount > 0 && (
                                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
                                    {workspace.terminalCount}
                                  </span>
                                )}
                                <button
                                  type="button"
                                  className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 opacity-0 transition-opacity hover:text-foreground group-hover/ws:opacity-100"
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
            <div className="mb-1.5 flex items-center justify-between px-2">
              <span className="text-[13px] font-normal tracking-tight text-muted-foreground/58">
                Threads
              </span>
              <div className="flex items-center gap-1">
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
                        className="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
                        onClick={handleStartAddProject}
                      />
                    }
                  >
                    <TbFolderPlus className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="right">
                    {shouldShowProjectPathEntry ? "Cancel add project" : "Add project"}
                  </TooltipPopup>
                </Tooltip>
              </div>
            </div>

            {shouldShowProjectPathEntry && (
              <div className="mb-2.5 px-1">
                {isElectron && (
                  <button
                    type="button"
                    className="mb-2 flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-secondary py-2 text-sm text-foreground/88 transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => void handlePickFolder()}
                    disabled={isPickingFolder || isAddingProject}
                  >
                    <FolderIcon className="size-3.5" />
                    {isPickingFolder ? "Picking folder..." : "Browse for folder"}
                  </button>
                )}
                <div className="flex gap-1.5">
                  <input
                    ref={addProjectInputRef}
                    className={`min-w-0 flex-1 rounded-xl border bg-secondary px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none ${
                      addProjectError
                        ? "border-red-500/70 focus:border-red-500"
                        : "border-border focus:border-ring"
                    }`}
                    placeholder="/path/to/project"
                    value={newCwd}
                    onChange={(event) => {
                      setNewCwd(event.target.value);
                      setAddProjectError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") handleAddProject();
                      if (event.key === "Escape") {
                        setAddingProject(false);
                        setAddProjectError(null);
                      }
                    }}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="shrink-0 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
                    onClick={handleAddProject}
                    disabled={!canAddProject}
                  >
                    {isAddingProject ? "Adding..." : "Add"}
                  </button>
                </div>
                {addProjectError && (
                  <p className="mt-1 px-0.5 text-sm leading-tight text-red-400">
                    {addProjectError}
                  </p>
                )}
                <div className="mt-1.5 px-0.5">
                  <button
                    type="button"
                    className="text-sm text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                    onClick={() => {
                      setAddingProject(false);
                      setAddProjectError(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
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
              <div className="px-2 pt-4 text-center text-[13px] text-muted-foreground/58">
                No projects yet
              </div>
            )}
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-1.5 font-system-ui">
        <SidebarMenu>
          <SidebarMenuItem>
            {isOnSettings ? (
              <SidebarMenuButton
                size="default"
                className="h-8 gap-2.5 rounded-lg px-2 text-[13px] font-normal text-muted-foreground/72 hover:bg-accent/55 hover:text-foreground"
                onClick={() => window.history.back()}
              >
                <ArrowLeftIcon className="size-[15px]" />
                <span>Back</span>
              </SidebarMenuButton>
            ) : (
              <SidebarMenuButton
                size="default"
                className="h-8 gap-2.5 rounded-lg px-2 text-[13px] font-normal text-muted-foreground/72 hover:bg-accent/55 hover:text-foreground"
                onClick={() => void navigate({ to: "/settings" })}
              >
                <SettingsIcon className="size-[15px]" />
                <span>Settings</span>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarSearchPalette
        open={searchPaletteOpen}
        onOpenChange={setSearchPaletteOpen}
        actions={searchPaletteActions}
        projects={searchPaletteProjects}
        threads={searchPaletteThreads}
        onCreateThread={handlePrimaryNewThread}
        onAddProject={handleStartAddProject}
        onOpenPlugins={() => {
          void navigate({ to: "/plugins" });
        }}
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
