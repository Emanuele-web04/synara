// FILE: Sidebar.tsx
// Purpose: Renders the project/thread sidebar, including row status, sorting, and thread actions.
// Exports: Sidebar

import {
  ArrowLeftIcon,
  FolderIcon,
  GitMergedSimpleIcon,
  GitPullRequestIcon,
  type LucideIcon,
  NewThreadIcon,
  SearchIcon,
  SettingsIcon,
  TerminalIcon,
  Trash2,
  TriangleAlertIcon,
} from "~/lib/icons";
import { autoAnimate } from "@formkit/auto-animate";
import { FiPlus } from "react-icons/fi";
import { BsChat } from "react-icons/bs";
import { TbArrowsDiagonal, TbArrowsDiagonalMinimize2, TbCursorText } from "react-icons/tb";
import {
  useCallback,
  useEffect,
  lazy,
  useMemo,
  useRef,
  Suspense,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { DndContext, closestCorners } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  PROVIDER_DISPLAY_NAMES,
  ProjectId,
  type ProviderKind,
  ThreadId,
  type GitStatusResult,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { isGenericChatThreadTitle } from "@t3tools/shared/chatThreads";
import { getDefaultModel } from "@t3tools/shared/model";
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
import { showConfirmDialogFallback } from "../confirmDialogFallback";
import { isMacPlatform, newCommandId, newThreadId, randomUUID } from "../lib/utils";
import { useStore } from "../store";
import { getThreadFromState, getThreadsFromState } from "../threadDerivation";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  splitShortcutLabel,
  shouldShowThreadJumpHints,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
} from "../keybindings";
import {
  createSidebarDisplayThreadsSelector,
  createSidebarThreadSummariesSelector,
} from "../storeSelectors";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import {
  gitRemoveWorktreeMutationOptions,
  gitResolvePullRequestQueryOptions,
  gitStatusQueryOptions,
} from "../lib/gitReactQuery";
import { resolveCurrentProjectTargetId } from "../lib/projectShortcutTargets";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { isHomeChatContainerProject, prewarmHomeChatProject } from "../lib/chatProjects";
import { useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadEnvironmentPresentation } from "../lib/threadEnvironment";
import { dispatchThreadRename } from "../lib/threadRename";
import { quotePosixShellArgument } from "../lib/shellQuote";
import { DEFAULT_THREAD_TERMINAL_ID, type SidebarThreadSummary, type Thread } from "../types";
import { shouldRenderTerminalWorkspace } from "./ChatView.logic";
import { CHAT_SURFACE_HEADER_HEIGHT_CLASS } from "./chat/chatHeaderControls";
import { ChatSortMenu, ProjectSortMenu, SidebarPrimaryAction } from "./Sidebar.menus";
import { SidebarThreadHoverActions } from "./Sidebar.threadHoverActions";
import { SidebarThreadRow } from "./Sidebar.threadRow";
import { SidebarPinnedThreadRow } from "./Sidebar.pinnedThreadRow";
import { SidebarProjectItem } from "./Sidebar.projectItem";
import { SidebarSegmentedPicker } from "./Sidebar.picker";
import { SidebarSearchPaletteController } from "./Sidebar.searchController";
import { useSidebarThreadActions } from "./useSidebarThreadActions";
import { useSidebarKeybindings } from "./useSidebarKeybindings";
import { useSidebarContextMenus } from "./useSidebarContextMenus";
import { useSidebarDesktopUpdate } from "./useSidebarDesktopUpdate";
import { useSidebarWorkspaces } from "./useSidebarWorkspaces";
import { useSidebarProjectActions } from "./useSidebarProjectActions";
import { useSidebarProjectDnd } from "./useSidebarProjectDnd";
import { resolvePinnedThreadProjectLabel } from "./Sidebar.resolvePinnedThreadProjectLabel";
import {
  type SortableProjectHandleProps,
  SortableProjectItem,
  SortableWorkspaceItem,
} from "./Sidebar.sortable";
import { AppNavigationButtons } from "./AppNavigationButtons";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import { SidebarSectionToolbar } from "./SidebarSectionToolbar";
import { SidebarGlyph } from "./sidebarGlyphs";
import { RenameThreadDialog } from "./RenameThreadDialog";
import { type ImportProviderKind, type SidebarSearchPaletteMode } from "./SidebarSearchPalette";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useThreadHandoff } from "../hooks/useThreadHandoff";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { toastManager } from "./ui/toast";
import {
  normalizeSidebarProjectThreadListCwd,
  persistSidebarUiState,
  readSidebarUiState,
} from "./Sidebar.uiState";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import {
  describeAddProjectError,
  buildProjectThreadTree,
  deriveSidebarProjectData,
  getFallbackThreadIdAfterDelete,
  getPinnedThreadsForSidebar,
  getNextVisibleSidebarThreadId,
  getSidebarThreadIdsToPrewarm,
  getVisibleSidebarEntriesForPreview,
  groupSidebarThreadsByProjectId,
  pruneExpandedProjectThreadListsForCollapsedProjects,
  DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY,
  EMPTY_THREAD_JUMP_LABELS,
  buildThreadJumpLabelMap,
  formatRelativeTime,
  readDebugFeatureFlagsMenuVisibility,
  resolveSplitPreviewTitle,
  threadJumpLabelMapsEqual,
  toThreadPr,
  type ThreadPr,
  resolveProjectEmptyState,
  resolveSidebarNewThreadEnvMode,
  resolveThreadStatusPill,
  type SidebarDerivedProjectData,
  shouldShowDebugFeatureFlagsMenu,
  shouldPrunePinnedThreads,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic";
import { resolveRestorableThreadRoute, type LastThreadRoute } from "../chatRouteRestore";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS } from "~/hooks/useDesktopTopBarGutter";
import { cn } from "~/lib/utils";
import {
  disclosureContentClassName,
  disclosureShellClassName,
  DISCLOSURE_INNER_CLASS,
} from "~/lib/disclosureMotion";
import { getInitialBrowseQuery } from "~/lib/projectPaths";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useDiffRouteSearch } from "../hooks/useDiffRouteSearch";
import { normalizeSettingsSection } from "../settingsNavigation";
import {
  SIDEBAR_HEADER_LABEL_CLASS_NAME,
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
} from "../sidebarRowStyles";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import {
  resolveSplitViewFocusedThreadId,
  resolveSplitViewPaneIdForThread,
  selectSplitView,
  type SplitViewId,
  useSplitViewStore,
} from "../splitViewStore";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useThreadActivationController } from "../hooks/useThreadActivationController";
import { usePinnedThreadsStore } from "../pinnedThreadsStore";
import { retainThreadDetailSubscription } from "../threadDetailSubscriptionRetention";
import { useWorkspaceStore } from "../workspaceStore";
import type { SidebarSearchAction, SidebarSearchProject } from "./SidebarSearchPalette.logic";
import { useFocusedChatContext } from "../focusedChatContext";
import { showContextMenuFallback } from "../contextMenuFallback";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const THREAD_PREVIEW_LIMIT = 5;
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;
export { formatRelativeTime } from "./Sidebar.logic";
const EMPTY_SHORTCUT_PARTS: readonly string[] = [];
const THREAD_INTENT_PREWARM_RELEASE_MS = 10_000;
const DebugFeatureFlagsMenu = import.meta.env.DEV
  ? lazy(() =>
      import("./DebugFeatureFlagsMenu").then((module) => ({
        default: module.DebugFeatureFlagsMenu,
      })),
    )
  : null;

type DebugFeatureFlagsWindow = Window & {
  synaraShowFeatureFlags?: () => void;
  synaraHideFeatureFlags?: () => void;
  dpcodeShowFeatureFlags?: () => void;
  dpcodeHideFeatureFlags?: () => void;
};

type SidebarSplitPreview = {
  title: string;
  provider: ProviderKind;
  threadId: ThreadId | null;
};

export default function Sidebar() {
  const [showDebugFeatureFlagsMenu, setShowDebugFeatureFlagsMenu] = useState(
    readDebugFeatureFlagsMenuVisibility,
  );
  const projects = useStore((store) => store.projects);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const sidebarThreadSummaryById = useStore((store) => store.sidebarThreadSummaryById);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const markThreadVisited = useStore((store) => store.markThreadVisited);
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
  const persistedPinnedThreadIds = usePinnedThreadsStore((store) => store.pinnedThreadIds);
  const pinThreadLocally = usePinnedThreadsStore((store) => store.pinThread);
  const unpinThread = usePinnedThreadsStore((store) => store.unpinThread);
  const prunePinnedThreads = usePinnedThreadsStore((store) => store.prunePinnedThreads);
  const workspacePages = useWorkspaceStore((store) => store.workspacePages);
  const homeDir = useWorkspaceStore((store) => store.homeDir);
  const chatWorkspaceRoot = useWorkspaceStore((store) => store.chatWorkspaceRoot);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const isOnSettings = useLocation({
    select: (loc) => loc.pathname === "/settings",
  });
  const isOnWorkspace = pathname.startsWith("/workspace");
  const isOnReview = pathname.startsWith("/review");
  const { settings: appSettings, updateSettings } = useAppSettings();
  const { handleNewThread } = useHandleNewThread();
  const { handleNewChat } = useHandleNewChat();
  const { createThreadHandoff } = useThreadHandoff();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const routeWorkspaceId = useParams({
    strict: false,
    select: (params) => (typeof params.workspaceId === "string" ? params.workspaceId : null),
  });
  const routeSearch = useDiffRouteSearch();
  const settingsSectionSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const activeSettingsSection = normalizeSettingsSection(settingsSectionSearch.section);
  const activeSplitView = useSplitViewStore(selectSplitView(routeSearch.splitViewId ?? null));
  const splitViewsById = useSplitViewStore((store) => store.splitViewsById);

  useEffect(() => {
    const api = readNativeApi();
    if (!api || !threadsHydrated || projects.length > 0) {
      return;
    }

    let cancelled = false;
    // The sidebar is the visible empty-state owner. If startup hydrated empty
    // before the desktop projection caught up, ask the lightweight shell endpoint once.
    void api.orchestration
      .getShellSnapshot()
      .then((snapshot) => {
        if (cancelled || (snapshot.projects.length === 0 && snapshot.threads.length === 0)) {
          return;
        }
        syncServerShellSnapshot(snapshot);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [projects.length, syncServerShellSnapshot, threadsHydrated]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const canInstallConsoleCommand = shouldShowDebugFeatureFlagsMenu({
      isDev: import.meta.env.DEV,
      hostname: window.location.hostname,
      storageValue: "true",
    });
    if (!canInstallConsoleCommand) {
      return;
    }

    const debugWindow = window as DebugFeatureFlagsWindow;
    const updateVisibility = () => {
      setShowDebugFeatureFlagsMenu(readDebugFeatureFlagsMenuVisibility());
    };
    const showFeatureFlags = () => {
      window.localStorage.setItem(DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY, "true");
      updateVisibility();
    };
    const hideFeatureFlags = () => {
      window.localStorage.removeItem(DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY);
      updateVisibility();
    };

    debugWindow.synaraShowFeatureFlags = showFeatureFlags;
    debugWindow.synaraHideFeatureFlags = hideFeatureFlags;
    debugWindow.dpcodeShowFeatureFlags = showFeatureFlags;
    debugWindow.dpcodeHideFeatureFlags = hideFeatureFlags;
    window.addEventListener("storage", updateVisibility);
    updateVisibility();

    return () => {
      window.removeEventListener("storage", updateVisibility);
      if (debugWindow.synaraShowFeatureFlags === showFeatureFlags) {
        delete debugWindow.synaraShowFeatureFlags;
      }
      if (debugWindow.synaraHideFeatureFlags === hideFeatureFlags) {
        delete debugWindow.synaraHideFeatureFlags;
      }
      if (debugWindow.dpcodeShowFeatureFlags === showFeatureFlags) {
        delete debugWindow.dpcodeShowFeatureFlags;
      }
      if (debugWindow.dpcodeHideFeatureFlags === hideFeatureFlags) {
        delete debugWindow.dpcodeHideFeatureFlags;
      }
    };
  }, []);
  const createSplitViewFromDrop = useSplitViewStore((store) => store.createFromDrop);
  const setSplitFocusedPane = useSplitViewStore((store) => store.setFocusedPane);
  const removeThreadFromSplitViews = useSplitViewStore((store) => store.removeThreadFromSplitViews);
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const { activeProjectId: focusedProjectId } = useFocusedChatContext();
  const {
    newCwd,
    setNewCwd,
    addProjectError,
    setAddProjectError,
    addingProject,
    isAddingProject,
    isPickingFolder,
    showManualPathInput,
    setShowManualPathInput,
    addProjectFromPath,
    handleAddProject,
    canAddProject,
    handlePickFolder,
    handleStartAddProject,
  } = useSidebarProjectActions({
    projects,
    appSettings,
    navigate,
    setProjectExpanded,
    handleNewThread,
    syncServerShellSnapshot,
  });
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [searchPaletteMode, setSearchPaletteMode] = useState<SidebarSearchPaletteMode>("search");
  const [searchPaletteInitialQuery, setSearchPaletteInitialQuery] = useState<string | null>(null);
  const addProjectErrorMeaning = useMemo(
    () => (addProjectError ? describeAddProjectError(addProjectError) : null),
    [addProjectError],
  );
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [pendingArchiveConfirmationThreadId, setPendingArchiveConfirmationThreadId] =
    useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [renameDialogThreadId, setRenameDialogThreadId] = useState<ThreadId | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<ProjectId | null>(null);
  const [renamingProjectName, setRenamingProjectName] = useState("");
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<string>
  >(() => new Set(readSidebarUiState().expandedProjectThreadListCwds));
  const [chatSectionExpanded, setChatSectionExpanded] = useState(
    () => readSidebarUiState().chatSectionExpanded,
  );
  const [chatThreadListExpanded, setChatThreadListExpanded] = useState(
    () => readSidebarUiState().chatThreadListExpanded,
  );
  const [dismissedThreadStatusKeyByThreadId, setDismissedThreadStatusKeyByThreadId] = useState<
    Record<string, string>
  >(() => readSidebarUiState().dismissedThreadStatusKeyByThreadId);
  const [lastThreadRoute, setLastThreadRoute] = useState(
    () => readSidebarUiState().lastThreadRoute,
  );
  const [optimisticActiveThreadId, setOptimisticActiveThreadId] = useState<ThreadId | null>(null);
  const [expandedSubagentParentIds, setExpandedSubagentParentIds] = useState<ReadonlySet<ThreadId>>(
    () => new Set(),
  );
  const autoRevealedSubagentThreadIdRef = useRef<ThreadId | null>(null);
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const lastThreadRenameTapRef = useRef<{
    threadId: ThreadId;
    timestamp: number;
  } | null>(null);
  const renamingProjectCommittedRef = useRef(false);
  const renamingProjectInputRef = useRef<HTMLInputElement | null>(null);
  const intentThreadRetentionByIdRef = useRef(
    new Map<ThreadId, { release: () => void; timeoutId: number }>(),
  );
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);

  // Keep every platform on the same explicit submit path so desktop picker
  // results do not depend on a separate immediate-add branch.
  const shouldShowProjectPathEntry = addingProject;
  const routeActiveSidebarThreadId = routeThreadId;
  const activeSidebarThreadId = optimisticActiveThreadId ?? routeActiveSidebarThreadId;
  const visualActiveSidebarThreadId = optimisticActiveThreadId ?? routeThreadId;
  const selectSidebarThreads = useMemo(() => createSidebarThreadSummariesSelector(), []);
  const selectSidebarDisplayThreads = useMemo(() => createSidebarDisplayThreadsSelector(), []);
  const sidebarThreads = useStore(selectSidebarThreads);
  const sidebarDisplayThreads = useStore(selectSidebarDisplayThreads);
  const dismissThreadStatus = useCallback(
    (threadId: ThreadId, statusKey: string | null | undefined) => {
      if (!statusKey) {
        return;
      }
      setDismissedThreadStatusKeyByThreadId((current) => {
        if (current[threadId] === statusKey) {
          return current;
        }
        return {
          ...current,
          [threadId]: statusKey,
        };
      });
    },
    [],
  );
  const clearDismissedThreadStatus = useCallback((threadId: ThreadId) => {
    setDismissedThreadStatusKeyByThreadId((current) => {
      if (!(threadId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[threadId];
      return next;
    });
  }, []);
  const resolveThreadStatusForSidebar = useCallback(
    (thread: SidebarThreadSummary) =>
      resolveThreadStatusPill({
        thread: {
          ...thread,
          dismissedStatusKey: dismissedThreadStatusKeyByThreadId[thread.id],
        },
        hasPendingApprovals: thread.hasPendingApprovals,
        hasPendingUserInput: thread.hasPendingUserInput,
      }),
    [dismissedThreadStatusKeyByThreadId],
  );

  useEffect(() => {
    if (!optimisticActiveThreadId) {
      return;
    }
    if (routeActiveSidebarThreadId === optimisticActiveThreadId) {
      setOptimisticActiveThreadId(null);
      return;
    }

    const timeout = window.setTimeout(() => {
      setOptimisticActiveThreadId((current) =>
        current === optimisticActiveThreadId ? null : current,
      );
    }, 1_500);
    return () => window.clearTimeout(timeout);
  }, [optimisticActiveThreadId, routeActiveSidebarThreadId]);

  const clearThreadNotification = useCallback(
    (threadId: ThreadId) => {
      const thread = sidebarThreadSummaryById[threadId];
      if (!thread) {
        return;
      }
      const threadStatus = resolveThreadStatusForSidebar(thread);
      if (!threadStatus?.dismissible) {
        return;
      }
      if (threadStatus.label === "Completed") {
        markThreadVisited(threadId, thread.latestTurn?.completedAt ?? undefined);
        return;
      }
      dismissThreadStatus(threadId, threadStatus.dismissalKey);
    },
    [
      dismissThreadStatus,
      markThreadVisited,
      resolveThreadStatusForSidebar,
      sidebarThreadSummaryById,
    ],
  );
  const routeThreadSummary = routeThreadId
    ? (sidebarThreadSummaryById[routeThreadId] ?? null)
    : null;
  const routeTerminalState = routeThreadId
    ? selectThreadTerminalState(terminalStateByThreadId, routeThreadId)
    : null;
  const terminalOpen = routeTerminalState?.terminalOpen ?? false;
  const terminalWorkspaceOpen = shouldRenderTerminalWorkspace({
    activeProjectExists: routeThreadSummary !== null,
    presentationMode: routeTerminalState?.presentationMode ?? "drawer",
    terminalOpen,
  });
  const pinnedThreadIds = useMemo(() => {
    const next = new Set<ThreadId>();
    for (const thread of sidebarDisplayThreads) {
      if (thread.isPinned === true) {
        next.add(thread.id);
      }
    }
    for (const threadId of persistedPinnedThreadIds) {
      next.add(threadId);
    }
    return [...next];
  }, [persistedPinnedThreadIds, sidebarDisplayThreads]);
  const pinnedThreadIdSet = useMemo(() => new Set(pinnedThreadIds), [pinnedThreadIds]);
  const pinnedThreads = useMemo(
    () => getPinnedThreadsForSidebar(sidebarDisplayThreads, pinnedThreadIds),
    [pinnedThreadIds, sidebarDisplayThreads],
  );
  const setThreadPinned = useCallback(
    async (threadId: ThreadId, isPinned: boolean) => {
      const api = readNativeApi();
      if (!api) return;
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId,
        isPinned,
      });
      if (isPinned) {
        pinThreadLocally(threadId);
      } else {
        unpinThread(threadId);
      }
    },
    [pinThreadLocally, unpinThread],
  );
  const toggleThreadPinned = useCallback(
    (threadId: ThreadId) => {
      const isPinned = pinnedThreadIdSet.has(threadId);
      void setThreadPinned(threadId, !isPinned).catch((error) => {
        console.error("Failed to update pinned thread state", {
          threadId,
          error,
        });
        toastManager.add({
          type: "error",
          title: isPinned ? "Unable to unpin thread" : "Unable to pin thread",
        });
      });
    },
    [pinnedThreadIdSet, setThreadPinned],
  );
  const openPrLink = useCallback((event: MouseEvent<HTMLElement>, prUrl: string) => {
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
  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
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

  const {
    workspaceRows,
    renamingWorkspaceId,
    renamingWorkspaceTitle,
    setRenamingWorkspaceId,
    setRenamingWorkspaceTitle,
    handleCreateWorkspace,
    beginWorkspaceRename,
    commitWorkspaceRename,
    handleDeleteWorkspace,
    handleWorkspaceDragEnd,
  } = useSidebarWorkspaces({ routeWorkspaceId, navigateToWorkspace });

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

      const restorableRoute = resolveRestorableThreadRoute({
        lastThreadRoute,
        availableThreadIds: new Set(Object.keys(sidebarThreadSummaryById)),
      });
      if (restorableRoute) {
        void navigate({
          to: "/$threadId",
          params: { threadId: ThreadId.makeUnsafe(restorableRoute.threadId) },
          search: () => ({
            splitViewId: restorableRoute.splitViewId,
          }),
        });
        return;
      }

      const latestThread = sortThreadsForSidebar(
        sidebarThreads,
        appSettings.sidebarThreadSortOrder,
      )[0];
      if (latestThread) {
        void navigate({
          to: "/$threadId",
          params: { threadId: latestThread.id },
        });
        return;
      }

      void handleNewChat({ fresh: true });
    },
    [
      appSettings.sidebarThreadSortOrder,
      handleNewChat,
      lastThreadRoute,
      navigate,
      navigateToWorkspace,
      routeWorkspaceId,
      sidebarThreadSummaryById,
      sidebarThreads,
      workspacePages,
    ],
  );

  useEffect(() => {
    if (!homeDir) {
      return;
    }
    prewarmHomeChatProject({ homeDir, chatWorkspaceRoot });
  }, [chatWorkspaceRoot, homeDir]);

  // Opens a fresh home-chat draft directly on the draft thread route so the first send
  // does not need a second route swap from "/" to "/$threadId".
  const handleCreateHomeChat = useCallback(async () => {
    await handleNewChat({ fresh: true });
  }, [handleNewChat]);

  const currentProjectShortcutTargetId = useMemo(
    () => resolveCurrentProjectTargetId(projects, focusedProjectId),
    [focusedProjectId, projects],
  );

  const handlePrimaryNewThread = useCallback(() => {
    if (currentProjectShortcutTargetId) {
      void handleNewThread(currentProjectShortcutTargetId, {
        envMode: resolveSidebarNewThreadEnvMode({
          defaultEnvMode: appSettings.defaultThreadEnvMode,
        }),
      });
      return;
    }

    handleStartAddProject();
  }, [
    appSettings.defaultThreadEnvMode,
    currentProjectShortcutTargetId,
    handleNewThread,
    handleStartAddProject,
  ]);

  const handleImportThread = useCallback(
    async (provider: ImportProviderKind, externalId: string) => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("The app server is unavailable.");
      }

      if (!currentProjectShortcutTargetId) {
        throw new Error("Add a project before importing a thread.");
      }

      const activeProject = projects.find(
        (project) => project.id === currentProjectShortcutTargetId,
      );
      if (!activeProject) {
        throw new Error("The target project could not be resolved.");
      }

      const providerDefaultModel = getDefaultModel(provider);
      const modelSelection =
        activeProject.defaultModelSelection?.provider === provider
          ? activeProject.defaultModelSelection
          : providerDefaultModel
            ? {
                provider,
                model: providerDefaultModel,
              }
            : null;
      if (!modelSelection) {
        throw new Error("Select a Pi model before importing a Pi thread.");
      }
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const trimmedExternalId = externalId.trim();
      const suffix = trimmedExternalId.slice(-8);
      const title =
        provider === "claudeAgent"
          ? `Imported Claude session${suffix ? ` ${suffix}` : ""}`
          : provider === "cursor"
            ? `Imported Cursor session${suffix ? ` ${suffix}` : ""}`
            : provider === "kilo"
              ? `Imported Kilo session${suffix ? ` ${suffix}` : ""}`
              : provider === "opencode"
                ? `Imported OpenCode session${suffix ? ` ${suffix}` : ""}`
                : `Imported Codex thread${suffix ? ` ${suffix}` : ""}`;
      let createdThread = false;

      try {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId: activeProject.id,
          title,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          envMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          branch: null,
          worktreePath: null,
          createdAt,
        });
        createdThread = true;

        await api.orchestration.importThread({
          threadId,
          externalId: trimmedExternalId,
        });

        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
      } catch (error) {
        if (createdThread) {
          await api.orchestration
            .dispatchCommand({
              type: "thread.delete",
              commandId: newCommandId(),
              threadId,
            })
            .catch(() => undefined);
        }
        throw error;
      }
    },
    [appSettings.defaultThreadEnvMode, currentProjectShortcutTargetId, navigate, projects],
  );

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

      const outcome = await dispatchThreadRename({
        threadId,
        newTitle,
        unchangedTitles: [originalTitle],
      }).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        return null;
      });

      if (outcome === "empty") {
        toastManager.add({
          type: "warning",
          title: "Thread title cannot be empty",
        });
        finishRename();
        return;
      }
      if (outcome === "unchanged" || outcome === "unavailable" || outcome === null) {
        finishRename();
        return;
      }
      finishRename();
    },
    [],
  );

  const openRenameThreadDialog = useCallback((threadId: ThreadId) => {
    setRenameDialogThreadId(threadId);
  }, []);

  const handleThreadRenamePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => {
      if (event.pointerType !== "touch" && event.pointerType !== "pen") {
        return;
      }

      const previousTap = lastThreadRenameTapRef.current;
      const currentTapTimestamp = event.timeStamp;
      if (
        previousTap &&
        previousTap.threadId === threadId &&
        currentTapTimestamp - previousTap.timestamp <= 320
      ) {
        event.preventDefault();
        event.stopPropagation();
        lastThreadRenameTapRef.current = null;
        openRenameThreadDialog(threadId);
        return;
      }

      lastThreadRenameTapRef.current = {
        threadId,
        timestamp: currentTapTimestamp,
      };
    },
    [openRenameThreadDialog],
  );

  const prewarmThreadDetailForIntent = useCallback((threadId: ThreadId) => {
    const previous = intentThreadRetentionByIdRef.current.get(threadId);
    if (previous) {
      window.clearTimeout(previous.timeoutId);
      previous.release();
    }

    const release = retainThreadDetailSubscription(threadId);
    const timeoutId = window.setTimeout(() => {
      const current = intentThreadRetentionByIdRef.current.get(threadId);
      if (!current || current.release !== release) return;
      current.release();
      intentThreadRetentionByIdRef.current.delete(threadId);
    }, THREAD_INTENT_PREWARM_RELEASE_MS);

    intentThreadRetentionByIdRef.current.set(threadId, { release, timeoutId });
  }, []);

  useEffect(
    () => () => {
      for (const entry of intentThreadRetentionByIdRef.current.values()) {
        window.clearTimeout(entry.timeoutId);
        entry.release();
      }
      intentThreadRetentionByIdRef.current.clear();
    },
    [],
  );

  const primeThreadActivation = useCallback(
    (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      prewarmThreadDetailForIntent(threadId);
      setOptimisticActiveThreadId(threadId);
    },
    [prewarmThreadDetailForIntent],
  );

  const {
    deleteThread,
    copyThreadIdToClipboard,
    copyPathToClipboard,
    handoffThread,
    confirmAndDeleteThread,
    archiveThread,
    confirmAndArchiveThread,
    inlineConfirmArchiveThread,
    archiveAllThreadsInProject,
    deleteProjectThreads,
    deleteAllThreadsInProject,
  } = useSidebarThreadActions({
    appSettings,
    sidebarThreads,
    sidebarThreadSummaryById,
    projectById,
    routeThreadId,
    routeSearch,
    activeSplitView,
    navigate,
    removeWorktreeMutation,
    handleNewChat,
    createThreadHandoff,
    clearComposerDraftForThread,
    clearProjectDraftThreadById,
    clearTerminalState,
    clearTemporaryThread,
    removeThreadFromSplitViews,
    unpinThread,
    removeFromSelection,
    setPendingArchiveConfirmationThreadId,
  });

  const { handleThreadContextMenu, handleMultiSelectContextMenu, handleProjectContextMenu } =
    useSidebarContextMenus({
      appSettings,
      sidebarThreads,
      sidebarThreadSummaryById,
      projects,
      pinnedThreadIdSet,
      projectCwdById,
      selectedThreadIds,
      navigate,
      resolveThreadStatusForSidebar,
      markThreadUnread,
      clearDismissedThreadStatus,
      clearThreadNotification,
      toggleThreadPinned,
      clearSelection,
      removeFromSelection,
      clearProjectDraftThreads,
      handoffThread,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      confirmAndArchiveThread,
      confirmAndDeleteThread,
      archiveThread,
      deleteThread,
      archiveAllThreadsInProject,
      deleteAllThreadsInProject,
      deleteProjectThreads,
      setRenamingThreadId,
      setRenamingTitle,
      renamingCommittedRef,
      setRenamingProjectId,
      setRenamingProjectName,
      renamingProjectCommittedRef,
    });

  const rememberLastThreadRouteNow = useCallback(
    (nextLastThreadRoute: LastThreadRoute) => {
      setLastThreadRoute(nextLastThreadRoute);
      persistSidebarUiState({
        chatSectionExpanded,
        chatThreadListExpanded,
        expandedProjectThreadListCwds: [...expandedThreadListsByProject],
        dismissedThreadStatusKeyByThreadId,
        lastThreadRoute: nextLastThreadRoute,
      });
    },
    [
      chatSectionExpanded,
      chatThreadListExpanded,
      dismissedThreadStatusKeyByThreadId,
      expandedThreadListsByProject,
    ],
  );
  const { activateThreadFromSidebarIntent } = useThreadActivationController({
    activeSplitView,
    clearSelection,
    navigate,
    openChatThreadPage,
    openSidechatSplit: ({ sourceThreadId, ownerProjectId, sidechatThreadId }) =>
      createSplitViewFromDrop({
        sourceThreadId,
        ownerProjectId,
        droppedThreadId: sidechatThreadId,
        direction: "horizontal",
        side: "second",
      }),
    openTerminalThreadPage,
    prewarmThreadDetailForIntent,
    rememberLastThreadRouteNow,
    routeSplitViewId: routeSearch.splitViewId,
    routeThreadId,
    selectedThreadCount: selectedThreadIds.size,
    setOptimisticActiveThreadId,
    setSelectionAnchor,
    setSplitFocusedPane,
    sidebarThreadSummaryById,
    splitViewsById,
    terminalStateByThreadId,
  });

  const {
    projectDnDSensors,
    projectCollisionDetection,
    handleProjectDragEnd,
    handleProjectDragStart,
    handleProjectDragCancel,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
  } = useSidebarProjectDnd({
    sidebarProjectSortOrder: appSettings.sidebarProjectSortOrder,
    projects,
    reorderProjects,
  });

  const animatedProjectListsRef = useRef(new WeakSet<HTMLElement>());
  const attachProjectListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedProjectListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedProjectListsRef.current.add(node);
  }, []);

  const sidebarThreadsByProjectId = useMemo(
    () => groupSidebarThreadsByProjectId(sidebarDisplayThreads),
    [sidebarDisplayThreads],
  );
  const sortedSidebarThreadsByProjectId = useMemo(() => {
    const byProjectId = new Map<ProjectId, SidebarThreadSummary[]>();
    for (const [projectId, projectThreads] of sidebarThreadsByProjectId) {
      byProjectId.set(
        projectId,
        sortThreadsForSidebar(projectThreads, appSettings.sidebarThreadSortOrder),
      );
    }
    return byProjectId;
  }, [appSettings.sidebarThreadSortOrder, sidebarThreadsByProjectId]);
  const resolveSplitPreview = useCallback(
    (threadId: ThreadId | null): SidebarSplitPreview => {
      const thread = threadId ? (sidebarThreadSummaryById[threadId] ?? null) : null;
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
    [composerDraftsByThreadId, sidebarThreadSummaryById],
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

  const handleCreateTerminalThreadInProject = useCallback(
    (projectId: ProjectId) => {
      void handleNewThread(projectId, {
        envMode: resolveSidebarNewThreadEnvMode({
          defaultEnvMode: appSettings.defaultThreadEnvMode,
        }),
        entryPoint: "terminal",
      });
    },
    [appSettings.defaultThreadEnvMode, handleNewThread],
  );

  const handleCreateDisposableThreadInProject = useCallback(
    (projectId: ProjectId) => {
      void handleNewThread(projectId, {
        envMode: resolveSidebarNewThreadEnvMode({
          defaultEnvMode: appSettings.defaultThreadEnvMode,
        }),
        temporary: true,
      });
    },
    [appSettings.defaultThreadEnvMode, handleNewThread],
  );

  const handleCreateThreadInProject = useCallback(
    (projectId: ProjectId) => {
      void handleNewThread(projectId, {
        envMode: resolveSidebarNewThreadEnvMode({
          defaultEnvMode: appSettings.defaultThreadEnvMode,
        }),
      });
    },
    [appSettings.defaultThreadEnvMode, handleNewThread],
  );

  const sortedProjects = useMemo(
    () => sortProjectsForSidebar(projects, sidebarThreads, appSettings.sidebarProjectSortOrder),
    [appSettings.sidebarProjectSortOrder, projects, sidebarThreads],
  );
  const chatProjects = useMemo(
    () =>
      sortedProjects.filter((project) =>
        isHomeChatContainerProject(project, { homeDir, chatWorkspaceRoot }),
      ),
    [chatWorkspaceRoot, homeDir, sortedProjects],
  );
  const visibleChatThreadRows = useMemo(() => {
    if (!chatSectionExpanded) {
      return [];
    }
    return buildProjectThreadTree({
      threads: sortThreadsForSidebar(
        chatProjects.flatMap((project) => sortedSidebarThreadsByProjectId.get(project.id) ?? []),
        appSettings.sidebarThreadSortOrder,
      ),
      expandedParentThreadIds: expandedSubagentParentIds,
    });
  }, [
    appSettings.sidebarThreadSortOrder,
    chatSectionExpanded,
    chatProjects,
    expandedSubagentParentIds,
    sortedSidebarThreadsByProjectId,
  ]);
  const visibleChatThreadIds = useMemo(
    () => visibleChatThreadRows.map((row) => row.thread.id),
    [visibleChatThreadRows],
  );
  const visibleChatPreviewEntries = useMemo(
    () =>
      visibleChatThreadRows.map((row) => ({
        rowId: row.thread.id,
        rootRowId: row.rootThreadId,
        row,
      })),
    [visibleChatThreadRows],
  );
  const activeChatPreviewEntry =
    activeSidebarThreadId === undefined
      ? null
      : (visibleChatPreviewEntries.find((entry) => entry.rowId === activeSidebarThreadId) ?? null);
  const { hasHiddenEntries: hasHiddenChatThreads, visibleEntries: renderedChatEntries } = useMemo(
    () =>
      getVisibleSidebarEntriesForPreview({
        entries: visibleChatPreviewEntries,
        activeEntryId: activeChatPreviewEntry?.rowId,
        isExpanded: chatThreadListExpanded,
        previewLimit: THREAD_PREVIEW_LIMIT,
      }),
    [activeChatPreviewEntry?.rowId, chatThreadListExpanded, visibleChatPreviewEntries],
  );
  const standardProjects = useMemo(
    () =>
      sortedProjects.filter(
        (project) =>
          project.kind === "project" &&
          !isHomeChatContainerProject(project, { homeDir, chatWorkspaceRoot }),
      ),
    [chatWorkspaceRoot, homeDir, sortedProjects],
  );
  const projectEmptyState = resolveProjectEmptyState({
    projectCount: standardProjects.length,
    shouldShowProjectPathEntry,
    threadsHydrated,
  });
  const standardProjectSidebarDataById = useMemo<ReadonlyMap<ProjectId, SidebarDerivedProjectData>>(
    () =>
      deriveSidebarProjectData({
        projects: standardProjects,
        sortedSidebarThreadsByProjectId,
        pinnedThreadIds,
        expandedParentThreadIds: expandedSubagentParentIds,
        expandedThreadListProjectCwds: expandedThreadListsByProject,
        normalizeProjectCwd: normalizeSidebarProjectThreadListCwd,
        activeSidebarThreadId: activeSidebarThreadId ?? undefined,
        previewLimit: THREAD_PREVIEW_LIMIT,
        resolveThreadStatus: resolveThreadStatusForSidebar,
      }),
    [
      activeSidebarThreadId,
      expandedSubagentParentIds,
      expandedThreadListsByProject,
      pinnedThreadIds,
      sortedSidebarThreadsByProjectId,
      standardProjects,
      resolveThreadStatusForSidebar,
    ],
  );
  const allProjectsExpanded = useMemo(
    () => standardProjects.length > 0 && standardProjects.every((project) => project.expanded),
    [standardProjects],
  );

  // Reset per-project preview expansion when a folder closes so reopening starts at five rows again.
  useEffect(() => {
    setExpandedThreadListsByProject((current) =>
      pruneExpandedProjectThreadListsForCollapsedProjects({
        expandedProjectThreadListCwds: current,
        projects: standardProjects,
        normalizeProjectCwd: normalizeSidebarProjectThreadListCwd,
      }),
    );
  }, [standardProjects]);

  useEffect(() => {
    if (!shouldPrunePinnedThreads({ threadsHydrated })) {
      return;
    }
    prunePinnedThreads(sidebarThreads.map((thread) => thread.id));
  }, [prunePinnedThreads, sidebarThreads, threadsHydrated]);

  useEffect(() => {
    if (!threadsHydrated || persistedPinnedThreadIds.length === 0) {
      return;
    }

    // Older builds stored pins only in localStorage; mirror them to the server
    // projection so the retention job can protect those threads too.
    const threadsById = new Map(sidebarThreads.map((thread) => [thread.id, thread] as const));
    for (const threadId of persistedPinnedThreadIds) {
      const thread = threadsById.get(threadId);
      if (!thread || thread.isPinned === true) {
        continue;
      }
      void setThreadPinned(threadId, true).catch((error) => {
        console.error("Failed to migrate pinned thread state", {
          threadId,
          error,
        });
      });
    }
  }, [persistedPinnedThreadIds, setThreadPinned, sidebarThreads, threadsHydrated]);

  useEffect(() => {
    const retainedThreadIds = new Set(sidebarThreads.map((thread) => thread.id));
    setDismissedThreadStatusKeyByThreadId((current) => {
      const nextEntries = Object.entries(current).filter(([threadId]) =>
        retainedThreadIds.has(ThreadId.makeUnsafe(threadId)),
      );
      if (nextEntries.length === Object.keys(current).length) {
        return current;
      }
      return Object.fromEntries(nextEntries);
    });
  }, [sidebarThreads]);

  useEffect(() => {
    persistSidebarUiState({
      chatSectionExpanded,
      chatThreadListExpanded,
      expandedProjectThreadListCwds: [...expandedThreadListsByProject],
      dismissedThreadStatusKeyByThreadId,
      lastThreadRoute,
    });
  }, [
    chatSectionExpanded,
    chatThreadListExpanded,
    dismissedThreadStatusKeyByThreadId,
    expandedThreadListsByProject,
    lastThreadRoute,
  ]);

  useEffect(() => {
    if (isOnWorkspace || isOnSettings || routeThreadId === null) {
      return;
    }

    const nextLastThreadRoute = {
      threadId: routeThreadId,
      ...(routeSearch.splitViewId ? { splitViewId: routeSearch.splitViewId } : {}),
    };
    setLastThreadRoute((current) => {
      if (
        current?.threadId === nextLastThreadRoute.threadId &&
        current?.splitViewId === nextLastThreadRoute.splitViewId
      ) {
        return current;
      }
      return nextLastThreadRoute;
    });
  }, [isOnSettings, isOnWorkspace, routeSearch.splitViewId, routeThreadId]);

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
      sidebarThreadSummaryById[activeSidebarThreadId]?.parentThreadId ?? null;

    while (currentThreadId) {
      forcedExpandedParentIds.add(currentThreadId);
      currentThreadId = sidebarThreadSummaryById[currentThreadId]?.parentThreadId ?? null;
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
  }, [activeSidebarThreadId, sidebarThreadSummaryById]);

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

      if (threadId === routeThreadId && options?.canToggleSubagents && !routeSearch.splitViewId) {
        toggleSubagentParent(threadId);
        return;
      }

      activateThreadFromSidebarIntent(threadId);
    },
    [
      activateThreadFromSidebarIntent,
      rangeSelectTo,
      routeThreadId,
      routeSearch.splitViewId,
      toggleSubagentParent,
      toggleThreadSelection,
    ],
  );

  const visibleSidebarThreadIds = useMemo(() => {
    const visibleThreadIdSet = new Set<ThreadId>();
    const addVisibleThreadId = (threadId: ThreadId) => {
      visibleThreadIdSet.add(threadId);
    };

    for (const thread of pinnedThreads) {
      addVisibleThreadId(thread.id);
    }

    for (const project of standardProjects) {
      const projectSidebarData = standardProjectSidebarDataById.get(project.id);
      if (!projectSidebarData) {
        continue;
      }

      if (!project.expanded) {
        if (projectSidebarData.activeEntryId) {
          addVisibleThreadId(projectSidebarData.activeEntryId);
        }
        continue;
      }

      for (const entry of projectSidebarData.visibleEntries) {
        addVisibleThreadId(entry.rowId);
      }
    }

    return [...visibleThreadIdSet];
  }, [pinnedThreads, standardProjects, standardProjectSidebarDataById]);
  const visibleSidebarThreadIdSet = useMemo(
    () => new Set([...visibleSidebarThreadIds, ...visibleChatThreadIds]),
    [visibleChatThreadIds, visibleSidebarThreadIds],
  );
  const visibleSidebarThreads = useMemo(
    () => sidebarDisplayThreads.filter((thread) => visibleSidebarThreadIdSet.has(thread.id)),
    [sidebarDisplayThreads, visibleSidebarThreadIdSet],
  );
  // PR badges only render on visible rows, so keep git/PR query setup off hidden project history.
  const threadGitTargets = useMemo(
    () =>
      visibleSidebarThreads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        lastKnownPr: thread.lastKnownPr ?? null,
        cwd: resolveThreadWorkspaceCwd({
          projectCwd: projectCwdById.get(thread.projectId) ?? null,
          envMode: thread.envMode,
          worktreePath: thread.worktreePath,
        }),
      })),
    [projectCwdById, visibleSidebarThreads],
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
  const threadStoredPrTargets = useMemo(
    () =>
      threadGitTargets.flatMap((target) =>
        target.cwd !== null &&
        target.lastKnownPr !== null &&
        target.lastKnownPr.url.trim().length > 0
          ? [{ ...target, cwd: target.cwd, lastKnownPr: target.lastKnownPr }]
          : [],
      ),
    [threadGitTargets],
  );
  const threadStoredPrQueries = useQueries({
    queries: threadStoredPrTargets.map((target) => ({
      ...gitResolvePullRequestQueryOptions({
        cwd: target.cwd,
        reference: target.lastKnownPr.url,
      }),
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

    const storedPrByThreadId = new Map<ThreadId, ThreadPr>();
    for (let index = 0; index < threadStoredPrTargets.length; index += 1) {
      const target = threadStoredPrTargets[index];
      if (!target) {
        continue;
      }
      const result = threadStoredPrQueries[index]?.data?.pullRequest ?? null;
      if (result) {
        storedPrByThreadId.set(target.threadId, toThreadPr(result));
        continue;
      }
      storedPrByThreadId.set(target.threadId, toThreadPr(target.lastKnownPr));
    }

    const map = new Map<ThreadId, ThreadPr>();
    for (const target of threadGitTargets) {
      const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      const livePr = branchMatches ? (status?.pr ?? null) : null;
      map.set(target.threadId, livePr ?? storedPrByThreadId.get(target.threadId) ?? null);
    }
    return map;
  }, [
    threadGitStatusCwds,
    threadGitStatusQueries,
    threadGitTargets,
    threadStoredPrQueries,
    threadStoredPrTargets,
  ]);
  const isManualProjectSorting = appSettings.sidebarProjectSortOrder === "manual";
  const threadJumpCommandByThreadId = useMemo(() => {
    const mapping = new Map<ThreadId, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadId] of visibleSidebarThreadIds.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        break;
      }
      mapping.set(threadId, jumpCommand);
    }

    return mapping;
  }, [visibleSidebarThreadIds]);
  const threadJumpThreadIds = useMemo(
    () => [...threadJumpCommandByThreadId.keys()],
    [threadJumpCommandByThreadId],
  );
  const getCurrentSidebarShortcutContext = useCallback(
    () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen,
      terminalWorkspaceOpen,
    }),
    [terminalOpen, terminalWorkspaceOpen],
  );
  const [threadJumpLabelByThreadId, setThreadJumpLabelByThreadId] =
    useState<ReadonlyMap<ThreadId, string>>(EMPTY_THREAD_JUMP_LABELS);
  const threadJumpLabelsRef = useRef<ReadonlyMap<ThreadId, string>>(EMPTY_THREAD_JUMP_LABELS);
  threadJumpLabelsRef.current = threadJumpLabelByThreadId;
  const [showThreadJumpHints, setShowThreadJumpHints] = useState(false);
  const showThreadJumpHintsRef = useRef(false);
  showThreadJumpHintsRef.current = showThreadJumpHints;
  const visibleThreadJumpLabelByThreadId = showThreadJumpHints
    ? threadJumpLabelByThreadId
    : EMPTY_THREAD_JUMP_LABELS;
  const visibleThreadJumpLabelPartsByThreadId = useMemo(() => {
    const partsByThreadId = new Map<ThreadId, readonly string[]>();
    for (const [threadId, label] of visibleThreadJumpLabelByThreadId) {
      partsByThreadId.set(threadId, splitShortcutLabel(label));
    }
    return partsByThreadId;
  }, [visibleThreadJumpLabelByThreadId]);

  useEffect(() => {
    const threadIdsToPrewarm = getSidebarThreadIdsToPrewarm({
      visibleThreadIds: visibleSidebarThreadIds,
      activeThreadId: activeSidebarThreadId,
    });
    const releaseCallbacks = threadIdsToPrewarm.map((threadId) =>
      retainThreadDetailSubscription(threadId),
    );

    return () => {
      for (const release of releaseCallbacks) {
        release();
      }
    };
  }, [activeSidebarThreadId, visibleSidebarThreadIds]);

  // Keep hover actions in the same trailing slot used by the timestamp they replace.
  const handleConfirmArchive = useCallback(
    (threadId: ThreadId) => {
      void inlineConfirmArchiveThread(threadId);
    },
    [inlineConfirmArchiveThread],
  );

  function renderThreadHoverActions(input: {
    threadId: ThreadId;
    toneClassName: string;
    pinned: boolean;
    compact?: boolean;
  }) {
    return (
      <SidebarThreadHoverActions
        threadId={input.threadId}
        toneClassName={input.toneClassName}
        pinned={input.pinned}
        compact={input.compact}
        isPendingConfirmation={pendingArchiveConfirmationThreadId === input.threadId}
        onConfirmArchive={handleConfirmArchive}
        onRequestArchive={setPendingArchiveConfirmationThreadId}
        onTogglePin={toggleThreadPinned}
      />
    );
  }

  function renderPinnedThreadRow(thread: SidebarThreadSummary) {
    return (
      <SidebarPinnedThreadRow
        key={thread.id}
        thread={thread}
        projectLabel={resolvePinnedThreadProjectLabel(projectById, thread.projectId)}
        terminalStateByThreadId={terminalStateByThreadId}
        pendingArchiveConfirmationThreadId={pendingArchiveConfirmationThreadId}
        visualActiveSidebarThreadId={visualActiveSidebarThreadId}
        prByThreadId={prByThreadId}
        visibleThreadJumpLabelByThreadId={visibleThreadJumpLabelByThreadId}
        visibleThreadJumpLabelPartsByThreadId={visibleThreadJumpLabelPartsByThreadId}
        resolveThreadStatus={resolveThreadStatusForSidebar}
        onOpenPrLink={openPrLink}
        onPrimeThreadActivation={primeThreadActivation}
        onActivateThreadFromSidebarIntent={activateThreadFromSidebarIntent}
        onOpenRenameThreadDialog={openRenameThreadDialog}
        onThreadRenamePointerUp={handleThreadRenamePointerUp}
        onThreadContextMenu={handleThreadContextMenu}
        renderHoverActions={renderThreadHoverActions}
      />
    );
  }

  function renderThreadRow(
    thread: SidebarThreadSummary,
    orderedProjectThreadIds: readonly ThreadId[],
    depth = 0,
    childCount = 0,
    isExpanded = false,
  ) {
    return (
      <SidebarThreadRow
        key={thread.id}
        thread={thread}
        orderedProjectThreadIds={orderedProjectThreadIds}
        depth={depth}
        childCount={childCount}
        isExpanded={isExpanded}
        terminalStateByThreadId={terminalStateByThreadId}
        pendingArchiveConfirmationThreadId={pendingArchiveConfirmationThreadId}
        visualActiveSidebarThreadId={visualActiveSidebarThreadId}
        pinnedThreadIdSet={pinnedThreadIdSet}
        selectedThreadIds={selectedThreadIds}
        prByThreadId={prByThreadId}
        temporaryThreadIds={temporaryThreadIds}
        draftThreadsByThreadId={draftThreadsByThreadId}
        visibleThreadJumpLabelByThreadId={visibleThreadJumpLabelByThreadId}
        visibleThreadJumpLabelPartsByThreadId={visibleThreadJumpLabelPartsByThreadId}
        renamingThreadId={renamingThreadId}
        renamingTitle={renamingTitle}
        renamingInputRef={renamingInputRef}
        renamingCommittedRef={renamingCommittedRef}
        resolveThreadStatus={resolveThreadStatusForSidebar}
        onOpenPrLink={openPrLink}
        onThreadClick={handleThreadClick}
        onPrimeThreadActivation={primeThreadActivation}
        onOpenRenameThreadDialog={openRenameThreadDialog}
        onThreadRenamePointerUp={handleThreadRenamePointerUp}
        onActivateThreadFromSidebarIntent={activateThreadFromSidebarIntent}
        onMultiSelectContextMenu={handleMultiSelectContextMenu}
        onClearSelection={clearSelection}
        onThreadContextMenu={handleThreadContextMenu}
        onChangeRenamingTitle={setRenamingTitle}
        onCommitRename={commitRename}
        onCancelRename={cancelRename}
        onToggleSubagentParent={toggleSubagentParent}
        renderHoverActions={renderThreadHoverActions}
      />
    );
  }

  function renderChatItem(row: (typeof visibleChatThreadRows)[number]) {
    return renderThreadRow(
      row.thread,
      visibleChatThreadIds,
      row.depth,
      row.childCount,
      row.isExpanded,
    );
  }

  function renderProjectItem(
    project: (typeof sortedProjects)[number],
    dragHandleProps: SortableProjectHandleProps | null,
  ) {
    const projectSidebarData = standardProjectSidebarDataById.get(project.id);
    if (!projectSidebarData) {
      return null;
    }

    return (
      <SidebarProjectItem
        project={project}
        dragHandleProps={dragHandleProps}
        projectSidebarData={projectSidebarData}
        isManualProjectSorting={isManualProjectSorting}
        isRenamingProject={renamingProjectId === project.id}
        renamingProjectName={renamingProjectName}
        renamingProjectInputRef={renamingProjectInputRef}
        renamingProjectCommittedRef={renamingProjectCommittedRef}
        newTerminalThreadShortcutLabel={newTerminalThreadShortcutLabel}
        newThreadShortcutLabel={newThreadShortcutLabel}
        onProjectTitlePointerDownCapture={handleProjectTitlePointerDownCapture}
        onProjectTitleClick={handleProjectTitleClick}
        onProjectTitleKeyDown={handleProjectTitleKeyDown}
        onProjectContextMenu={handleProjectContextMenu}
        onChangeRenamingProjectName={setRenamingProjectName}
        onCommitProjectRename={commitProjectRename}
        onCancelProjectRename={cancelProjectRename}
        onCreateTerminalThread={handleCreateTerminalThreadInProject}
        onCreateDisposableThread={handleCreateDisposableThreadInProject}
        onCreateThread={handleCreateThreadInProject}
        onExpandThreadList={expandThreadListForProject}
        onCollapseThreadList={collapseThreadListForProject}
        renderThreadRow={renderThreadRow}
      />
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

  useSidebarKeybindings({
    keybindings,
    homeDir,
    searchPaletteMode,
    threadJumpCommandByThreadId,
    threadJumpThreadIds,
    visibleSidebarThreadIds,
    activeSidebarThreadId,
    showThreadJumpHintsRef,
    threadJumpLabelsRef,
    getCurrentSidebarShortcutContext,
    activateThreadFromSidebarIntent,
    setSearchPaletteMode,
    setSearchPaletteOpen,
    setSearchPaletteInitialQuery,
    setThreadJumpLabelByThreadId,
    setShowThreadJumpHints,
  });

  const {
    showDesktopUpdateButton,
    desktopUpdateTooltip,
    desktopUpdateButtonDisabled,
    desktopUpdateButtonAction,
    desktopUpdateButtonPresentation,
    showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription,
    desktopUpdateRowButtonClasses,
    handleDesktopUpdateButtonClick,
  } = useSidebarDesktopUpdate();
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    shortcutLabelForCommand(keybindings, "chat.newLatestProject");
  const newChatShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newChat") ??
    shortcutLabelForCommand(keybindings, "chat.newLocal");
  const newTerminalThreadShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newTerminal");
  const searchShortcutLabel =
    shortcutLabelForCommand(keybindings, "sidebar.search") ??
    (isMacPlatform(navigator.platform) ? "⌘K" : "Ctrl+K");
  const importThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "sidebar.importThread") ??
    (isMacPlatform(navigator.platform) ? "⌘I" : "Ctrl+I");
  const addProjectShortcutLabel =
    shortcutLabelForCommand(keybindings, "sidebar.addProject") ??
    (isMacPlatform(navigator.platform) ? "⇧⌘O" : "Ctrl+Shift+O");
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
  const searchPaletteActions = useMemo<SidebarSearchAction[]>(
    () => [
      {
        id: "new-chat",
        label: "New chat",
        description: "Open the new chat landing screen.",
        keywords: ["chat", "new", "home"],
        shortcutLabel: newChatShortcutLabel,
      },
      {
        id: "new-thread",
        label: "New thread",
        description: "Start a fresh thread in the current project.",
        keywords: ["thread", "new", "project"],
        shortcutLabel: newThreadShortcutLabel,
      },
      {
        id: "add-project",
        label: "Add project",
        description: "Open a repository or folder in the sidebar.",
        keywords: ["folder", "repo", "repository", "open"],
        shortcutLabel: addProjectShortcutLabel,
      },
      {
        id: "import-thread",
        label: "Import thread from...",
        description: "Attach a local thread to an existing provider session.",
        keywords: [
          "import",
          "resume",
          "thread",
          "session",
          "codex",
          "claude",
          "cursor",
          "opencode",
        ],
        shortcutLabel: importThreadShortcutLabel,
      },
      {
        id: "settings",
        label: "Settings",
        description: "Open app settings.",
        keywords: ["preferences", "config"],
      },
    ],
    [
      addProjectShortcutLabel,
      importThreadShortcutLabel,
      newChatShortcutLabel,
      newThreadShortcutLabel,
    ],
  );
  const handleOpenPullRequestReference = useCallback(
    (reference: string) => {
      const cwd = currentProjectShortcutTargetId
        ? (projectCwdById.get(currentProjectShortcutTargetId) ?? null)
        : null;
      void navigate({
        to: "/review/$reference",
        params: { reference },
        ...(cwd ? { search: { cwd } } : {}),
      });
    },
    [currentProjectShortcutTargetId, navigate, projectCwdById],
  );

  const expandThreadListForProject = useCallback((projectCwd: string) => {
    const cwdKey = normalizeSidebarProjectThreadListCwd(projectCwd);
    if (cwdKey.length === 0) return;
    setExpandedThreadListsByProject((current) => {
      if (current.has(cwdKey)) return current;
      const next = new Set(current);
      next.add(cwdKey);
      return next;
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectCwd: string) => {
    const cwdKey = normalizeSidebarProjectThreadListCwd(projectCwd);
    if (cwdKey.length === 0) return;
    setExpandedThreadListsByProject((current) => {
      if (!current.has(cwdKey)) return current;
      const next = new Set(current);
      next.delete(cwdKey);
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

  const titlebarControls = (
    <div className="hidden shrink-0 items-center gap-0.5 md:flex">
      <SidebarTrigger
        className="size-7 shrink-0 text-muted-foreground/75 hover:text-foreground"
        aria-label="Toggle thread sidebar"
      />
      <AppNavigationButtons className="ms-0" />
    </div>
  );

  const headerControls = (
    <div className="ml-auto hidden shrink-0 items-center gap-0.5 md:flex">
      <SidebarTrigger
        className="size-7 shrink-0 text-muted-foreground/75 hover:text-foreground"
        aria-label="Toggle thread sidebar"
      />
      <AppNavigationButtons className="ms-0" />
    </div>
  );

  const wordmark = (
    <div className="flex w-full items-center gap-1.5">
      <SidebarTrigger className="shrink-0 md:hidden" />
      {headerControls}
    </div>
  );

  return (
    <>
      {isElectron ? (
        <>
          <SidebarHeader
            className={cn(
              "drag-region flex-row items-center gap-2 px-4 py-0 font-system-ui",
              CHAT_SURFACE_HEADER_HEIGHT_CLASS,
              appSettings.sidebarSide === "left" && DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS,
            )}
          >
            {titlebarControls}
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
          <SidebarGroup className="p-0">
            <SettingsSidebarNav
              activeSection={activeSettingsSection}
              onBack={() => handleSidebarViewChange("threads")}
              onSelectSection={(section) => {
                void navigate({
                  to: "/settings",
                  search: (previous) => ({
                    ...previous,
                    section: section === "general" ? undefined : section,
                  }),
                });
              }}
            />
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
                      icon={NewThreadIcon}
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
                      icon={GitPullRequestIcon}
                      label="Reviews"
                      active={isOnReview}
                      onClick={() => void navigate({ to: "/review" })}
                    />
                  </>
                )}
              </SidebarMenu>
            </SidebarGroup>

            {isOnWorkspace ? (
              <SidebarGroup className="px-1.5 pt-1 pb-1.5">
                <div className="my-2 h-px w-full bg-border" />
                <div className="mb-1.5 flex items-center px-2">
                  <span className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>Workspace</span>
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
                                    className="h-7 w-full rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] px-2 text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)] outline-none focus:border-[color:var(--color-border-focus)]"
                                  />
                                </div>
                              ) : (
                                <>
                                  <SidebarMenuButton
                                    size="sm"
                                    isActive={isActive}
                                    className="h-8 gap-2 rounded-lg pl-2 pr-8 font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-foreground/89 transition-colors hover:bg-[var(--sidebar-accent)] data-[active=true]:bg-[var(--sidebar-accent-active)] data-[active=true]:text-[var(--sidebar-accent-foreground)]"
                                    onClick={() => {
                                      navigateToWorkspace(workspace.id);
                                    }}
                                    onContextMenu={(event) => {
                                      event.preventDefault();
                                      beginWorkspaceRename(workspace.id, workspace.title);
                                    }}
                                  >
                                    <SidebarLeadingIcon
                                      ref={dragHandleProps.setActivatorNodeRef}
                                      {...dragHandleProps.attributes}
                                      {...dragHandleProps.listeners}
                                      size="sm"
                                      tone="text-muted-foreground/65"
                                      className="cursor-grab active:cursor-grabbing"
                                    >
                                      <SidebarGlyph icon={TerminalIcon} variant="chrome" />
                                    </SidebarLeadingIcon>
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
                                      <span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] tabular-nums text-muted-foreground/70">
                                        {workspace.terminalCount}
                                      </span>
                                    )}
                                  </SidebarMenuButton>
                                  <SidebarIconButton
                                    icon={Trash2}
                                    label="Delete workspace"
                                    glyph="meta"
                                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/70 opacity-0 transition-opacity group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleDeleteWorkspace(workspace.id);
                                    }}
                                  />
                                </>
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
                    <div className="my-1 flex items-center justify-between px-2 py-1">
                      <span className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>Pinned</span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {pinnedThreads.map((thread) => renderPinnedThreadRow(thread))}
                    </div>
                    <div className="-mx-1.5 my-1.5 h-px bg-border/70" />
                  </>
                ) : null}
                <div className="my-1 flex items-center justify-between px-2 py-1">
                  <span className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>Threads</span>
                  <SidebarSectionToolbar>
                    {standardProjects.length > 0 ? (
                      <SidebarIconButton
                        icon={allProjectsExpanded ? TbArrowsDiagonalMinimize2 : TbArrowsDiagonal}
                        label={
                          allProjectsExpanded
                            ? focusedProjectId
                              ? "Collapse all projects except the active project"
                              : "Collapse all projects"
                            : "Expand all projects"
                        }
                        className="disabled:cursor-default disabled:opacity-45"
                        onClick={handleToggleProjects}
                        tooltip={
                          allProjectsExpanded
                            ? focusedProjectId
                              ? "Collapse all projects except the active chat's project"
                              : "Collapse all projects"
                            : "Expand all projects"
                        }
                        tooltipSide="bottom"
                      />
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
                    <SidebarIconButton
                      icon={FiPlus}
                      label={shouldShowProjectPathEntry ? "Cancel add project" : "Add project"}
                      aria-pressed={shouldShowProjectPathEntry}
                      onClick={handleStartAddProject}
                      tooltip={shouldShowProjectPathEntry ? "Cancel add project" : "Add project"}
                      tooltipSide="right"
                    />
                  </SidebarSectionToolbar>
                </div>

                {shouldShowProjectPathEntry && (
                  <div className="mb-2.5 px-1">
                    {!showManualPathInput ? (
                      <div className="flex gap-1.5">
                        {isElectron && (
                          <button
                            type="button"
                            className="flex h-8 flex-1 items-center justify-center gap-2 rounded-lg bg-[var(--color-background-elevated-secondary)] px-2 text-[length:var(--app-font-size-ui,12px)] font-normal text-[var(--color-text-foreground-secondary)] transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-50"
                            onClick={() => void handlePickFolder()}
                            disabled={isPickingFolder || isAddingProject}
                          >
                            <SidebarGlyph icon={FolderIcon} variant="chrome" />
                            {isPickingFolder
                              ? "Opening..."
                              : isAddingProject
                                ? "Adding..."
                                : "Browse"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="flex h-8 flex-1 items-center justify-center gap-2 rounded-lg bg-[var(--color-background-elevated-secondary)] px-2 text-[length:var(--app-font-size-ui,12px)] font-normal text-[var(--color-text-foreground-secondary)] transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]"
                          onClick={() => setShowManualPathInput(true)}
                        >
                          <SidebarGlyph icon={TbCursorText} variant="chrome" />
                          Type path
                        </button>
                      </div>
                    ) : (
                      <div
                        className={`flex items-center rounded-lg border bg-[var(--color-background-control-opaque)] transition-colors ${
                          addProjectError
                            ? "border-red-500/70 focus-within:border-red-500"
                            : "border-[color:var(--color-border)] focus-within:border-[color:var(--color-border-focus)]"
                        }`}
                      >
                        <input
                          ref={addProjectInputRef}
                          className="min-w-0 flex-1 bg-transparent pl-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
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
                          className="shrink-0 px-2.5 py-1.5 text-xs font-medium text-muted-foreground/70 transition-colors hover:text-foreground disabled:opacity-40"
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
                        {standardProjects.map((project) => (
                          <SortableProjectItem key={project.id} projectId={project.id}>
                            {(dragHandleProps) => renderProjectItem(project, dragHandleProps)}
                          </SortableProjectItem>
                        ))}
                      </SortableContext>
                    </SidebarMenu>
                  </DndContext>
                ) : (
                  <SidebarMenu ref={attachProjectListAutoAnimateRef} className="gap-3">
                    {standardProjects.map((project) => (
                      <SidebarMenuItem key={project.id} className="rounded-md">
                        {renderProjectItem(project, null)}
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                )}

                {projectEmptyState === "loading" && (
                  <div
                    className="space-y-2 px-2 pt-4"
                    aria-live="polite"
                    aria-label="Loading projects"
                  >
                    <div className="text-center text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/70">
                      Loading projects...
                    </div>
                    <div className="mx-auto grid w-full max-w-42 gap-1.5 opacity-70">
                      <div className="h-2 rounded-full bg-muted/55 animate-pulse" />
                      <div className="mx-auto h-2 w-4/5 rounded-full bg-muted/40 animate-pulse" />
                      <div className="mx-auto h-2 w-3/5 rounded-full bg-muted/30 animate-pulse" />
                    </div>
                  </div>
                )}

                {projectEmptyState === "empty" && (
                  <div className="px-2 pt-4 text-center text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/70">
                    No projects yet
                  </div>
                )}
              </SidebarGroup>
            )}
          </>
        )}
      </SidebarContent>

      <SidebarFooter className="gap-2 p-2 font-system-ui">
        {!isOnSettings ? (
          <div className="group/collapsible">
            <div className="group/project-header relative">
              <SidebarMenuButton
                size="sm"
                className={cn(
                  SIDEBAR_HEADER_ROW_CLASS_NAME,
                  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
                  SIDEBAR_ROW_HOVER_CLASS_NAME,
                  "cursor-pointer",
                )}
                onClick={() => setChatSectionExpanded((current) => !current)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  setChatSectionExpanded((current) => !current);
                }}
              >
                <SidebarLeadingIcon size="sm">
                  <SidebarGlyph icon={BsChat} variant="chrome" />
                </SidebarLeadingIcon>
                <div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
                  <span className="truncate font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/79">
                    Chats
                  </span>
                </div>
              </SidebarMenuButton>
              <SidebarSectionToolbar placement="overlay">
                <ChatSortMenu
                  threadSortOrder={appSettings.sidebarThreadSortOrder}
                  onThreadSortOrderChange={(sortOrder) => {
                    updateSettings({ sidebarThreadSortOrder: sortOrder });
                  }}
                />
                <SidebarIconButton
                  icon={NewThreadIcon}
                  label="Open new chat home"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleCreateHomeChat();
                  }}
                  tooltip="New chat"
                  tooltipSide="top"
                />
              </SidebarSectionToolbar>
            </div>

            <div className={cn(disclosureShellClassName(chatSectionExpanded), "pt-1")}>
              <div className={DISCLOSURE_INNER_CLASS}>
                <SidebarMenu
                  className={cn("gap-1", disclosureContentClassName(chatSectionExpanded))}
                >
                  {visibleChatThreadRows.length > 0 ? (
                    renderedChatEntries.map((entry) => renderChatItem(entry.row))
                  ) : (
                    <div className="px-2 py-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/70">
                      No chats yet
                    </div>
                  )}
                  {hasHiddenChatThreads && !chatThreadListExpanded ? (
                    <SidebarMenuItem className="w-full">
                      <SidebarMenuButton
                        size="sm"
                        className="h-7 w-full justify-start rounded-lg pr-2 pl-8 text-left text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/79 hover:bg-[var(--sidebar-accent)]"
                        onClick={() => setChatThreadListExpanded(true)}
                      >
                        <span>Show more</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ) : null}
                  {hasHiddenChatThreads && chatThreadListExpanded ? (
                    <SidebarMenuItem className="w-full">
                      <SidebarMenuButton
                        size="sm"
                        className="h-7 w-full justify-start rounded-lg pr-2 pl-8 text-left text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/79 hover:bg-[var(--sidebar-accent)]"
                        onClick={() => setChatThreadListExpanded(false)}
                      >
                        <span>Show less</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ) : null}
                </SidebarMenu>
              </div>
            </div>
          </div>
        ) : null}
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex flex-col gap-1">
              {DebugFeatureFlagsMenu && showDebugFeatureFlagsMenu && !isOnSettings ? (
                <Suspense fallback={null}>
                  <DebugFeatureFlagsMenu />
                </Suspense>
              ) : null}
              <div className="flex items-center gap-2">
                {!isOnSettings && (
                  <SidebarMenuButton
                    size="sm"
                    className={cn(
                      SIDEBAR_HEADER_ROW_CLASS_NAME,
                      SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
                      SIDEBAR_ROW_HOVER_CLASS_NAME,
                      "flex-1",
                    )}
                    onClick={() => void navigate({ to: "/settings" })}
                  >
                    <SidebarLeadingIcon size="sm">
                      <SidebarGlyph icon={SettingsIcon} variant="leading" />
                    </SidebarLeadingIcon>
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
                          <span className="flex min-w-0 flex-1 items-center justify-between gap-1.5 leading-tight">
                            <span className="min-w-0 truncate text-center text-[10px] font-semibold">
                              {desktopUpdateButtonPresentation.label}
                            </span>
                            {desktopUpdateButtonPresentation.secondaryLabel ? (
                              <span className="min-w-0 truncate text-center text-[9px] text-white/80">
                                {desktopUpdateButtonPresentation.secondaryLabel}
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
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <RenameThreadDialog
        open={renameDialogThreadId !== null}
        currentTitle={
          renameDialogThreadId ? (sidebarThreadSummaryById[renameDialogThreadId]?.title ?? "") : ""
        }
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setRenameDialogThreadId(null);
        }}
        onSave={(newTitle) => {
          if (renameDialogThreadId === null) return;
          const target = sidebarThreadSummaryById[renameDialogThreadId];
          if (!target) return;
          void commitRename(target.id, newTitle, target.title);
        }}
      />

      {searchPaletteOpen ? (
        <SidebarSearchPaletteController
          open={searchPaletteOpen}
          mode={searchPaletteMode}
          initialBrowseQuery={searchPaletteInitialQuery}
          onModeChange={setSearchPaletteMode}
          onOpenChange={(open) => {
            setSearchPaletteOpen(open);
            if (!open) {
              setSearchPaletteMode("search");
              setSearchPaletteInitialQuery(null);
            }
          }}
          actions={searchPaletteActions}
          projects={searchPaletteProjects}
          projectById={projectById}
          onCreateChat={() => void handleCreateHomeChat()}
          onCreateThread={handlePrimaryNewThread}
          onAddProjectPath={addProjectFromPath}
          homeDir={homeDir}
          onOpenSettings={() => {
            void navigate({ to: "/settings" });
          }}
          onOpenProject={handleOpenProjectFromSearch}
          onOpenPullRequestReference={handleOpenPullRequestReference}
          onImportThread={handleImportThread}
          onOpenThread={(threadId) => {
            activateThreadFromSidebarIntent(ThreadId.makeUnsafe(threadId));
          }}
        />
      ) : null}
    </>
  );
}
