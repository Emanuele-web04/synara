// FILE: Sidebar.tsx
// Purpose: Renders the project/thread sidebar, including row status, sorting, and thread actions.
// Exports: Sidebar

import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  GitMergedSimpleIcon,
  GitPullRequestIcon,
  DisposableThreadIcon,
  type LucideIcon,
  NewThreadIcon,
  SearchIcon,
  SettingsIcon,
  TerminalIcon,
  Trash2,
  TriangleAlertIcon,
} from "~/lib/icons";
import { autoAnimate } from "@formkit/auto-animate";
import { FiGitBranch, FiPlus } from "react-icons/fi";
import { GoRepoForked } from "react-icons/go";
import { HiOutlineArchiveBox } from "react-icons/hi2";
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
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  type DesktopUpdateState,
  type OrchestrationShellSnapshot,
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
import { isMacPlatform, newCommandId, newProjectId, newThreadId, randomUUID } from "../lib/utils";
import { persistAppStateNow, useStore } from "../store";
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
import {
  ProviderAvatarWithTerminal,
  ThreadPrStatusBadge,
  ThreadStatusTrailingGlyph,
  WorktreeBadgeGlyph,
} from "./Sidebar.icons";
import { ChatSortMenu, ProjectSortMenu, SidebarPrimaryAction } from "./Sidebar.menus";
import { SidebarSegmentedPicker } from "./Sidebar.picker";
import { SidebarSubagentLabel } from "./Sidebar.subagent";
import { SidebarSearchPaletteController } from "./Sidebar.searchController";
import { useSidebarThreadActions } from "./useSidebarThreadActions";
import { useSidebarKeybindings } from "./useSidebarKeybindings";
import { useSidebarContextMenus } from "./useSidebarContextMenus";
import {
  type SortableProjectHandleProps,
  SortableProjectItem,
  SortableWorkspaceItem,
} from "./Sidebar.sortable";
import { AppNavigationButtons } from "./AppNavigationButtons";
import { ProjectSidebarIcon } from "./ProjectSidebarIcon";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import { SidebarMetaChipStack } from "./SidebarMetaChip";
import { SidebarRowHoverActions } from "./SidebarRowHoverActions";
import { SidebarSectionToolbar } from "./SidebarSectionToolbar";
import { SidebarGlyph } from "./sidebarGlyphs";
import { ThreadPinToggleButton } from "./ThreadPinToggleButton";
import { RenameThreadDialog } from "./RenameThreadDialog";
import { terminalRuntimeRegistry } from "./terminal/terminalRuntimeRegistry";
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
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateAlreadyCurrentNotice,
  getDesktopUpdateButtonPresentation,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateButtonVariant,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Kbd, KbdGroup } from "./ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarTrigger,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { isNonEmpty as isNonEmptyString } from "effect/String";
import {
  describeAddProjectError,
  buildProjectThreadTree,
  deriveSidebarProjectData,
  extractDuplicateProjectCreateProjectId,
  findWorkspaceRootMatch,
  getFallbackThreadIdAfterDelete,
  getPinnedThreadsForSidebar,
  getNextVisibleSidebarThreadId,
  getSidebarThreadIdsToPrewarm,
  getVisibleSidebarEntriesForPreview,
  groupSidebarThreadsByProjectId,
  pruneExpandedProjectThreadListsForCollapsedProjects,
  recoverExistingAddProjectTarget,
  DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY,
  EMPTY_THREAD_JUMP_LABELS,
  buildThreadJumpLabelMap,
  formatRelativeTime,
  prStatusIndicator,
  readDebugFeatureFlagsMenuVisibility,
  resolveSplitPreviewTitle,
  resolveWorktreeBadgeLabel,
  terminalStatusFromThreadState,
  threadJumpLabelMapsEqual,
  threadStatusSlotClassName,
  toThreadPr,
  type PrStatusIndicator,
  type TerminalStatusIndicator,
  type ThreadPr,
  resolveProjectEmptyState,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClassName,
  resolveThreadRowTrailingReserveClass,
  resolveThreadStatusPill,
  type ThreadStatusPill,
  isDuplicateProjectCreateError,
  type SidebarDerivedProjectData,
  shouldShowDebugFeatureFlagsMenu,
  shouldPrunePinnedThreads,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic";
import { resolveRestorableThreadRoute, type LastThreadRoute } from "../chatRouteRestore";
import { resolveSubagentPresentationForThread } from "../lib/subagentPresentation";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS } from "~/hooks/useDesktopTopBarGutter";
import { cn } from "~/lib/utils";
import {
  disclosureContentClassName,
  disclosureShellClassName,
  DISCLOSURE_INNER_CLASS,
} from "~/lib/disclosureMotion";
import { getInitialBrowseQuery } from "~/lib/projectPaths";
import {
  canCreateThreadHandoff,
  resolveAvailableHandoffTargetProviders,
  resolveThreadHandoffBadgeLabel,
} from "../lib/threadHandoff";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useDiffRouteSearch } from "../hooks/useDiffRouteSearch";
import { normalizeSettingsSection } from "../settingsNavigation";
import {
  SIDEBAR_HEADER_LABEL_CLASS_NAME,
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
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
import { THREAD_DRAG_MIME } from "./chat-drop-overlay/ChatPaneDropOverlay";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useThreadActivationController } from "../hooks/useThreadActivationController";
import { usePinnedThreadsStore } from "../pinnedThreadsStore";
import { retainThreadDetailSubscription } from "../threadDetailSubscriptionRetention";
import { useWorkspaceStore, workspaceThreadId } from "../workspaceStore";
import type { SidebarSearchAction, SidebarSearchProject } from "./SidebarSearchPalette.logic";
import { useFocusedChatContext } from "../focusedChatContext";
import { showContextMenuFallback } from "../contextMenuFallback";
import {
  waitForRecoverableProjectForDuplicateCreate,
  waitForRecoverableProjectInReadModel,
} from "../lib/projectCreateRecovery";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const THREAD_PREVIEW_LIMIT = 5;
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;
export { formatRelativeTime } from "./Sidebar.logic";
const EMPTY_SHORTCUT_PARTS: readonly string[] = [];
const ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS = 6;
const ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS = 50;
const THREAD_INTENT_PREWARM_RELEASE_MS = 10_000;
const ADD_PROJECT_EXISTING_SYNC_ERROR =
  "This folder is already linked, but the existing project has not synced into the sidebar yet. Try again in a moment.";
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

type ThreadMetaChip = {
  id: "handoff" | "fork" | "sidechat" | "worktree";
  tooltip: string;
  icon: ReactNode;
};

/**
 * Back-to-front order: first = behind, last = in front.
 * Priority lowest -> highest: handoff -> fork/sidechat -> worktree.
 */
function resolveThreadRowMetaChips(input: {
  thread: Pick<
    Thread,
    "forkSourceThreadId" | "sidechatSourceThreadId" | "envMode" | "worktreePath" | "handoff"
  >;
  includeHandoffBadge: boolean;
  /**
   * When the leading provider avatar already renders the source → target handoff
   * pair, the trailing handoff chip is a redundant double icon and is dropped.
   */
  handoffShownInAvatar?: boolean;
}): ThreadMetaChip[] {
  const chips: ThreadMetaChip[] = [];

  const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(input.thread);
  if (input.includeHandoffBadge && !input.handoffShownInAvatar && handoffBadgeLabel) {
    chips.push({
      id: "handoff",
      tooltip: handoffBadgeLabel,
      icon: <SidebarGlyph icon={FiGitBranch} variant="meta" className="text-muted-foreground/70" />,
    });
  }

  if (input.thread.forkSourceThreadId) {
    chips.push({
      id: "fork",
      tooltip: "Forked thread",
      icon: (
        <SidebarGlyph
          icon={GoRepoForked}
          variant="meta"
          className="text-emerald-600 dark:text-emerald-300/90"
        />
      ),
    });
  }

  if (input.thread.sidechatSourceThreadId) {
    chips.push({
      id: "sidechat",
      tooltip: "Sidechat",
      icon: <DisposableThreadIcon className="text-sky-600 dark:text-sky-300/90" />,
    });
  }

  const worktreeBadgeLabel = resolveWorktreeBadgeLabel(input.thread);
  if (worktreeBadgeLabel) {
    chips.push({
      id: "worktree",
      tooltip: worktreeBadgeLabel,
      icon: <WorktreeBadgeGlyph className="text-muted-foreground/70" />,
    });
  }

  return chips;
}

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
  const createWorkspace = useWorkspaceStore((store) => store.createWorkspace);
  const renameWorkspace = useWorkspaceStore((store) => store.renameWorkspace);
  const deleteWorkspace = useWorkspaceStore((store) => store.deleteWorkspace);
  const reorderWorkspace = useWorkspaceStore((store) => store.reorderWorkspace);
  const homeDir = useWorkspaceStore((store) => store.homeDir);
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
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [searchPaletteMode, setSearchPaletteMode] = useState<SidebarSearchPaletteMode>("search");
  const [searchPaletteInitialQuery, setSearchPaletteInitialQuery] = useState<string | null>(null);
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
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const intentThreadRetentionByIdRef = useRef(
    new Map<ThreadId, { release: () => void; timeoutId: number }>(),
  );
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

  const openOrCreateProjectThreadFromSnapshot = useCallback(
    async (projectId: ProjectId, snapshot: OrchestrationShellSnapshot) => {
      const latestThread = sortThreadsForSidebar(
        snapshot.threads
          .filter(
            (thread) => thread.projectId === projectId && (thread.archivedAt ?? null) === null,
          )
          .map((thread) => ({
            id: thread.id,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            latestUserMessageAt: thread.latestUserMessageAt,
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

      void handleNewThread(projectId, {
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
    async (projectId: ProjectId, snapshot: OrchestrationShellSnapshot): Promise<boolean> => {
      const existingProject =
        snapshot.projects.find((candidate) => candidate.id === projectId) ?? null;
      if (!existingProject) {
        return false;
      }

      const latestThread = sortThreadsForSidebar(
        snapshot.threads
          .filter(
            (thread) => thread.projectId === projectId && (thread.archivedAt ?? null) === null,
          )
          .map((thread) => ({
            id: thread.id,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            latestUserMessageAt: thread.latestUserMessageAt,
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
      void handleNewThread(projectId, {
        envMode: appSettings.defaultThreadEnvMode,
      }).catch(() => undefined);
      return true;
    },
    [
      appSettings.defaultThreadEnvMode,
      appSettings.sidebarThreadSortOrder,
      handleNewThread,
      navigate,
      setProjectExpanded,
    ],
  );

  // Poll the server read model briefly after project.create so we only recover from fresh state.
  const waitForProjectInSnapshot = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      projectId: ProjectId,
    ): Promise<{
      project: OrchestrationShellSnapshot["projects"][number] | null;
      snapshot: OrchestrationShellSnapshot | null;
    }> =>
      waitForRecoverableProjectInReadModel({
        projectId,
        loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
        maxAttempts: ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS,
        delayMs: ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS,
      }),
    [],
  );

  const waitForProjectWorkspaceRootInSnapshot = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      workspaceRoot: string,
    ): Promise<{
      project: OrchestrationShellSnapshot["projects"][number] | null;
      snapshot: OrchestrationShellSnapshot | null;
    }> =>
      waitForRecoverableProjectInReadModel({
        workspaceRoot,
        loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
        maxAttempts: ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS,
        delayMs: ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS,
      }),
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
        syncServerShellSnapshot(snapshot);
      }
      if (!project || !snapshot) {
        return false;
      }

      await openOrCreateProjectThreadFromSnapshot(project.id, snapshot);
      return true;
    },
    [openOrCreateProjectThreadFromSnapshot, syncServerShellSnapshot, waitForProjectInSnapshot],
  );

  const recoverExistingProjectFromServer = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      projectId: ProjectId,
    ): Promise<boolean> => {
      const { project, snapshot } = await waitForProjectInSnapshot(api, projectId);
      if (snapshot) {
        syncServerShellSnapshot(snapshot);
      }
      if (!project || !snapshot) {
        return false;
      }

      return openExistingProjectFromSnapshot(project.id, snapshot);
    },
    [openExistingProjectFromSnapshot, syncServerShellSnapshot, waitForProjectInSnapshot],
  );

  const recoverExistingProjectByWorkspaceRootFromServer = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      workspaceRoot: string,
    ): Promise<boolean> => {
      const { project, snapshot } = await waitForProjectWorkspaceRootInSnapshot(api, workspaceRoot);
      if (snapshot) {
        syncServerShellSnapshot(snapshot);
      }
      if (!project || !snapshot) {
        return false;
      }

      return openExistingProjectFromSnapshot(project.id, snapshot);
    },
    [
      openExistingProjectFromSnapshot,
      syncServerShellSnapshot,
      waitForProjectWorkspaceRootInSnapshot,
    ],
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

  const handleCreateWorkspace = useCallback(() => {
    const workspaceId = createWorkspace();
    navigateToWorkspace(workspaceId);
  }, [createWorkspace, navigateToWorkspace]);

  useEffect(() => {
    if (!homeDir) {
      return;
    }
    prewarmHomeChatProject(homeDir);
  }, [homeDir]);

  // Opens a fresh home-chat draft directly on the draft thread route so the first send
  // does not need a second route swap from "/" to "/$threadId".
  const handleCreateHomeChat = useCallback(async () => {
    await handleNewChat({ fresh: true });
  }, [handleNewChat]);

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
        terminalRuntimeRegistry.disposeThread(workspaceThread);
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
    async (rawCwd: string, options: { createIfMissing?: boolean } = {}) => {
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

      try {
        const existing = findWorkspaceRootMatch(projects, cwd, (project) => project.cwd);
        const existingRecovery = await recoverExistingAddProjectTarget({
          existingProjectId: existing?.id,
          workspaceRoot: cwd,
          recoverByProjectId: (projectId) => recoverExistingProjectFromServer(api, projectId),
          recoverByWorkspaceRoot: (workspaceRoot) =>
            recoverExistingProjectByWorkspaceRootFromServer(api, workspaceRoot),
        });
        if (existingRecovery === "recovered") {
          finishAddingProject();
          return;
        }
        if (existing) {
          // Local project state can briefly outlive a server-side project.deleted event.
          // Continue to project.create so re-adding the folder revives it instead of opening a dead shell.
        }

        const projectId = newProjectId();
        const createdAt = new Date().toISOString();
        const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          kind: "project",
          title,
          workspaceRoot: cwd,
          createWorkspaceRootIfMissing: options.createIfMissing === true,
          defaultModelSelection: {
            provider: "codex",
            model: getDefaultModel("codex"),
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
        void handleNewThread(projectId, {
          envMode: appSettings.defaultThreadEnvMode,
        }).catch(() => undefined);
        finishAddingProject();
        return;
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        if (isDuplicateProjectCreateError(description)) {
          try {
            const { project, snapshot } = await waitForRecoverableProjectForDuplicateCreate({
              message: description,
              workspaceRoot: cwd,
              loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
              maxAttempts: ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS,
              delayMs: ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS,
            });
            if (snapshot) {
              syncServerShellSnapshot(snapshot);
            }
            if (project && snapshot) {
              const recovered = await openExistingProjectFromSnapshot(project.id, snapshot);
              if (recovered) {
                finishAddingProject();
                return;
              }
            }

            const duplicateProjectId = extractDuplicateProjectCreateProjectId(description);
            const recovered = duplicateProjectId
              ? await recoverExistingProjectFromServer(
                  api,
                  ProjectId.makeUnsafe(duplicateProjectId),
                )
              : await recoverExistingProjectByWorkspaceRootFromServer(api, cwd);
            if (recovered) {
              finishAddingProject();
              return;
            }

            setIsAddingProject(false);
            throw new Error(ADD_PROJECT_EXISTING_SYNC_ERROR);
          } catch (recoveryError) {
            setIsAddingProject(false);
            throw recoveryError;
          }
        }
        setIsAddingProject(false);
        throw error instanceof Error ? error : new Error(description);
      }
    },
    [
      appSettings.defaultThreadEnvMode,
      handleNewThread,
      isAddingProject,
      projects,
      recoverExistingProjectFromServer,
      recoverExistingProjectByWorkspaceRootFromServer,
      recoverProjectThreadFromServer,
      openExistingProjectFromSnapshot,
      setProjectExpanded,
      syncServerShellSnapshot,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd, { createIfMissing: true }).catch((error: unknown) => {
      const description =
        error instanceof Error ? error.message : "An error occurred while adding the project.";
      setAddProjectError(description);
    });
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
        await addProjectFromPath(pickedPath).catch((error: unknown) => {
          const description =
            error instanceof Error ? error.message : "An error occurred while adding the project.";
          setAddProjectError(description);
          toastManager.add({
            type: "error",
            title: "Unable to add project",
            description,
          });
        });
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

  const sortedProjects = useMemo(
    () => sortProjectsForSidebar(projects, sidebarThreads, appSettings.sidebarProjectSortOrder),
    [appSettings.sidebarProjectSortOrder, projects, sidebarThreads],
  );
  const chatProjects = useMemo(
    () => sortedProjects.filter((project) => isHomeChatContainerProject(project, homeDir)),
    [homeDir, sortedProjects],
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
        (project) => project.kind === "project" && !isHomeChatContainerProject(project, homeDir),
      ),
    [homeDir, sortedProjects],
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

  // Pinned rows should show the user-facing project label, not the raw folder basename.
  function resolvePinnedThreadProjectLabel(projectId: ProjectId): string | null {
    const project = projectById.get(projectId);
    if (!project) return null;
    return project.name ?? project.folderName ?? null;
  }

  // Keep hover actions in the same trailing slot used by the timestamp they replace.
  function renderThreadArchiveAction(
    threadId: ThreadId,
    toneClassName: string,
    options?: {
      compact?: boolean;
    },
  ) {
    const compact = options?.compact === true;
    const isPendingConfirmation = pendingArchiveConfirmationThreadId === threadId;

    if (isPendingConfirmation) {
      return (
        <button
          type="button"
          aria-label="Confirm archive"
          title="Confirm archive"
          className={cn(
            "pointer-events-auto inline-flex h-5 items-center rounded-full px-2.5 text-[10px] font-normal leading-none tracking-[-0.01em] opacity-100 transition-colors",
            "bg-red-400/12 text-red-400 hover:bg-red-400/16 hover:text-red-300",
            "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-red-400/45",
            compact ? "h-4.5 px-1.5 text-[10px]" : undefined,
          )}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void inlineConfirmArchiveThread(threadId);
          }}
        >
          <span>Confirm</span>
        </button>
      );
    }

    return (
      <SidebarIconButton
        icon={HiOutlineArchiveBox}
        label="Archive thread"
        title="Archive thread"
        data-testid={`thread-archive-${threadId}`}
        size={compact ? "sm" : "md"}
        glyph={compact ? "compact" : "meta"}
        className={cn("hover:text-foreground/89", toneClassName)}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setPendingArchiveConfirmationThreadId(threadId);
        }}
      />
    );
  }

  function renderThreadHoverActions(input: {
    threadId: ThreadId;
    toneClassName: string;
    pinned: boolean;
    compact?: boolean;
  }) {
    const compact = input.compact === true;
    const isPendingConfirmation = pendingArchiveConfirmationThreadId === input.threadId;

    return (
      <SidebarRowHoverActions threadId={input.threadId} pinnedVisible={isPendingConfirmation}>
        {isPendingConfirmation ? (
          <button
            type="button"
            aria-label="Confirm archive"
            title="Confirm archive"
            className={cn(
              "pointer-events-auto inline-flex h-5 items-center rounded-full px-2.5 text-[10px] font-normal leading-none tracking-[-0.01em] opacity-100 transition-colors",
              "bg-red-400/12 text-red-400 hover:bg-red-400/16 hover:text-red-300",
              "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-red-400/45",
              compact ? "h-4.5 px-1.5 text-[10px]" : undefined,
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void inlineConfirmArchiveThread(input.threadId);
            }}
          >
            <span>Confirm</span>
          </button>
        ) : (
          <div className="pointer-events-auto inline-flex items-center gap-1">
            <ThreadPinToggleButton
              pinned={input.pinned}
              presentation="inline"
              toneClassName={input.toneClassName}
              onToggle={(event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleThreadPinned(input.threadId);
              }}
            />
            {renderThreadArchiveAction(input.threadId, input.toneClassName, {
              compact,
            })}
          </div>
        )}
      </SidebarRowHoverActions>
    );
  }

  function renderPinnedThreadRow(thread: SidebarThreadSummary) {
    const threadTerminalState = selectThreadTerminalState(terminalStateByThreadId, thread.id);
    const threadEntryPoint = threadTerminalState.entryPoint;
    const terminalStatus = terminalStatusFromThreadState({
      runningTerminalIds: threadTerminalState.runningTerminalIds,
      terminalAttentionStatesById: threadTerminalState.terminalAttentionStatesById,
    });
    const terminalCount = threadTerminalState.terminalIds.length;
    const isPendingArchiveConfirmation = pendingArchiveConfirmationThreadId === thread.id;
    const isActive = visualActiveSidebarThreadId === thread.id;
    const projectLabel = resolvePinnedThreadProjectLabel(thread.projectId);
    const rightMetaChips = resolveThreadRowMetaChips({
      thread,
      includeHandoffBadge: true,
      handoffShownInAvatar:
        threadEntryPoint !== "terminal" &&
        !isGenericChatThreadTitle(thread.title) &&
        Boolean(thread.handoff?.sourceProvider),
    });
    const threadStatus = resolveThreadStatusForSidebar(thread);
    const isSubagentThread = Boolean(thread.parentThreadId);
    const prStatus = prStatusIndicator(prByThreadId.get(thread.id) ?? null);
    const leadingPrStatus =
      isSubagentThread || thread.forkSourceThreadId || thread.sidechatSourceThreadId
        ? null
        : prStatus;
    const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(thread);
    const threadJumpLabel = visibleThreadJumpLabelByThreadId.get(thread.id) ?? null;
    const threadJumpLabelParts =
      visibleThreadJumpLabelPartsByThreadId.get(thread.id) ?? EMPTY_SHORTCUT_PARTS;
    const showThreadProviderAvatar = !isGenericChatThreadTitle(thread.title);
    const showThreadIdentityGlyph = threadEntryPoint === "terminal" || showThreadProviderAvatar;
    const secondaryMetaClass = isActive
      ? "text-foreground/72 dark:text-foreground/78"
      : "text-muted-foreground/70";
    const pinnedTimestampClassName = isSubagentThread
      ? "mr-1 w-[1.2rem] text-right text-[10px] leading-none tabular-nums text-muted-foreground/62 transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0"
      : "mr-1 w-[1.625rem] text-right text-[length:var(--app-font-size-ui-meta,11px)] leading-none tabular-nums text-muted-foreground/70 transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0";

    return (
      <div key={thread.id} className="group/thread-row relative w-full opacity-85">
        {leadingPrStatus ? (
          <ThreadPrStatusBadge
            prStatus={leadingPrStatus}
            onOpen={openPrLink}
            className="absolute left-1.5 top-1/2 z-20 size-5 -translate-y-1/2"
          />
        ) : null}
        <div
          role="button"
          tabIndex={0}
          data-thread-item
          className={cn(
            SIDEBAR_HEADER_ROW_CLASS_NAME,
            "grid w-full items-center gap-x-1.5 transition-colors",
            leadingPrStatus && "pl-8",
            showThreadIdentityGlyph
              ? "grid-cols-[auto_minmax(0,1fr)_auto_3.5rem]"
              : "grid-cols-[minmax(0,1fr)_auto_3.5rem]",
            isActive
              ? SIDEBAR_ROW_ACTIVE_CLASS_NAME
              : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
          )}
          onPointerDown={(event) => primeThreadActivation(event, thread.id)}
          onClick={() => activateThreadFromSidebarIntent(thread.id)}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openRenameThreadDialog(thread.id);
          }}
          onPointerUp={(event) => handleThreadRenamePointerUp(event, thread.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              activateThreadFromSidebarIntent(thread.id);
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            void handleThreadContextMenu(thread.id, {
              x: event.clientX,
              y: event.clientY,
            });
          }}
        >
          {threadEntryPoint === "terminal" ? (
            <SidebarGlyph icon={TerminalIcon} variant="chrome" className="text-teal-600/85" />
          ) : showThreadProviderAvatar ? (
            <ProviderAvatarWithTerminal
              provider={thread.session?.provider ?? thread.modelSelection.provider}
              handoffSourceProvider={thread.handoff?.sourceProvider ?? null}
              handoffTooltip={handoffBadgeLabel}
              terminalStatus={terminalStatus}
              terminalCount={terminalCount}
            />
          ) : null}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className="min-w-0 flex-1 truncate"
                    data-testid={`thread-title-${thread.id}`}
                  >
                    {isSubagentThread ? (
                      <SidebarSubagentLabel
                        threadId={thread.id}
                        parentThreadId={thread.parentThreadId}
                        agentId={thread.subagentAgentId}
                        nickname={thread.subagentNickname}
                        role={thread.subagentRole}
                        title={thread.title}
                      />
                    ) : (
                      thread.title
                    )}
                  </span>
                }
              />
              <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
                {thread.title}
              </TooltipPopup>
            </Tooltip>
            {!isSubagentThread && threadStatus?.label === "Pending Approval" ? (
              <span
                aria-label="Pending approval"
                className={cn("shrink-0 text-[10px] font-medium", threadStatus.colorClass)}
              >
                Pending
              </span>
            ) : null}
          </div>
          {/* Keep pinned rows on stable columns even when badges/timestamps differ. */}
          <div className="flex min-w-0 max-w-[3rem] shrink items-center justify-end">
            {projectLabel ? (
              <span className="truncate text-right text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/70">
                {projectLabel}
              </span>
            ) : null}
          </div>
          <div className="flex w-14 shrink-0 items-center justify-end">
            <div className="relative flex shrink-0 items-center justify-end gap-1">
              {!isPendingArchiveConfirmation ? (
                <SidebarMetaChipStack chips={rightMetaChips} />
              ) : null}
              {!isPendingArchiveConfirmation && threadJumpLabel ? (
                <KbdGroup>
                  {threadJumpLabelParts.map((part) => (
                    <Kbd key={part}>{part}</Kbd>
                  ))}
                </KbdGroup>
              ) : null}
              {!isPendingArchiveConfirmation && !threadJumpLabel ? (
                threadStatus ? (
                  <span className={threadStatusSlotClassName(isSubagentThread)}>
                    <ThreadStatusTrailingGlyph threadStatus={threadStatus} />
                  </span>
                ) : (
                  <span className={pinnedTimestampClassName}>
                    {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
                  </span>
                )
              ) : null}
              {renderThreadHoverActions({
                threadId: thread.id,
                toneClassName: "text-muted-foreground/70",
                pinned: true,
                compact: isSubagentThread,
              })}
            </div>
          </div>
        </div>
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
    const isPendingArchiveConfirmation = pendingArchiveConfirmationThreadId === thread.id;
    const isActive = visualActiveSidebarThreadId === thread.id;
    const isPinned = pinnedThreadIdSet.has(thread.id);
    const isSelected = selectedThreadIds.has(thread.id);
    const isHighlighted = isActive || isSelected;
    const threadStatus = resolveThreadStatusForSidebar(thread);
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
      ? "text-foreground/72 dark:text-foreground/78"
      : "text-muted-foreground/70";
    const rightMetaChips = resolveThreadRowMetaChips({
      thread,
      includeHandoffBadge: !isDisposableThread,
      handoffShownInAvatar:
        threadEntryPoint !== "terminal" &&
        !isGenericChatThreadTitle(thread.title) &&
        Boolean(thread.handoff?.sourceProvider),
    });
    const isSubagentThread = Boolean(thread.parentThreadId);
    const leadingPrStatus =
      isSubagentThread || thread.forkSourceThreadId || thread.sidechatSourceThreadId
        ? null
        : prStatus;
    const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(thread);
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
        })
      : null;
    const canToggleSubagents = childCount > 0;
    const subagentIndentPx = Math.max(0, Math.min(depth - 1, 3) * 10);
    const showCompactMeta = !isSubagentThread;
    const threadJumpLabel = visibleThreadJumpLabelByThreadId.get(thread.id) ?? null;
    const threadJumpLabelParts =
      visibleThreadJumpLabelPartsByThreadId.get(thread.id) ?? EMPTY_SHORTCUT_PARTS;
    // Untouched draft chat threads are intentionally text-only until they get a real title.
    const showThreadProviderAvatar = !isGenericChatThreadTitle(thread.title);
    const childCountLabel = `${childCount} subagent${childCount === 1 ? "" : "s"}`;
    const trailingTimestampClassName = isSubagentThread
      ? cn(
          "mr-1 w-[1.2rem] text-right text-[10px] leading-none tabular-nums tracking-[-0.01em] transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
          isHighlighted ? "text-foreground/70 dark:text-foreground/72" : "text-muted-foreground/75",
        )
      : cn(
          "mr-1 w-[1.625rem] text-right text-[length:var(--app-font-size-ui-meta,11px)] leading-none tabular-nums transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
          secondaryMetaClass,
        );
    const toggleButtonClassName = isHighlighted
      ? "border-[color:var(--color-border)] bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]"
      : "border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] text-[var(--color-text-foreground-secondary)] hover:border-[color:var(--color-border)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]";

    return (
      <SidebarMenuSubItem
        key={thread.id}
        className="group/thread-row w-full opacity-85"
        data-thread-item
      >
        {leadingPrStatus ? (
          <ThreadPrStatusBadge
            prStatus={leadingPrStatus}
            onOpen={openPrLink}
            className="absolute left-1.5 top-1/2 z-20 size-5 -translate-y-1/2"
          />
        ) : null}
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
            leadingPrStatus && "pl-8",
            isSubagentThread
              ? "pr-7.5"
              : resolveThreadRowTrailingReserveClass(showCompactMeta ? rightMetaChips.length : 0),
          )}
          draggable={renamingThreadId !== thread.id}
          onDragStart={(event) => {
            const dragImage = event.currentTarget as HTMLElement | null;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(THREAD_DRAG_MIME, JSON.stringify({ threadId: thread.id }));
            if (dragImage) {
              const rect = dragImage.getBoundingClientRect();
              event.dataTransfer.setDragImage(
                dragImage,
                Math.max(0, event.clientX - rect.left),
                Math.max(0, event.clientY - rect.top),
              );
            }
          }}
          onClick={(event) => {
            handleThreadClick(event, thread.id, orderedProjectThreadIds, {
              isActive,
              canToggleSubagents,
            });
          }}
          onPointerDown={(event) => primeThreadActivation(event, thread.id)}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openRenameThreadDialog(thread.id);
          }}
          onPointerUp={(event) => handleThreadRenamePointerUp(event, thread.id)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            activateThreadFromSidebarIntent(thread.id);
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
            <SidebarGlyph icon={TerminalIcon} variant="chrome" className="text-teal-600/85" />
          ) : showThreadProviderAvatar ? (
            <ProviderAvatarWithTerminal
              provider={thread.session?.provider ?? thread.modelSelection.provider}
              handoffSourceProvider={thread.handoff?.sourceProvider ?? null}
              handoffTooltip={handoffBadgeLabel}
              terminalStatus={terminalStatus}
              terminalCount={terminalCount}
            />
          ) : null}
          <div
            className={cn(
              "flex min-w-0 flex-1 items-center text-left",
              isSubagentThread ? "gap-[5px]" : "gap-1.5",
            )}
          >
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
                  "min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)]",
                  // Inactive thread names sit at 92% foreground so they read
                  // clearly without competing with the active row, which still
                  // pops via the row background and full-foreground color from
                  // resolveThreadRowClassName.
                  isActive ? "text-foreground" : "text-foreground/92",
                  isSubagentThread ? "leading-[18px] text-foreground/80" : "leading-5",
                )}
              >
                {isSubagentThread ? (
                  <SidebarSubagentLabel
                    threadId={thread.id}
                    parentThreadId={thread.parentThreadId}
                    agentId={thread.subagentAgentId}
                    nickname={thread.subagentNickname}
                    role={thread.subagentRole}
                    title={thread.title}
                    roleClassName="text-muted-foreground/70"
                  />
                ) : (
                  thread.title
                )}
              </span>
            )}
            {!isSubagentThread && threadStatus?.label === "Pending Approval" ? (
              <span
                aria-label="Pending approval"
                className={cn("shrink-0 text-[10px] font-medium", threadStatus.colorClass)}
              >
                Pending
              </span>
            ) : null}
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
                  <SidebarGlyph icon={ChevronDownIcon} variant="chevron" />
                ) : (
                  <SidebarGlyph icon={ChevronRightIcon} variant="chevron" />
                )}
              </button>
            ) : null}
            {showCompactMeta && isDisposableThread ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex shrink-0 items-center text-muted-foreground/70">
                      <DisposableThreadIcon />
                    </span>
                  }
                />
                <TooltipPopup side="top">Disposable chat</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
          <div className={cn("absolute top-1/2 flex -translate-y-1/2 items-center", "right-1.5")}>
            <div className="relative flex shrink-0 items-center justify-end gap-1">
              {showCompactMeta && !isPendingArchiveConfirmation && rightMetaChips.length > 0 ? (
                <SidebarMetaChipStack chips={rightMetaChips} />
              ) : null}
              {!isPendingArchiveConfirmation && threadJumpLabel ? (
                <KbdGroup>
                  {threadJumpLabelParts.map((part) => (
                    <Kbd key={part}>{part}</Kbd>
                  ))}
                </KbdGroup>
              ) : null}
              {!isPendingArchiveConfirmation && !threadJumpLabel ? (
                threadStatus ? (
                  <span className={threadStatusSlotClassName(isSubagentThread)}>
                    <ThreadStatusTrailingGlyph threadStatus={threadStatus} />
                  </span>
                ) : (
                  <span className={trailingTimestampClassName}>
                    {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
                  </span>
                )
              ) : null}
              {renderThreadHoverActions({
                threadId: thread.id,
                toneClassName: secondaryMetaClass,
                pinned: isPinned,
                compact: isSubagentThread,
              })}
            </div>
          </div>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
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
    const isRenamingProject = renamingProjectId === project.id;
    const projectSidebarData = standardProjectSidebarDataById.get(project.id);
    if (!projectSidebarData) {
      return null;
    }
    const {
      orderedProjectThreadIds,
      projectStatus,
      visibleEntries,
      hasHiddenThreads,
      isThreadListExpanded,
    } = projectSidebarData;

    return (
      <div className="group/collapsible">
        <div className="group/project-header relative">
          <SidebarMenuButton
            ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
            size="sm"
            className={cn(
              SIDEBAR_HEADER_ROW_CLASS_NAME,
              "transition-[padding] duration-150 ease-out hover:bg-[var(--sidebar-accent)] group-hover/project-header:bg-[var(--sidebar-accent)] group-hover/project-header:pr-[4.75rem] group-hover/project-header:text-[var(--sidebar-accent-foreground)] group-focus-within/project-header:pr-[4.75rem]",
              isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
            )}
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
            <SidebarLeadingIcon size="sm">
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
            </SidebarLeadingIcon>
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
                  <span className="truncate font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/79">
                    {project.name}
                  </span>
                  {project.localName ? (
                    <span className="shrink-0 truncate text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/70">
                      {project.folderName}
                    </span>
                  ) : null}
                </>
              )}
            </div>
          </SidebarMenuButton>
          <SidebarSectionToolbar placement="overlay" revealOnHover>
            <SidebarIconButton
              icon={TerminalIcon}
              label={`Create new terminal thread in ${project.name}`}
              tooltip={
                newTerminalThreadShortcutLabel
                  ? `New terminal thread (${newTerminalThreadShortcutLabel})`
                  : "New terminal thread"
              }
              tooltipSide="top"
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
            />
            <SidebarIconButton
              icon={DisposableThreadIcon}
              glyph="chromeLu"
              label={`Create disposable thread in ${project.name}`}
              tooltip="New disposable thread"
              tooltipSide="top"
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
            />
            <SidebarIconButton
              icon={NewThreadIcon}
              label={`Create new thread in ${project.name}`}
              tooltip={
                newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"
              }
              tooltipSide="top"
              data-testid="new-thread-button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void handleNewThread(project.id, {
                  envMode: resolveSidebarNewThreadEnvMode({
                    defaultEnvMode: appSettings.defaultThreadEnvMode,
                  }),
                });
              }}
            />
          </SidebarSectionToolbar>
        </div>

        <div
          className={cn(
            disclosureShellClassName(project.expanded),
            SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME,
          )}
        >
          <div className={DISCLOSURE_INNER_CLASS}>
            <SidebarMenuSub
              className={cn(
                "mx-0 my-0 w-full translate-x-0 border-l-0 px-0 py-0",
                SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
                disclosureContentClassName(project.expanded),
              )}
            >
              {visibleEntries.map((entry) =>
                renderThreadRow(
                  entry.thread,
                  orderedProjectThreadIds,
                  entry.depth,
                  entry.childCount,
                  entry.isExpanded,
                ),
              )}

              {hasHiddenThreads && !isThreadListExpanded && (
                <SidebarMenuSubItem className="w-full">
                  <SidebarMenuSubButton
                    render={<button type="button" />}
                    data-thread-selection-safe
                    size="sm"
                    className="h-7 w-full translate-x-0 justify-start rounded-lg pr-2 pl-8 text-left text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/79 hover:bg-[var(--sidebar-accent)]"
                    onClick={() => {
                      expandThreadListForProject(project.cwd);
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
                    className="h-7 w-full translate-x-0 justify-start rounded-lg pr-2 pl-8 text-left text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/79 hover:bg-[var(--sidebar-accent)]"
                    onClick={() => {
                      collapseThreadListForProject(project.cwd);
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
  const desktopUpdateButtonVariant = getDesktopUpdateButtonVariant(desktopUpdateState, {
    installing: installingDesktopUpdate,
  });
  const desktopUpdateButtonClasses =
    desktopUpdateButtonVariant === "installing" || desktopUpdateButtonVariant === "progress"
      ? "bg-sky-500 hover:bg-sky-600"
      : desktopUpdateButtonVariant === "ready"
        ? "bg-emerald-500 hover:bg-emerald-600"
        : desktopUpdateButtonVariant === "error"
          ? "bg-rose-500 hover:bg-rose-600"
          : "bg-[var(--info)] hover:brightness-110";
  const desktopUpdateButtonHasSecondaryLabel =
    desktopUpdateButtonPresentation.secondaryLabel !== null;
  const desktopUpdateRowButtonClasses = cn(
    "inline-flex shrink-0 items-center justify-between gap-2 rounded-full px-2.5 text-center text-white transition-colors",
    desktopUpdateButtonHasSecondaryLabel ? "min-h-6 py-1" : "h-6",
    desktopUpdateButtonInteractivityClasses,
    desktopUpdateButtonClasses,
  );
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
              description: `Synara ${nextState.currentVersion} is already the newest version.`,
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
          const alreadyCurrentNotice = getDesktopUpdateAlreadyCurrentNotice(result);
          if (alreadyCurrentNotice) {
            toastManager.add({
              type: "info",
              title: "Already up to date",
              description: alreadyCurrentNotice,
            });
            return;
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
      persistAppStateNow();
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateState(result.state);
          setInstallingDesktopUpdate(false);
          const alreadyCurrentNotice = getDesktopUpdateAlreadyCurrentNotice(result);
          if (alreadyCurrentNotice) {
            toastManager.add({
              type: "info",
              title: "Already up to date",
              description: alreadyCurrentNotice,
            });
            return;
          }
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
