// FILE: Sidebar.tsx
// Purpose: Renders the project/thread sidebar, including row status, sorting, and thread actions.
// Exports: Sidebar

import {
  ArchiveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  DisposableThreadIcon,
  ExternalLinkIcon,
  FolderIcon,
  FolderOpenIcon,
  GitMergedSimpleIcon,
  GitPullRequestIcon,
  KanbanIcon,
  type LucideIcon,
  NewThreadIcon,
  PencilIcon,
  PinIcon,
  PlayIcon,
  SearchIcon,
  SettingsIcon,
  StopFilledIcon,
  TerminalIcon,
  Trash2,
  TriangleAlertIcon,
  WorktreeIcon,
  XIcon,
} from "~/lib/icons";
import { ensureNativeApi } from "~/nativeApi";
import { autoAnimate } from "@formkit/auto-animate";
import { FiGitBranch, FiPlus } from "react-icons/fi";
import { GoRepoForked } from "react-icons/go";
import { HiOutlineArchiveBox, HiOutlineCheckCircle } from "react-icons/hi2";
import { BsChat } from "react-icons/bs";
import { TbArrowsDiagonal, TbArrowsDiagonalMinimize2, TbCursorText } from "react-icons/tb";
import { IoFilter } from "react-icons/io5";
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
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  type AutomationListResult,
  MAX_PINNED_PROJECTS,
  type DesktopUpdateState,
  type OrchestrationShellSnapshot,
  PROVIDER_DISPLAY_NAMES,
  ProjectId,
  type ProviderKind,
  ThreadId,
  type GitStatusResult,
  type ProjectDiscoveredScriptTarget,
  type ResolvedKeybindingsConfig,
  type ServerLocalServerProcess,
} from "@t3tools/contracts";
import { isGenericChatThreadTitle } from "@t3tools/shared/chatThreads";
import { getDefaultModel } from "@t3tools/shared/model";
import { pluralize } from "@t3tools/shared/text";
import { localServerAddressLabel, localServerMatchesRun } from "@t3tools/shared/localServers";
import { resolveThreadWorkspaceCwd } from "@t3tools/shared/threadEnvironment";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
  useAppSettings,
} from "../appSettings";
import { isElectron } from "../env";
import { showConfirmDialogFallback } from "../confirmDialogFallback";
import { formatRelativeTime } from "../lib/relativeTime";
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
  createAllThreadsSelector,
  createSidebarDisplayThreadsSelector,
  createSidebarThreadSummariesSelector,
  createThreadSelector,
} from "../storeSelectors";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import {
  gitRemoveWorktreeMutationOptions,
  gitResolvePullRequestQueryOptions,
  gitStatusQueryOptions,
} from "../lib/gitReactQuery";
import {
  providerComposerCapabilitiesQueryOptions,
  supportsThreadImport,
} from "../lib/providerDiscoveryReactQuery";
import { resolveCurrentProjectTargetId } from "../lib/projectShortcutTargets";
import { projectDiscoverScriptsQueryOptions } from "../lib/projectReactQuery";
import {
  LOCAL_SERVERS_BACKGROUND_REFETCH_INTERVAL_MS,
  LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS,
  serverConfigQueryOptions,
  serverLocalServersQueryOptions,
  serverQueryKeys,
} from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { isHomeChatContainerProject, prewarmHomeChatProject } from "../lib/chatProjects";
import { useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadEnvironmentPresentation } from "../lib/threadEnvironment";
import { dispatchThreadRename } from "../lib/threadRename";
import { quotePosixShellArgument } from "../lib/shellQuote";
import { DEFAULT_THREAD_TERMINAL_ID, type SidebarThreadSummary, type Thread } from "../types";
import { applyAutomationEvent, automationQueryKey } from "../routes/-automations.shared";
import { shouldRenderTerminalWorkspace } from "./ChatView.logic";
import { CHAT_SURFACE_HEADER_HEIGHT_CLASS } from "./chat/chatHeaderControls";
import { ProviderIcon } from "./ProviderIcon";
import { SidebarLeadingControls } from "./SidebarHeaderNavigationControls";
import { ProjectSidebarIcon } from "./ProjectSidebarIcon";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import { SidebarMetaChipStack } from "./SidebarMetaChip";
import { SidebarRowHoverActions } from "./SidebarRowHoverActions";
import { SidebarSectionToolbar } from "./SidebarSectionToolbar";
import { SidebarGlyph, sidebarGlyphClass } from "./sidebarGlyphs";
import { ThreadPinToggleButton } from "./ThreadPinToggleButton";
import { ThreadRunningSpinner } from "./ThreadRunningSpinner";
import { RenameDialog } from "./RenameDialog";
import { RenameThreadDialog } from "./RenameThreadDialog";
import { terminalRuntimeRegistry } from "./terminal/terminalRuntimeRegistry";
import {
  SidebarSearchPalette,
  type ImportProviderKind,
  type SidebarSearchPaletteMode,
} from "./SidebarSearchPalette";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useThreadHandoff } from "../hooks/useThreadHandoff";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useProjectRunStore, type ProjectRunState } from "../projectRunStore";
import {
  selectPrimaryProjectRunCommand,
  upsertProjectRunCommandScripts,
} from "../projectRunTargets";
import { projectScriptRuntimeEnv } from "../projectScripts";
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
  getDesktopUpdateErrorSignature,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Kbd, KbdGroup } from "./ui/kbd";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
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
  buildSettingsBackAvailableThreadIds,
  buildProjectThreadTree,
  derivePinnedProjectIdsForSidebar,
  deriveSidebarProjectData,
  derivePinnedThreadIdsForSidebar,
  extractDuplicateProjectCreateProjectId,
  findDeepestWorkspaceRootMatch,
  findWorkspaceRootMatch,
  getFallbackThreadIdAfterDelete,
  getPinnedThreadsForSidebar,
  orderPinnedProjectsForSidebar,
  getNextVisibleSidebarThreadId,
  getSidebarThreadIdsToPrewarm,
  getVisibleSidebarEntriesForPreview,
  groupSidebarThreadsByProjectId,
  isLatestPinnedProjectMutation,
  isLatestPinnedThreadMutation,
  pruneExpandedProjectThreadListsForCollapsedProjects,
  recoverExistingAddProjectTarget,
  DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY,
  resolveProjectEmptyState,
  resolveSettingsBackTarget,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClassName,
  resolveThreadRowTrailingReserveClass,
  resolveThreadStatusPill,
  type ThreadStatusPill,
  isDuplicateProjectCreateError,
  type SidebarDerivedProjectData,
  shouldShowDebugFeatureFlagsMenu,
  resolvePrStatePresentation,
  shouldPrunePinnedThreads,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic";
import type { LastThreadRoute } from "../chatRouteRestore";
import { resolveSubagentPresentationForThread } from "../lib/subagentPresentation";
import { useCopyPathToClipboard, useCopyThreadIdToClipboard } from "~/hooks/useCopyToClipboard";
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
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
} from "../sidebarRowStyles";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import { SIDEBAR_SEGMENTED_PICKER_ACTIVE_CLASS_NAME } from "./chat/composerPickerStyles";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import {
  resolveSplitViewFocusedThreadId,
  resolveSplitViewPaneIdForThread,
  selectSplitView,
  useSplitViewStore,
} from "../splitViewStore";
import { THREAD_DRAG_MIME } from "./chat-drop-overlay/ChatPaneDropOverlay";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useThreadActivationController } from "../hooks/useThreadActivationController";
import { usePinnedProjectsStore } from "../pinnedProjectsStore";
import { usePinnedThreadsStore } from "../pinnedThreadsStore";
import { useThreadDetailPrewarm } from "../threadDetailPrewarm";
import { retainThreadDetailSubscription } from "../threadDetailSubscriptionRetention";
import { useWorkspaceStore, workspaceThreadId } from "../workspaceStore";
import type {
  SidebarSearchAction,
  SidebarSearchProject,
  SidebarSearchThread,
} from "./SidebarSearchPalette.logic";
import { useFocusedChatContext } from "../focusedChatContext";
import {
  waitForRecoverableProjectForDuplicateCreate,
  waitForRecoverableProjectInReadModel,
} from "../lib/projectCreateRecovery";

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
const EMPTY_THREAD_JUMP_LABELS = new Map<ThreadId, string>();
const EMPTY_SHORTCUT_PARTS: readonly string[] = [];
const ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS = 6;
const ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS = 50;
const ADD_PROJECT_EXISTING_SYNC_ERROR =
  "This folder is already linked, but the existing project has not synced into the sidebar yet. Try again in a moment.";
const DebugFeatureFlagsMenu = import.meta.env.DEV
  ? lazy(() =>
      import("./DebugFeatureFlagsMenu").then((module) => ({
        default: module.DebugFeatureFlagsMenu,
      })),
    )
  : null;

type ProjectContextMenuId =
  | "open-in-finder"
  | "open-in-kanban"
  | "copy-path"
  | "start-dev"
  | "stop-dev"
  | "open-dev-server"
  | "rename"
  | "toggle-pin"
  | "archive-threads"
  | "delete-threads"
  | "delete";

type ProjectContextMenuState = {
  projectId: ProjectId;
  position: { x: number; y: number };
};

const PROJECT_CONTEXT_MENU_PANEL_CLASS_NAME = "w-48 min-w-48";
const PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME =
  "text-[var(--color-text-foreground)] data-highlighted:text-[var(--color-text-foreground)]";
const PROJECT_CONTEXT_MENU_ICON_CLASS_NAME =
  "inline-flex size-3.5 shrink-0 items-center justify-center text-[var(--color-text-foreground-secondary)] [&>svg]:size-3.5 [&>[data-slot=central-icon]]:size-3.5";

// Gives Base UI a zero-size virtual anchor exactly where the right-click happened.
function createClientPointMenuAnchor(position: { x: number; y: number }) {
  return {
    getBoundingClientRect: () => ({
      x: position.x,
      y: position.y,
      width: 0,
      height: 0,
      top: position.y,
      right: position.x,
      bottom: position.y,
      left: position.x,
    }),
  };
}

function ProjectContextMenuIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className={PROJECT_CONTEXT_MENU_ICON_CLASS_NAME}>
      <Icon aria-hidden="true" />
    </span>
  );
}

function firstLocalServerUrl(server: ServerLocalServerProcess): string | null {
  return server.addresses.find((address) => address.url)?.url ?? null;
}

function findTrackedProjectRunServer(
  run: ProjectRunState | null | undefined,
  servers: readonly ServerLocalServerProcess[],
): ServerLocalServerProcess | null {
  if (!run) {
    return null;
  }
  return servers.find((server) => localServerMatchesRun(server, run)) ?? null;
}

type DebugFeatureFlagsWindow = Window & {
  synaraShowFeatureFlags?: () => void;
  synaraHideFeatureFlags?: () => void;
  dpcodeShowFeatureFlags?: () => void;
  dpcodeHideFeatureFlags?: () => void;
};

function readDebugFeatureFlagsMenuVisibility(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return shouldShowDebugFeatureFlagsMenu({
      isDev: import.meta.env.DEV,
      hostname: window.location.hostname,
      storageValue: window.localStorage.getItem(DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY),
    });
  } catch {
    return false;
  }
}

function threadJumpLabelMapsEqual(
  left: ReadonlyMap<ThreadId, string>,
  right: ReadonlyMap<ThreadId, string>,
): boolean {
  if (left === right) {
    return true;
  }
  if (left.size !== right.size) {
    return false;
  }
  for (const [threadId, label] of left) {
    if (right.get(threadId) !== label) {
      return false;
    }
  }
  return true;
}

// Resolve the visible numbered-thread hints from the active keybinding config.
function buildThreadJumpLabelMap(input: {
  keybindings: ResolvedKeybindingsConfig;
  platform: string;
  terminalOpen: boolean;
  threadJumpCommandByThreadId: ReadonlyMap<
    ThreadId,
    NonNullable<ReturnType<typeof threadJumpCommandForIndex>>
  >;
}): ReadonlyMap<ThreadId, string> {
  if (input.threadJumpCommandByThreadId.size === 0) {
    return EMPTY_THREAD_JUMP_LABELS;
  }

  const shortcutLabelOptions = {
    platform: input.platform,
    context: {
      terminalFocus: false,
      terminalOpen: input.terminalOpen,
    },
  } as const;
  const mapping = new Map<ThreadId, string>();
  for (const [threadId, command] of input.threadJumpCommandByThreadId) {
    const label = shortcutLabelForCommand(input.keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(threadId, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_THREAD_JUMP_LABELS;
}
function WorktreeBadgeGlyph({ className }: { className?: string }) {
  return <WorktreeIcon aria-hidden="true" className={sidebarGlyphClass("meta", className)} />;
}

// Trailing status indicator shown in the timestamp slot: spinner while working,
// check when completed, otherwise a colored status dot. Replaces the relative
// timestamp whenever the thread has an active/unseen status.
function ThreadStatusTrailingGlyph({ threadStatus }: { threadStatus: ThreadStatusPill }) {
  if (threadStatus.label === "Completed") {
    return (
      <HiOutlineCheckCircle
        aria-hidden="true"
        className={cn("size-3.5 shrink-0", threadStatus.colorClass)}
      />
    );
  }
  if (threadStatus.pulse) {
    return <ThreadRunningSpinner />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn("size-1.5 shrink-0 rounded-full", threadStatus.dotClass)}
    />
  );
}

/** Pulsing green dot shown before a thread or project name while a dev run is live. */
function ProjectRunIndicatorDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      title="Dev server running"
      className={cn(
        "size-1.5 shrink-0 rounded-full bg-emerald-400 motion-safe:animate-pulse",
        className,
      )}
    />
  );
}

/** Meta chips fade on row hover so pin/archive actions can occupy the same slot. */
const THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME =
  "flex shrink-0 items-center transition-opacity group-hover/thread-row:pointer-events-none group-hover/thread-row:opacity-0 group-focus-within/thread-row:pointer-events-none group-focus-within/thread-row:opacity-0";

/** Fixed-width timestamp/status column; fades on hover so pin/archive can overlay this slot. */
function threadRowTimestampSlotClassName(
  isSubagentThread: boolean,
  toneClassName?: string,
): string {
  return cn(
    "mr-1 flex shrink-0 items-center justify-end leading-none tabular-nums transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
    isSubagentThread
      ? "w-[1.2rem] text-[10px]"
      : "w-[1.625rem] text-[length:var(--app-font-size-ui-meta,11px)]",
    toneClassName ?? (isSubagentThread ? "text-muted-foreground/26" : "text-muted-foreground/38"),
  );
}

function resolveWorktreeBadgeLabel(
  thread: Pick<Thread, "envMode" | "worktreePath">,
): string | null {
  return resolveThreadEnvironmentPresentation({
    envMode: thread.envMode,
    worktreePath: thread.worktreePath,
  }).worktreeBadgeLabel;
}

type ThreadMetaChip = {
  id: "handoff" | "fork" | "worktree";
  tooltip: string;
  icon: ReactNode;
};

/**
 * Back-to-front order: first = behind, last = in front.
 * Priority lowest -> highest: handoff -> fork -> worktree. Sidechats skip fork/disposable
 * badges because the "Sidechat:" title already identifies them.
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
  const isSidechatThread = Boolean(input.thread.sidechatSourceThreadId);

  const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(input.thread);
  if (input.includeHandoffBadge && !input.handoffShownInAvatar && handoffBadgeLabel) {
    chips.push({
      id: "handoff",
      tooltip: handoffBadgeLabel,
      icon: <SidebarGlyph icon={FiGitBranch} variant="meta" className="text-muted-foreground/55" />,
    });
  }

  if (input.thread.forkSourceThreadId && !isSidechatThread) {
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

  const worktreeBadgeLabel = resolveWorktreeBadgeLabel(input.thread);
  if (worktreeBadgeLabel) {
    chips.push({
      id: "worktree",
      tooltip: worktreeBadgeLabel,
      icon: <WorktreeBadgeGlyph className="text-muted-foreground/55" />,
    });
  }

  return chips;
}

function ProviderAvatarWithTerminal({
  provider,
  handoffSourceProvider,
  handoffTooltip,
  terminalStatus,
  terminalCount,
}: {
  provider: ProviderKind;
  handoffSourceProvider?: ProviderKind | null;
  handoffTooltip?: string | null;
  terminalStatus: TerminalStatusIndicator | null;
  terminalCount: number;
}) {
  const showBadge = terminalCount > 1 || terminalStatus !== null;
  const badgeTooltip =
    terminalCount > 1
      ? `${terminalCount} ${pluralize(terminalCount, "terminal")} open`
      : (terminalStatus?.label ?? "Terminal open");
  const badgeColorClass = terminalStatus?.colorClass ?? "text-muted-foreground/55";

  const hasHandoff = Boolean(handoffSourceProvider);
  const containerClass = hasHandoff
    ? "relative inline-flex h-3 w-4.5 shrink-0 items-center"
    : "relative inline-flex size-3 shrink-0 items-center justify-center";

  const avatarNode = hasHandoff ? (
    <span className={containerClass}>
      <span className="sidebar-icon-chip absolute left-0 top-1/2 inline-flex size-3 -translate-y-1/2 items-center justify-center rounded-full">
        <ProviderIcon provider={handoffSourceProvider!} className="size-2" />
      </span>
      <span className="sidebar-icon-chip absolute right-0 top-1/2 z-10 inline-flex size-3 -translate-y-1/2 items-center justify-center rounded-full">
        <ProviderIcon provider={provider} className="size-2" />
      </span>
    </span>
  ) : (
    <span className={containerClass}>
      <ProviderIcon provider={provider} className="size-3" />
    </span>
  );

  const wrappedAvatar =
    hasHandoff && handoffTooltip ? (
      <Tooltip>
        <TooltipTrigger render={avatarNode} />
        <TooltipPopup side="top">{handoffTooltip}</TooltipPopup>
      </Tooltip>
    ) : (
      avatarNode
    );

  return (
    <span className="relative inline-flex shrink-0 items-center">
      {wrappedAvatar}
      {showBadge ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={badgeTooltip}
                className="sidebar-icon-chip absolute -top-1.5 -right-1.5 inline-flex size-3 min-w-3 items-center justify-center rounded-full px-px"
              >
                {terminalCount > 1 ? (
                  <span
                    className={cn(
                      "text-[8px] font-semibold leading-none tabular-nums",
                      badgeColorClass,
                    )}
                  >
                    {terminalCount}
                  </span>
                ) : (
                  <TerminalIcon className={cn("size-2.5", badgeColorClass)} />
                )}
              </span>
            }
          />
          <TooltipPopup side="top">{badgeTooltip}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}

function renderSubagentLabel(input: {
  threadId: string;
  parentThreadId?: string | null | undefined;
  agentId?: string | null | undefined;
  nickname?: string | null | undefined;
  role?: string | null | undefined;
  title?: string | null | undefined;
  threads?: ReadonlyArray<Thread> | undefined;
  titleClassName?: string | undefined;
  roleClassName?: string | undefined;
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

function SidebarSubagentLabel(props: {
  threadId: ThreadId;
  parentThreadId?: ThreadId | null | undefined;
  agentId?: string | null | undefined;
  nickname?: string | null | undefined;
  role?: string | null | undefined;
  title?: string | null | undefined;
  titleClassName?: string | undefined;
  roleClassName?: string | undefined;
}) {
  const selectParentThread = useMemo(
    () => createThreadSelector(props.parentThreadId ?? null),
    [props.parentThreadId],
  );
  const parentThread = useStore(selectParentThread);

  return renderSubagentLabel({
    threadId: props.threadId,
    parentThreadId: props.parentThreadId,
    agentId: props.agentId,
    nickname: props.nickname,
    role: props.role,
    title: props.title,
    threads: parentThread ? [parentThread] : undefined,
    titleClassName: props.titleClassName,
    roleClassName: props.roleClassName,
  });
}

interface TerminalStatusIndicator {
  label: "Terminal input needed" | "Terminal task completed" | "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  icon: LucideIcon;
  tooltip: string;
  url: string;
}

type ThreadPr = GitStatusResult["pr"];

function toThreadPr(
  pr:
    | NonNullable<ThreadPr>
    | {
        number: number;
        title: string;
        url: string;
        baseBranch: string;
        headBranch: string;
        state: "open" | "closed" | "merged";
      },
): ThreadPr {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
    state: pr.state,
  };
}

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
  const presentation = resolvePrStatePresentation(pr.state);
  return {
    label: presentation.label,
    colorClass: presentation.colorClass,
    icon: presentation.iconKind === "merged-simple" ? GitMergedSimpleIcon : GitPullRequestIcon,
    tooltip: `#${pr.number} ${presentation.label}: ${pr.title}`,
    url: pr.url,
  };
}

function ThreadPrStatusBadge({
  prStatus,
  onOpen,
  className,
}: {
  prStatus: PrStatusIndicator;
  onOpen: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={prStatus.tooltip}
            className={cn(
              "inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-ring",
              prStatus.colorClass,
              className,
            )}
            onClick={(event) => onOpen(event, prStatus.url)}
          >
            <SidebarGlyph icon={prStatus.icon} variant="meta" className="size-3.5" />
          </button>
        }
      />
      <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
    </Tooltip>
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
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={IoFilter}
        label="Sort projects"
        tooltip="Sort projects"
        tooltipSide="right"
      />
      <MenuPopup
        align="end"
        side="bottom"
        className="min-w-44 rounded-lg border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] shadow-lg"
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
          <ThreadSortMenuItems
            threadSortOrder={threadSortOrder}
            onThreadSortOrderChange={onThreadSortOrderChange}
          />
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function ThreadSortMenuItems({
  threadSortOrder,
  onThreadSortOrderChange,
}: {
  threadSortOrder: SidebarThreadSortOrder;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
}) {
  return (
    <MenuRadioGroup
      value={threadSortOrder}
      onValueChange={(value) => {
        onThreadSortOrderChange(value as SidebarThreadSortOrder);
      }}
    >
      {(Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>).map(
        ([value, label]) => (
          <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
            {label}
          </MenuRadioItem>
        ),
      )}
    </MenuRadioGroup>
  );
}

function ChatSortMenu({
  threadSortOrder,
  onThreadSortOrderChange,
}: {
  threadSortOrder: SidebarThreadSortOrder;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
}) {
  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={IoFilter}
        label="Sort chats"
        tooltip="Sort chats"
        tooltipSide="top"
      />
      <MenuPopup
        align="end"
        side="bottom"
        className="min-w-44 rounded-lg border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] shadow-lg"
      >
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">Sort chats</div>
          <ThreadSortMenuItems
            threadSortOrder={threadSortOrder}
            onThreadSortOrderChange={onThreadSortOrderChange}
          />
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
  badgeCount,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  shortcutLabel?: string | null;
  badgeCount?: number | null;
}) {
  const shortcutParts = shortcutLabel ? splitShortcutLabel(shortcutLabel) : [];
  const showBadge = typeof badgeCount === "number" && badgeCount > 0;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        data-active={active}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group/sidebar-primary-action",
          SIDEBAR_HEADER_ROW_CLASS_NAME,
          active
            ? SIDEBAR_ROW_ACTIVE_CLASS_NAME
            : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
        )}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={onClick}
      >
        <SidebarLeadingIcon size="sm">
          <SidebarGlyph icon={Icon} variant="leading" />
        </SidebarLeadingIcon>
        <span className="truncate">{label}</span>
        {showBadge ? (
          <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-md bg-muted px-1 text-[10px] font-medium text-muted-foreground">
            {badgeCount}
          </span>
        ) : shortcutParts.length > 0 ? (
          <span className="ml-auto opacity-0 transition-opacity group-hover/sidebar-primary-action:opacity-100 group-focus-visible/sidebar-primary-action:opacity-100">
            <KbdGroup>
              {shortcutParts.map((part) => (
                <Kbd key={part}>{part}</Kbd>
              ))}
            </KbdGroup>
          </span>
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
  views,
  activeView,
  onSelectView,
}: {
  views: ReadonlyArray<"threads" | "workspace">;
  activeView: "threads" | "workspace";
  onSelectView: (view: "threads" | "workspace") => void;
}) {
  // A single-option switcher is just a static label, so hide it entirely when the
  // user has turned off one of the two sections in Settings.
  if (views.length < 2) {
    return null;
  }
  return (
    <div className="px-3 pb-2.5">
      <div className="sidebar-segmented-picker inline-flex w-full rounded-lg p-0.5">
        {views.map((view) => {
          const active = activeView === view;
          return (
            <button
              key={view}
              type="button"
              data-sidebar-segmented-active={active ? "true" : undefined}
              className={cn(
                "flex-1 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                active
                  ? SIDEBAR_SEGMENTED_PICKER_ACTIVE_CLASS_NAME
                  : "text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]",
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
  const [showDebugFeatureFlagsMenu, setShowDebugFeatureFlagsMenu] = useState(
    readDebugFeatureFlagsMenuVisibility,
  );
  const projects = useStore((store) => store.projects);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const sidebarThreadSummaryById = useStore((store) => store.sidebarThreadSummaryById);
  const sidebarThreadSummaryByIdRef = useRef(sidebarThreadSummaryById);
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
  const projectRunsByProjectId = useProjectRunStore((state) => state.runsByProjectId);
  const storeUpsertProjectRun = useProjectRunStore((state) => state.upsertRun);
  const storeRemoveProjectRun = useProjectRunStore((state) => state.removeRun);
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const openChatThreadPage = useTerminalStateStore((state) => state.openChatThreadPage);
  const openTerminalThreadPage = useTerminalStateStore((state) => state.openTerminalThreadPage);
  const clearProjectDraftThreads = useComposerDraftStore((store) => store.clearProjectDraftThreads);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const temporaryThreadIds = useTemporaryThreadStore((store) => store.temporaryThreadIds);
  const clearTemporaryThread = useTemporaryThreadStore((store) => store.clearTemporaryThread);
  const persistedPinnedProjectIds = usePinnedProjectsStore((store) => store.pinnedProjectIds);
  const pinProjectLocally = usePinnedProjectsStore((store) => store.pinProject);
  const unpinProject = usePinnedProjectsStore((store) => store.unpinProject);
  const prunePinnedProjects = usePinnedProjectsStore((store) => store.prunePinnedProjects);
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
  const chatWorkspaceRoot = useWorkspaceStore((store) => store.chatWorkspaceRoot);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const isOnSettings = useLocation({
    select: (loc) => loc.pathname === "/settings",
  });
  const isOnWorkspace = pathname.startsWith("/workspace");
  const isOnKanban = pathname.startsWith("/kanban");
  const isOnAutomations = pathname.startsWith("/automations");
  // Lightweight read of automations to drive the sidebar attention badge. Shares the
  // ["automations"] query cache with the Automations route (and its live stream updates).
  const automationListQuery = useQuery({
    queryKey: automationQueryKey,
    queryFn: () => ensureNativeApi().automation.list({}),
  });
  useEffect(() => {
    const api = ensureNativeApi();
    return api.automation.onEvent((event) => {
      queryClient.setQueryData<AutomationListResult>(automationQueryKey, (prev) =>
        applyAutomationEvent(prev, event),
      );
    });
  }, [queryClient]);
  const automationAttentionCount = useMemo(() => {
    const data = automationListQuery.data;
    if (!data) return 0;
    const flagged = new Set<string>();
    for (const run of data.runs) {
      if (
        run.status === "failed" ||
        run.status === "cancelled" ||
        run.status === "interrupted" ||
        run.status === "waiting-for-approval"
      ) {
        flagged.add(run.automationId);
      }
    }
    return flagged.size;
  }, [automationListQuery.data]);
  const { settings: appSettings, updateSettings } = useAppSettings();
  // The Threads/Projects tab is always available; only the optional Workspace tab
  // and the standalone Chats footer list can be hidden from Settings.
  const chatsSectionVisible = appSettings.showChatsSection;
  const workspaceSectionVisible = appSettings.showWorkspaceSection;
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
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const { activeProjectId: focusedProjectId } = useFocusedChatContext();
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [searchPaletteMode, setSearchPaletteMode] = useState<SidebarSearchPaletteMode>("search");
  const [searchPaletteInitialQuery, setSearchPaletteInitialQuery] = useState<string | null>(null);
  const [projectRunDialogProjectId, setProjectRunDialogProjectId] = useState<ProjectId | null>(
    null,
  );
  const [projectRunDialogCommandDraft, setProjectRunDialogCommandDraft] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [showManualPathInput, setShowManualPathInput] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectErrorMeaning = useMemo(
    () => (addProjectError ? describeAddProjectError(addProjectError) : null),
    [addProjectError],
  );
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingArchiveConfirmationThreadId, setPendingArchiveConfirmationThreadId] =
    useState<ThreadId | null>(null);
  const [renameDialogThreadId, setRenameDialogThreadId] = useState<ThreadId | null>(null);
  const [renameProjectDialogId, setRenameProjectDialogId] = useState<ProjectId | null>(null);
  const [projectContextMenuState, setProjectContextMenuState] =
    useState<ProjectContextMenuState | null>(null);
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
  const lastThreadRenameTapRef = useRef<{
    threadId: ThreadId;
    timestamp: number;
  } | null>(null);
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const legacyPinMigrationThreadIdsRef = useRef(new Set<ThreadId>());
  const optimisticPinnedStateByProjectIdRef = useRef(new Map<ProjectId, boolean>());
  const latestPinnedMutationVersionByProjectIdRef = useRef(new Map<ProjectId, number>());
  const optimisticPinnedStateByThreadIdRef = useRef(new Map<ThreadId, boolean>());
  const latestPinnedMutationVersionByThreadIdRef = useRef(new Map<ThreadId, number>());
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null);
  const [renamingWorkspaceTitle, setRenamingWorkspaceTitle] = useState("");
  const [installingDesktopUpdate, setInstallingDesktopUpdate] = useState(false);
  const [optimisticPinnedStateByThreadId, setOptimisticPinnedStateByThreadId] = useState<
    ReadonlyMap<ThreadId, boolean>
  >(() => new Map());
  const [optimisticPinnedStateByProjectId, setOptimisticPinnedStateByProjectId] = useState<
    ReadonlyMap<ProjectId, boolean>
  >(() => new Map());
  // Dedupes the manual-download fallback toast so a single failure surfaced by
  // both the click handler and the install-watchdog push only notifies once.
  const lastDesktopUpdateErrorToastSignatureRef = useRef<string | null>(null);
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
  const routeTerminalState = routeThreadId
    ? selectThreadTerminalState(terminalStateByThreadId, routeThreadId)
    : null;
  const terminalOpen = routeTerminalState?.terminalOpen ?? false;
  const terminalWorkspaceOpen = shouldRenderTerminalWorkspace({
    presentationMode: routeTerminalState?.presentationMode ?? "drawer",
    terminalOpen,
  });
  const pinnedThreadIds = useMemo(
    () =>
      derivePinnedThreadIdsForSidebar({
        threads: sidebarDisplayThreads,
        persistedPinnedThreadIds,
        optimisticPinnedStateByThreadId,
      }),
    [optimisticPinnedStateByThreadId, persistedPinnedThreadIds, sidebarDisplayThreads],
  );
  const pinnedThreadIdSet = useMemo(() => new Set(pinnedThreadIds), [pinnedThreadIds]);
  const pinnedThreads = useMemo(
    () => getPinnedThreadsForSidebar(sidebarDisplayThreads, pinnedThreadIds),
    [pinnedThreadIds, sidebarDisplayThreads],
  );
  useEffect(() => {
    sidebarThreadSummaryByIdRef.current = sidebarThreadSummaryById;
  }, [sidebarThreadSummaryById]);
  const setOptimisticThreadPinned = useCallback((threadId: ThreadId, isPinned: boolean) => {
    optimisticPinnedStateByThreadIdRef.current.set(threadId, isPinned);
    setOptimisticPinnedStateByThreadId((current) => {
      if (current.get(threadId) === isPinned) {
        return current;
      }
      const next = new Map(current);
      next.set(threadId, isPinned);
      return next;
    });
  }, []);
  const clearOptimisticThreadPinned = useCallback((threadId: ThreadId) => {
    optimisticPinnedStateByThreadIdRef.current.delete(threadId);
    setOptimisticPinnedStateByThreadId((current) => {
      if (!current.has(threadId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });
  }, []);
  const dispatchThreadPinnedState = useCallback(async (threadId: ThreadId, isPinned: boolean) => {
    const api = readNativeApi();
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId,
      isPinned,
    });
  }, []);
  const setThreadPinned = useCallback(
    async (threadId: ThreadId, isPinned: boolean) => {
      const api = readNativeApi();
      if (!api) return;
      const requestVersion =
        (latestPinnedMutationVersionByThreadIdRef.current.get(threadId) ?? 0) + 1;
      latestPinnedMutationVersionByThreadIdRef.current.set(threadId, requestVersion);

      setOptimisticThreadPinned(threadId, isPinned);
      if (isPinned) {
        pinThreadLocally(threadId);
      } else {
        unpinThread(threadId);
      }

      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          isPinned,
        });
      } catch (error) {
        if (
          !isLatestPinnedThreadMutation({
            threadId,
            requestVersion,
            latestMutationVersionByThreadId: latestPinnedMutationVersionByThreadIdRef.current,
          })
        ) {
          return;
        }

        const confirmedPinned = sidebarThreadSummaryByIdRef.current[threadId]?.isPinned === true;
        if (confirmedPinned) {
          pinThreadLocally(threadId);
        } else {
          unpinThread(threadId);
        }
        clearOptimisticThreadPinned(threadId);
        throw error;
      }
    },
    [clearOptimisticThreadPinned, pinThreadLocally, setOptimisticThreadPinned, unpinThread],
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
  useEffect(() => {
    if (optimisticPinnedStateByThreadId.size === 0) {
      return;
    }

    const serverPinnedStateByThreadId = new Map(
      sidebarThreads.map((thread) => [thread.id, thread.isPinned === true] as const),
    );
    setOptimisticPinnedStateByThreadId((current) => {
      let next: Map<ThreadId, boolean> | null = null;
      const confirmedThreadIds: ThreadId[] = [];
      for (const [threadId, desiredPinned] of current) {
        const serverPinned = serverPinnedStateByThreadId.get(threadId);
        if (serverPinned !== undefined && serverPinned !== desiredPinned) {
          continue;
        }
        next ??= new Map(current);
        next.delete(threadId);
        confirmedThreadIds.push(threadId);
      }
      if (next) {
        for (const threadId of confirmedThreadIds) {
          optimisticPinnedStateByThreadIdRef.current.delete(threadId);
        }
      }
      return next ?? current;
    });
  }, [optimisticPinnedStateByThreadId, sidebarThreads]);
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
  const projectByIdRef = useRef(projectById);
  const projectRunCommandByProjectIdRef = useRef<
    Map<ProjectId, ReturnType<typeof selectPrimaryProjectRunCommand>>
  >(new Map());
  const projectRunServerByProjectIdRef = useRef<Map<ProjectId, ServerLocalServerProcess>>(
    new Map(),
  );
  useEffect(() => {
    projectByIdRef.current = projectById;
  }, [projectById]);
  const setOptimisticProjectPinned = useCallback((projectId: ProjectId, isPinned: boolean) => {
    optimisticPinnedStateByProjectIdRef.current.set(projectId, isPinned);
    setOptimisticPinnedStateByProjectId((current) => {
      if (current.get(projectId) === isPinned) {
        return current;
      }
      const next = new Map(current);
      next.set(projectId, isPinned);
      return next;
    });
  }, []);
  const clearOptimisticProjectPinned = useCallback((projectId: ProjectId) => {
    optimisticPinnedStateByProjectIdRef.current.delete(projectId);
    setOptimisticPinnedStateByProjectId((current) => {
      if (!current.has(projectId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(projectId);
      return next;
    });
  }, []);
  const dispatchProjectPinnedState = useCallback(
    async (projectId: ProjectId, isPinned: boolean) => {
      const api = readNativeApi();
      if (!api) return;
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId,
        isPinned,
      });
    },
    [],
  );
  const setProjectPinned = useCallback(
    async (projectId: ProjectId, isPinned: boolean) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projectByIdRef.current.get(projectId);
      if (!project || project.kind !== "project") {
        return;
      }
      const requestVersion =
        (latestPinnedMutationVersionByProjectIdRef.current.get(projectId) ?? 0) + 1;
      latestPinnedMutationVersionByProjectIdRef.current.set(projectId, requestVersion);

      setOptimisticProjectPinned(projectId, isPinned);
      if (isPinned) {
        const accepted = pinProjectLocally(projectId);
        if (!accepted) {
          clearOptimisticProjectPinned(projectId);
          toastManager.add({
            type: "warning",
            title: "Project pin limit reached",
            description: `You can pin up to ${MAX_PINNED_PROJECTS} projects.`,
          });
          return;
        }
      } else {
        unpinProject(projectId);
      }

      try {
        await dispatchProjectPinnedState(projectId, isPinned);
      } catch (error) {
        if (
          !isLatestPinnedProjectMutation({
            projectId,
            requestVersion,
            latestMutationVersionByProjectId: latestPinnedMutationVersionByProjectIdRef.current,
          })
        ) {
          return;
        }

        const confirmedPinned = projectByIdRef.current.get(projectId)?.isPinned === true;
        if (confirmedPinned) {
          pinProjectLocally(projectId);
        } else {
          unpinProject(projectId);
        }
        clearOptimisticProjectPinned(projectId);
        throw error;
      }
    },
    [
      clearOptimisticProjectPinned,
      dispatchProjectPinnedState,
      pinProjectLocally,
      setOptimisticProjectPinned,
      unpinProject,
    ],
  );
  const toggleProjectPinned = useCallback(
    (projectId: ProjectId) => {
      const optimisticPinned = optimisticPinnedStateByProjectIdRef.current.get(projectId);
      const locallyPinned = usePinnedProjectsStore.getState().pinnedProjectIds.includes(projectId);
      const serverPinned = projectByIdRef.current.get(projectId)?.isPinned === true;
      const isPinned = optimisticPinned ?? (locallyPinned || serverPinned);
      void setProjectPinned(projectId, !isPinned).catch((error) => {
        console.error("Failed to update pinned project state", {
          projectId,
          error,
        });
        toastManager.add({
          type: "error",
          title: isPinned ? "Unable to unpin project" : "Unable to pin project",
          description: error instanceof Error ? error.message : undefined,
        });
      });
    },
    [setProjectPinned],
  );
  useEffect(() => {
    if (optimisticPinnedStateByProjectId.size === 0) {
      return;
    }

    const serverPinnedStateByProjectId = new Map(
      projects.map((project) => [project.id, project.isPinned === true] as const),
    );
    setOptimisticPinnedStateByProjectId((current) => {
      let next: Map<ProjectId, boolean> | null = null;
      const confirmedProjectIds: ProjectId[] = [];
      for (const [projectId, desiredPinned] of current) {
        const serverPinned = serverPinnedStateByProjectId.get(projectId);
        if (serverPinned !== undefined && serverPinned !== desiredPinned) {
          continue;
        }
        next ??= new Map(current);
        next.delete(projectId);
        confirmedProjectIds.push(projectId);
      }
      if (next) {
        for (const projectId of confirmedProjectIds) {
          optimisticPinnedStateByProjectIdRef.current.delete(projectId);
        }
      }
      return next ?? current;
    });
  }, [optimisticPinnedStateByProjectId, projects]);
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

  const resolveBackToThreadTarget = useCallback(() => {
    const latestThread =
      sortThreadsForSidebar(sidebarThreads, appSettings.sidebarThreadSortOrder)[0] ?? null;
    return resolveSettingsBackTarget({
      lastThreadRoute,
      availableThreadIds: buildSettingsBackAvailableThreadIds({
        sidebarThreadSummaryById,
        draftThreadsByThreadId,
      }),
      availableSplitViewIds: new Set(
        Object.keys(splitViewsById).filter((splitViewId) => splitViewsById[splitViewId]),
      ),
      latestThreadId: latestThread?.id ?? null,
    });
  }, [
    appSettings.sidebarThreadSortOrder,
    lastThreadRoute,
    draftThreadsByThreadId,
    sidebarThreadSummaryById,
    sidebarThreads,
    splitViewsById,
  ]);

  const handleBackToAppFromSettings = useCallback(() => {
    const target = resolveBackToThreadTarget();

    if (target.kind === "thread") {
      void navigate({
        to: "/$threadId",
        params: { threadId: ThreadId.makeUnsafe(target.threadId) },
        search: () => ({
          splitViewId: target.splitViewId,
        }),
      });
      return;
    }

    void navigate({ to: "/" });
  }, [navigate, resolveBackToThreadTarget]);

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

      const target = resolveBackToThreadTarget();
      if (target.kind === "thread") {
        void navigate({
          to: "/$threadId",
          params: { threadId: ThreadId.makeUnsafe(target.threadId) },
          search: () => ({
            splitViewId: target.splitViewId,
          }),
        });
        return;
      }

      void handleNewChat({ fresh: true });
    },
    [
      handleNewChat,
      navigate,
      navigateToWorkspace,
      resolveBackToThreadTarget,
      routeWorkspaceId,
      workspacePages,
    ],
  );

  // Keep the user off the Workspace tab once it's hidden in Settings: viewing it
  // (e.g. via a bookmark/deep link) jumps back to the always-visible Threads tab.
  // Settings is its own route and is never redirected.
  useEffect(() => {
    if (isOnSettings) {
      return;
    }
    if (isOnWorkspace && !workspaceSectionVisible) {
      handleSidebarViewChange("threads");
    }
  }, [handleSidebarViewChange, isOnSettings, isOnWorkspace, workspaceSectionVisible]);

  const handleCreateWorkspace = useCallback(() => {
    const workspaceId = createWorkspace();
    navigateToWorkspace(workspaceId);
  }, [createWorkspace, navigateToWorkspace]);

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
            throw new Error(ADD_PROJECT_EXISTING_SYNC_ERROR, { cause: error });
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

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
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
      }
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

  const { prewarmThreadDetail: prewarmThreadDetailForIntent } = useThreadDetailPrewarm();

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

  /**
   * Delete a single thread: stop session, close terminal, dispatch delete,
   * clean up drafts/state, and optionally remove orphaned worktree.
   * Callers handle thread-level confirmation; this still prompts for worktree removal.
   */
  const deleteThread = useCallback(
    async (
      threadId: ThreadId,
      opts: {
        deletedThreadIds?: ReadonlySet<ThreadId>;
        worktreeCleanupMode?: "prompt" | "skip";
      } = {},
    ): Promise<void> => {
      const api = readNativeApi();
      if (!api) return;
      const state = useStore.getState();
      const thread = getThreadFromState(state, threadId);
      if (!thread) return;
      const threadProject = projectById.get(thread.projectId);
      const allThreads = getThreadsFromState(state);
      // When bulk-deleting, exclude the other threads being deleted so
      // getOrphanedWorktreePathForThread correctly detects that no surviving
      // threads will reference this worktree.
      const deletedIds = opts.deletedThreadIds;
      const survivingThreads =
        deletedIds && deletedIds.size > 0
          ? allThreads.filter((t) => t.id === threadId || !deletedIds.has(t.id))
          : allThreads;
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(survivingThreads, threadId);
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree = orphanedWorktreePath !== null && threadProject !== undefined;
      const worktreeCleanupMode = opts.worktreeCleanupMode ?? "prompt";
      const shouldDeleteWorktree =
        worktreeCleanupMode === "prompt" &&
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
        terminalRuntimeRegistry.disposeThread(threadId);
        await api.terminal.close({ threadId, deleteHistory: true });
      } catch {
        // Terminal may already be closed
      }

      const allDeletedIds = deletedIds ?? new Set<ThreadId>();
      const shouldNavigateToFallback = routeThreadId === threadId;
      const fallbackThreadId = getFallbackThreadIdAfterDelete({
        threads: sidebarThreads,
        deletedThreadId: threadId,
        deletedThreadIds: allDeletedIds,
        sortOrder: appSettings.sidebarThreadSortOrder,
      });
      const activeSplitViewId = routeSearch.splitViewId ?? null;
      const deletedPaneInActiveSplit = activeSplitView
        ? resolveSplitViewPaneIdForThread(activeSplitView, threadId)
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
          void handleNewChat({ fresh: true });
        }
      } else if (shouldNavigateToFallback) {
        if (fallbackThreadId) {
          void navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        } else {
          void handleNewChat({ fresh: true });
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
      handleNewChat,
      navigate,
      projectById,
      removeWorktreeMutation,
      routeThreadId,
      routeSearch.splitViewId,
      activeSplitView,
      removeThreadFromSplitViews,
      clearTemporaryThread,
      sidebarThreads,
      unpinThread,
    ],
  );

  const copyThreadIdToClipboard = useCopyThreadIdToClipboard();
  const copyPathToClipboard = useCopyPathToClipboard();
  const handoffThread = useCallback(
    async (thread: Thread, targetProvider: ProviderKind) => {
      try {
        await createThreadHandoff(thread, targetProvider);
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
      const thread = sidebarThreadSummaryById[threadId];
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
    [appSettings.confirmThreadDelete, deleteThread, sidebarThreadSummaryById],
  );

  /**
   * Archive a thread: stop any running session first, then dispatch archive command.
   * Archived threads are hidden from the sidebar but can be restored later.
   */
  const archiveThread = useCallback(
    async (threadId: ThreadId): Promise<void> => {
      const api = readNativeApi();
      if (!api) return;
      const thread = getThreadFromState(useStore.getState(), threadId);
      if (!thread) return;

      // Cannot archive a running thread
      if (thread.session?.status === "running" && thread.session.activeTurnId != null) {
        toastManager.add({
          type: "error",
          title: "Cannot archive",
          description: "Stop the running session before archiving this thread.",
        });
        return;
      }

      await api.orchestration.dispatchCommand({
        type: "thread.archive",
        commandId: newCommandId(),
        threadId,
      });

      // Navigate away if viewing the archived thread
      if (routeThreadId === threadId) {
        const fallbackThreadId = getFallbackThreadIdAfterDelete({
          threads: sidebarThreads,
          deletedThreadId: threadId,
          deletedThreadIds: new Set<ThreadId>(),
          sortOrder: appSettings.sidebarThreadSortOrder,
        });
        if (fallbackThreadId) {
          void navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        } else {
          void handleNewChat({ fresh: true });
        }
      }
    },
    [appSettings.sidebarThreadSortOrder, handleNewChat, navigate, routeThreadId, sidebarThreads],
  );

  const confirmAndArchiveThread = useCallback(
    async (threadId: ThreadId) => {
      const thread = sidebarThreadSummaryById[threadId];
      if (!thread) return;

      if (appSettings.confirmThreadArchive) {
        const api = readNativeApi();
        const confirmationMessage = [
          `Archive thread "${thread.title}"?`,
          "Archived threads are hidden from the sidebar but can be restored later.",
        ].join("\n");
        const confirmed = api
          ? await api.dialogs.confirm(confirmationMessage)
          : await showConfirmDialogFallback(confirmationMessage);
        if (!confirmed) return;
      }

      await archiveThread(threadId);
      setPendingArchiveConfirmationThreadId((current) => (current === threadId ? null : current));
    },
    [appSettings.confirmThreadArchive, archiveThread, sidebarThreadSummaryById],
  );

  const inlineConfirmArchiveThread = useCallback(
    async (threadId: ThreadId) => {
      setPendingArchiveConfirmationThreadId((current) => (current === threadId ? null : current));
      await archiveThread(threadId);
    },
    [archiveThread],
  );

  const dismissPendingArchiveConfirmation = useCallback((threadId: ThreadId) => {
    setPendingArchiveConfirmationThreadId((current) => (current === threadId ? null : current));
  }, []);

  /**
   * Archive every non-archived thread for a given project in one pass.
   * Skips (and reports) threads with a running session since the server
   * rejects archiving an active turn. Confirms the batch once up-front
   * rather than prompting per-thread to avoid dialog spam on large projects.
   */
  const archiveAllThreadsInProject = useCallback(
    async (projectId: ProjectId): Promise<void> => {
      const api = readNativeApi();
      if (!api) return;
      const project = projectById.get(projectId);
      if (!project) return;

      const projectThreads = sidebarThreads.filter(
        (thread) => thread.projectId === projectId && thread.archivedAt == null,
      );
      if (projectThreads.length === 0) {
        toastManager.add({
          type: "info",
          title: "Nothing to archive",
          description: `"${project.name}" has no threads to archive.`,
        });
        return;
      }

      const archivableThreads = projectThreads.filter(
        (thread) => !(thread.session?.status === "running" && thread.session.activeTurnId != null),
      );
      const runningCount = projectThreads.length - archivableThreads.length;

      if (archivableThreads.length === 0) {
        toastManager.add({
          type: "error",
          title: "Cannot archive threads",
          description:
            runningCount === 1
              ? "The only thread in this project is running. Stop it before archiving."
              : `All ${runningCount} threads in this project are running. Stop them before archiving.`,
        });
        return;
      }

      // Bulk archive always confirms — this is a folder-level operation, and
      // `appSettings.confirmThreadArchive` (default `false`) is scoped to
      // single-thread archiving where the user explicitly picked one row.
      const archiveLines = [
        `Archive ${archivableThreads.length} ${pluralize(archivableThreads.length, "thread")} in "${project.name}"?`,
        "Archived threads are hidden from the sidebar but can be restored later.",
      ];
      if (runningCount > 0) {
        archiveLines.push(
          "",
          `${runningCount} running ${pluralize(runningCount, "thread is", "threads are")} currently active and will be skipped.`,
        );
      }
      const archiveConfirmed = api
        ? await api.dialogs.confirm(archiveLines.join("\n"))
        : await showConfirmDialogFallback(archiveLines.join("\n"));
      if (!archiveConfirmed) return;

      let archivedCount = 0;
      let failureCount = 0;
      for (const thread of archivableThreads) {
        try {
          await archiveThread(thread.id);
          archivedCount += 1;
        } catch (error) {
          failureCount += 1;
          console.error("Failed to archive thread during bulk archive", {
            threadId: thread.id,
            projectId,
            error,
          });
        }
      }

      // Clear any transient selection that pointed at just-archived rows.
      removeFromSelection(archivableThreads.map((thread) => thread.id));

      if (archivedCount > 0) {
        const skippedDescription =
          runningCount > 0
            ? ` Skipped ${runningCount} running ${pluralize(runningCount, "thread")}.`
            : "";
        toastManager.add({
          type: failureCount > 0 ? "warning" : "success",
          title: archivedCount === 1 ? "Thread archived" : `Archived ${archivedCount} threads`,
          description:
            failureCount > 0
              ? `Failed to archive ${failureCount} ${pluralize(failureCount, "thread")}.${skippedDescription}`
              : runningCount > 0
                ? skippedDescription.trim()
                : `"${project.name}" cleared.`,
        });
      } else if (failureCount > 0) {
        toastManager.add({
          type: "error",
          title: "Failed to archive threads",
          description: `Could not archive ${failureCount} ${pluralize(failureCount, "thread")} in "${project.name}".`,
        });
      }
    },
    [archiveThread, projectById, removeFromSelection, sidebarThreads],
  );

  /**
   * Delete every thread for a given project in one pass. Uses the shared
   * `deleteThread` helper so running sessions are stopped, worktrees are
   * cleaned up, and draft/pinned/split view state is pruned consistently.
   * A single `deletedThreadIds` set is passed through so orphan-worktree
   * detection treats the whole batch as "going away" at once.
   */
  const deleteProjectThreads = useCallback(
    async (
      projectId: ProjectId,
      options?: {
        confirmMessage?: string | null;
        showEmptyToast?: boolean;
        showResultToast?: boolean;
        worktreeCleanupMode?: "prompt" | "skip";
      },
    ): Promise<{
      deletedCount: number;
      failureCount: number;
      totalCount: number;
      projectName: string;
    } | null> => {
      const api = readNativeApi();
      if (!api) return null;
      const project = projectById.get(projectId);
      if (!project) return null;

      const projectThreads = sidebarThreads.filter((thread) => thread.projectId === projectId);
      if (projectThreads.length === 0) {
        if (options?.showEmptyToast ?? true) {
          toastManager.add({
            type: "info",
            title: "Nothing to delete",
            description: `"${project.name}" has no threads to delete.`,
          });
        }
        return {
          deletedCount: 0,
          failureCount: 0,
          totalCount: 0,
          projectName: project.name,
        };
      }

      const deleteConfirmationMessage =
        options?.confirmMessage === undefined
          ? [
              `Delete ${projectThreads.length} ${pluralize(projectThreads.length, "thread")} in "${project.name}"?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n")
          : options.confirmMessage;
      if (deleteConfirmationMessage !== null) {
        // Bulk delete always confirms unless a caller already collected a higher-level confirmation.
        const deleteConfirmed = await api.dialogs.confirm(deleteConfirmationMessage);
        if (!deleteConfirmed) return null;
      }

      const deletedIds = new Set<ThreadId>(projectThreads.map((thread) => thread.id));
      let deletedCount = 0;
      let failureCount = 0;
      for (const thread of projectThreads) {
        try {
          await deleteThread(thread.id, {
            deletedThreadIds: deletedIds,
            ...(options?.worktreeCleanupMode
              ? { worktreeCleanupMode: options.worktreeCleanupMode }
              : {}),
          });
          deletedCount += 1;
        } catch (error) {
          failureCount += 1;
          console.error("Failed to delete thread during bulk delete", {
            threadId: thread.id,
            projectId,
            error,
          });
        }
      }

      removeFromSelection([...deletedIds]);

      if (options?.showResultToast ?? true) {
        if (deletedCount > 0) {
          toastManager.add({
            type: failureCount > 0 ? "warning" : "success",
            title: deletedCount === 1 ? "Thread deleted" : `Deleted ${deletedCount} threads`,
            description:
              failureCount > 0
                ? `Failed to delete ${failureCount} ${pluralize(failureCount, "thread")}.`
                : `"${project.name}" cleared.`,
          });
        } else if (failureCount > 0) {
          toastManager.add({
            type: "error",
            title: "Failed to delete threads",
            description: `Could not delete ${failureCount} ${pluralize(failureCount, "thread")} in "${project.name}".`,
          });
        }
      }

      return {
        deletedCount,
        failureCount,
        totalCount: projectThreads.length,
        projectName: project.name,
      };
    },
    [deleteThread, projectById, removeFromSelection, sidebarThreads],
  );

  const deleteAllThreadsInProject = useCallback(
    async (projectId: ProjectId): Promise<void> => {
      await deleteProjectThreads(projectId);
    },
    [deleteProjectThreads],
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
      const thread = getThreadFromState(useStore.getState(), threadId);
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
      const threadStatus = threadSummary ? resolveThreadStatusForSidebar(threadSummary) : null;
      const handoffTargets = canHandoff
        ? resolveAvailableHandoffTargetProviders(thread.modelSelection.provider)
        : [];
      const handoffItems = handoffTargets.map((provider, index) => ({
        id: `handoff:${provider}`,
        label: `Handoff to ${PROVIDER_DISPLAY_NAMES[provider]}`,
        separatorBefore: index === 0,
      }));
      const threadWorkspacePath = resolveThreadWorkspaceCwd({
        projectCwd: projectCwdById.get(thread.projectId) ?? null,
        envMode: thread.envMode,
        worktreePath: thread.worktreePath,
      });
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          { id: "toggle-pin", label: isPinned ? "Unpin thread" : "Pin thread" },
          ...(threadStatus?.dismissible
            ? [{ id: "clear-notification", label: "Clear notification" }]
            : []),
          { id: "mark-unread", label: "Mark unread" },
          ...handoffItems,
          { id: "copy-path", label: "Copy Path", separatorBefore: true },
          ...(threadWorkspacePath
            ? [{ id: "open-path-in-terminal", label: "Open Path in Terminal" }]
            : []),
          { id: "copy-thread-id", label: "Copy Thread ID" },
          ...(options?.extraItems ?? []),
          { id: "archive", label: "Archive", separatorBefore: true },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "rename") {
        openRenameThreadDialog(threadId);
        return;
      }
      if (clicked === "toggle-pin") {
        toggleThreadPinned(threadId);
        return;
      }

      if (clicked === "mark-unread") {
        clearDismissedThreadStatus(threadId);
        markThreadUnread(threadId);
        return;
      }
      if (clicked === "clear-notification") {
        clearThreadNotification(threadId);
        return;
      }
      if (typeof clicked === "string" && clicked.startsWith("handoff:")) {
        const targetProvider = clicked.slice("handoff:".length);
        if (handoffTargets.includes(targetProvider as ProviderKind)) {
          await handoffThread(thread, targetProvider as ProviderKind);
        }
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
        copyPathToClipboard(threadWorkspacePath);
        return;
      }
      if (clicked === "open-path-in-terminal") {
        if (!threadWorkspacePath) {
          toastManager.add({
            type: "error",
            title: "Path unavailable",
            description: "This thread does not have a workspace path to open.",
          });
          return;
        }
        await navigate({ to: "/$threadId", params: { threadId } });
        const terminalStore = useTerminalStateStore.getState();
        const currentTerminalState = selectThreadTerminalState(
          terminalStore.terminalStateByThreadId,
          threadId,
        );

        // Reuse the active terminal when one is already open and idle so that
        // repeatedly invoking "Open Path in Terminal" doesn't pile up tabs.
        // Only spawn a fresh tab when there is no terminal yet, the active id
        // is stale (no longer in the layout), or the active terminal is busy
        // running a subprocess.
        const candidateBaseTerminalId =
          currentTerminalState.activeTerminalId ||
          currentTerminalState.terminalIds[0] ||
          DEFAULT_THREAD_TERMINAL_ID;
        const baseTerminalAvailable =
          currentTerminalState.terminalOpen &&
          currentTerminalState.terminalIds.includes(candidateBaseTerminalId) &&
          !currentTerminalState.runningTerminalIds.includes(candidateBaseTerminalId);
        const shouldCreateNewTerminal = !baseTerminalAvailable;
        const targetTerminalId = shouldCreateNewTerminal
          ? `terminal-${randomUUID()}`
          : candidateBaseTerminalId;

        const previousTerminalOpen = currentTerminalState.terminalOpen;
        const previousPresentationMode = currentTerminalState.presentationMode;
        const previousActiveTerminalId = currentTerminalState.activeTerminalId;

        terminalStore.setTerminalPresentationMode(threadId, "drawer");
        terminalStore.setTerminalOpen(threadId, true);
        if (shouldCreateNewTerminal) {
          terminalStore.newTerminal(threadId, targetTerminalId);
        } else {
          terminalStore.setActiveTerminal(threadId, targetTerminalId);
        }

        const cdCommand = `cd ${quotePosixShellArgument(threadWorkspacePath)}\r`;
        try {
          if (shouldCreateNewTerminal) {
            // A brand new PTY needs an explicit cwd so that the shell's first
            // prompt already shows the workspace path. The follow-up `cd` write
            // makes the navigation visible in the scrollback (it's effectively
            // a no-op since the shell is already there, but it matches the
            // user-typed-it experience).
            await api.terminal.open({
              threadId,
              terminalId: targetTerminalId,
              cwd: threadWorkspacePath,
            });
          }
          // Existing PTYs keep their launch cwd/env on reattach; writing `cd`
          // navigates in place without replacing shell state.
          await api.terminal.write({
            threadId,
            terminalId: targetTerminalId,
            data: cdCommand,
          });
        } catch (error) {
          if (shouldCreateNewTerminal) {
            terminalStore.closeTerminal(threadId, targetTerminalId);
          }
          terminalStore.setTerminalPresentationMode(threadId, previousPresentationMode);
          terminalStore.setTerminalOpen(threadId, previousTerminalOpen);
          if (previousActiveTerminalId) {
            terminalStore.setActiveTerminal(threadId, previousActiveTerminalId);
          }
          toastManager.add({
            type: "error",
            title: "Unable to open terminal",
            description:
              error instanceof Error ? error.message : "The terminal could not be opened.",
          });
        }
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(threadId);
        return;
      }
      if (clicked === "return-to-single-chat") {
        await options?.onExtraAction?.("return-to-single-chat");
        return;
      }
      if (clicked === "archive") {
        await confirmAndArchiveThread(threadId);
        return;
      }
      if (clicked !== "delete") return;
      await confirmAndDeleteThread(threadId);
    },
    [
      confirmAndArchiveThread,
      confirmAndDeleteThread,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      clearDismissedThreadStatus,
      clearThreadNotification,
      handoffThread,
      markThreadUnread,
      navigate,
      openRenameThreadDialog,
      pinnedThreadIdSet,
      projectCwdById,
      resolveThreadStatusForSidebar,
      sidebarThreadSummaryById,
      toggleThreadPinned,
    ],
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
          { id: "archive", label: `Archive (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const id of ids) {
          clearDismissedThreadStatus(id);
          markThreadUnread(id);
        }
        clearSelection();
        return;
      }

      if (clicked === "archive") {
        if (appSettings.confirmThreadArchive) {
          const confirmed = await api.dialogs.confirm(
            [
              `Archive ${count} ${pluralize(count, "thread")}?`,
              "Archived threads are hidden from the sidebar but can be restored later.",
            ].join("\n"),
          );
          if (!confirmed) return;
        }

        for (const id of ids) {
          await archiveThread(id);
        }
        removeFromSelection(ids);
        return;
      }

      if (clicked !== "delete") return;

      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} ${pluralize(count, "thread")}?`,
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
      appSettings.confirmThreadArchive,
      appSettings.confirmThreadDelete,
      archiveThread,
      clearSelection,
      clearDismissedThreadStatus,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      selectedThreadIds,
    ],
  );

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

  const handleStartProjectRun = useCallback(
    async (projectId: ProjectId, commandOverride?: string) => {
      const api = readNativeApi();
      const project = projectById.get(projectId);
      const runCommand = projectRunCommandByProjectIdRef.current.get(projectId);
      if (!api || !project || !runCommand) {
        return;
      }
      if (projectRunsByProjectId[projectId]) {
        return;
      }
      // The dialog lets the user edit the default command before launching, so an
      // explicit override wins over the resolved default while reusing its cwd.
      const command = commandOverride?.trim() || runCommand.command;
      // Dev servers run from the project root; mirror the env the terminal runner
      // would otherwise inject so scripts resolve project paths identically.
      const env = projectScriptRuntimeEnv({
        project: { cwd: project.cwd },
        worktreePath: null,
      });

      // Optimistically reflect the pending launch so the sidebar dot lights up
      // immediately; the server's authoritative snapshot replaces this on success.
      storeUpsertProjectRun({
        projectId,
        command,
        cwd: runCommand.cwd,
        pid: null,
        startedAt: new Date().toISOString(),
        status: "starting",
      });
      try {
        const { server } = await api.projects.runDevServer({
          projectId,
          command,
          cwd: runCommand.cwd,
          env,
        });
        storeUpsertProjectRun(server);
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.localServers() });
      } catch (error) {
        storeRemoveProjectRun(projectId);
        toastManager.add({
          type: "error",
          title: `Failed to run "${project.name}"`,
          description: error instanceof Error ? error.message : "Unable to start the run command.",
        });
      }
    },
    [
      projectById,
      projectRunsByProjectId,
      queryClient,
      storeRemoveProjectRun,
      storeUpsertProjectRun,
    ],
  );

  const handleStopProjectRun = useCallback(
    async (projectId: ProjectId) => {
      const api = readNativeApi();
      if (!api) {
        storeRemoveProjectRun(projectId);
        return;
      }
      // Optimistically clear the indicator; the server owns the process lifecycle
      // and will broadcast a `removed` event that keeps every client consistent.
      storeRemoveProjectRun(projectId);
      try {
        await api.projects.stopDevServer({ projectId });
      } catch (error) {
        // The optimistic removal may have been wrong (e.g. the stop failed), so
        // resync from the authoritative server registry before surfacing the error.
        try {
          const { servers } = await api.projects.listDevServers();
          useProjectRunStore.getState().replaceAll(servers);
        } catch {
          // Ignore resync failures; the dev-server event stream will reconcile.
        }
        toastManager.add({
          type: "error",
          title: "Failed to stop run",
          description: error instanceof Error ? error.message : "Unable to stop the dev server.",
        });
      } finally {
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.localServers() });
      }
    },
    [queryClient, storeRemoveProjectRun],
  );

  const handleOpenProjectRunServer = useCallback(async (projectId: ProjectId) => {
    const api = readNativeApi();
    const server = projectRunServerByProjectIdRef.current.get(projectId);
    const url = server ? firstLocalServerUrl(server) : null;
    if (!api || !server || !url) {
      return;
    }
    try {
      await api.shell.openExternal(url);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Unable to open ${localServerAddressLabel(server)}`,
        description: error instanceof Error ? error.message : "Unable to open the local server.",
      });
    }
  }, []);

  const handleProjectContextMenuAction = useCallback(
    async (projectId: ProjectId, clicked: ProjectContextMenuId) => {
      setProjectContextMenuState(null);
      const api = readNativeApi();
      if (!api) return;
      const project = projectById.get(projectId);
      if (!project) return;

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
      if (clicked === "open-in-kanban") {
        void navigate({ to: "/kanban/$projectId", params: { projectId } });
        return;
      }
      if (clicked === "copy-path") {
        copyPathToClipboard(project.cwd);
        return;
      }
      if (clicked === "start-dev") {
        setProjectRunDialogProjectId(projectId);
        return;
      }
      if (clicked === "stop-dev") {
        await handleStopProjectRun(projectId);
        return;
      }
      if (clicked === "open-dev-server") {
        await handleOpenProjectRunServer(projectId);
        return;
      }
      if (clicked === "rename") {
        setRenameProjectDialogId(projectId);
        return;
      }
      if (clicked === "toggle-pin") {
        toggleProjectPinned(projectId);
        return;
      }
      if (clicked === "archive-threads") {
        await archiveAllThreadsInProject(projectId);
        return;
      }
      if (clicked === "delete-threads") {
        await deleteAllThreadsInProject(projectId);
        return;
      }
      if (clicked !== "delete") return;

      const projectThreads = sidebarThreads.filter((thread) => thread.projectId === projectId);
      const confirmed = await api.dialogs.confirm(
        projectThreads.length > 0
          ? [
              `Remove project "${project.name}"?`,
              `This will delete ${projectThreads.length} ${pluralize(projectThreads.length, "thread")} in this folder and remove the project.`,
            ].join("\n")
          : `Remove project "${project.name}"?`,
      );
      if (!confirmed) return;

      try {
        // `project.delete` refuses non-empty folders, so `Remove` clears threads first.
        const deletionResult = await deleteProjectThreads(projectId, {
          confirmMessage: null,
          showEmptyToast: false,
          showResultToast: false,
          worktreeCleanupMode: "skip",
        });
        if (deletionResult === null) {
          return;
        }
        if (deletionResult.failureCount > 0) {
          toastManager.add({
            type: "error",
            title: `Failed to remove "${project.name}"`,
            description: `Could not delete ${deletionResult.failureCount} ${pluralize(deletionResult.failureCount, "thread")} in "${project.name}".`,
          });
          return;
        }

        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: newCommandId(),
          projectId,
        });
        clearProjectDraftThreads(projectId);
        toastManager.add({
          type: "success",
          title: `Removed "${project.name}"`,
          description:
            deletionResult.deletedCount > 0
              ? `Deleted ${deletionResult.deletedCount} ${pluralize(deletionResult.deletedCount, "thread")} and removed the project.`
              : "Project removed.",
        });
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
    [
      archiveAllThreadsInProject,
      clearProjectDraftThreads,
      copyPathToClipboard,
      deleteProjectThreads,
      deleteAllThreadsInProject,
      handleOpenProjectRunServer,
      handleStopProjectRun,
      navigate,
      projectById,
      sidebarThreads,
      toggleProjectPinned,
    ],
  );

  const handleProjectContextMenu = useCallback(
    (projectId: ProjectId, position: { x: number; y: number }) => {
      if (!readNativeApi()) return;
      if (!projectById.has(projectId)) return;
      setProjectContextMenuState({ projectId, position });
    },
    [projectById],
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
  const handleProjectTitlePointerDownCapture = useCallback(() => {
    suppressProjectClickAfterDragRef.current = false;
  }, []);

  const handleRenameProjectSave = useCallback(
    (projectId: ProjectId, nextName: string, previousLocalName: string | null) => {
      const trimmed = nextName.trim();
      const normalizedPrevious = previousLocalName?.trim() ?? "";
      if (trimmed === normalizedPrevious) {
        return;
      }
      renameProjectLocally(projectId, trimmed.length > 0 ? trimmed : null);
    },
    [renameProjectLocally],
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
  const standardProjectsBase = useMemo(
    () =>
      sortedProjects.filter(
        (project) =>
          project.kind === "project" &&
          !isHomeChatContainerProject(project, { homeDir, chatWorkspaceRoot }),
      ),
    [chatWorkspaceRoot, homeDir, sortedProjects],
  );
  const pinnedProjectIds = useMemo(
    () =>
      derivePinnedProjectIdsForSidebar({
        projects: standardProjectsBase,
        persistedPinnedProjectIds,
        optimisticPinnedStateByProjectId,
      }),
    [optimisticPinnedStateByProjectId, persistedPinnedProjectIds, standardProjectsBase],
  );
  const pinnedProjectIdSet = useMemo(() => new Set(pinnedProjectIds), [pinnedProjectIds]);
  const standardProjects = useMemo(
    () => orderPinnedProjectsForSidebar(standardProjectsBase, pinnedProjectIds),
    [pinnedProjectIds, standardProjectsBase],
  );
  const projectScriptDiscoveryQueries = useQueries({
    queries: standardProjects.map((project) =>
      projectDiscoverScriptsQueryOptions({
        cwd: project.cwd,
        enabled:
          project.kind === "project" &&
          !project.scripts.some((script) => !script.runOnWorktreeCreate),
      }),
    ),
  });
  const discoveredScriptTargetsByProjectId = useMemo(() => {
    const targetsByProjectId = new Map<ProjectId, readonly ProjectDiscoveredScriptTarget[]>();
    for (let index = 0; index < standardProjects.length; index += 1) {
      const project = standardProjects[index];
      if (!project) continue;
      targetsByProjectId.set(project.id, projectScriptDiscoveryQueries[index]?.data?.targets ?? []);
    }
    return targetsByProjectId;
  }, [projectScriptDiscoveryQueries, standardProjects]);
  const projectRunCommandByProjectId = useMemo(() => {
    const commandByProjectId = new Map<
      ProjectId,
      ReturnType<typeof selectPrimaryProjectRunCommand>
    >();
    for (const project of standardProjects) {
      commandByProjectId.set(
        project.id,
        selectPrimaryProjectRunCommand({
          project,
          discoveredTargets: discoveredScriptTargetsByProjectId.get(project.id) ?? [],
        }),
      );
    }
    return commandByProjectId;
  }, [discoveredScriptTargetsByProjectId, standardProjects]);
  projectRunCommandByProjectIdRef.current = projectRunCommandByProjectId;
  // Keep manual server attribution alive, but slow the always-on folder scan
  // when no Synara-owned run needs near-real-time reconciliation.
  const hasActiveProjectRun = useMemo(
    () => Object.keys(projectRunsByProjectId).length > 0,
    [projectRunsByProjectId],
  );
  const shouldTrackLocalServers = standardProjects.length > 0 || hasActiveProjectRun;
  const localServersRefetchInterval = hasActiveProjectRun
    ? LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS
    : LOCAL_SERVERS_BACKGROUND_REFETCH_INTERVAL_MS;
  const projectRunLocalServersQuery = useQuery(
    serverLocalServersQueryOptions({
      enabled: shouldTrackLocalServers,
      refetchInterval: localServersRefetchInterval,
    }),
  );
  const projectRunServerByProjectId = useMemo(() => {
    const servers = projectRunLocalServersQuery.data?.servers ?? [];
    const serverByProjectId = new Map<ProjectId, ServerLocalServerProcess>();
    // 1. Authoritative: Synara-tracked runs matched by pid/ppid.
    for (const run of Object.values(projectRunsByProjectId)) {
      const server = findTrackedProjectRunServer(run, servers);
      if (server) {
        serverByProjectId.set(run.projectId, server);
      }
    }
    // 2. Fallback: attribute remaining servers to a project by cwd, so dev
    //    servers started outside Synara still light up the running indicator.
    for (const server of servers) {
      if (!server.cwd) {
        continue;
      }
      const project = findDeepestWorkspaceRootMatch(
        standardProjects,
        server.cwd,
        (candidate) => candidate.cwd,
      );
      if (project && !serverByProjectId.has(project.id)) {
        serverByProjectId.set(project.id, server);
      }
    }
    return serverByProjectId;
  }, [projectRunLocalServersQuery.data?.servers, projectRunsByProjectId, standardProjects]);
  projectRunServerByProjectIdRef.current = projectRunServerByProjectId;
  const projectRunDialogProject = projectRunDialogProjectId
    ? (projectById.get(projectRunDialogProjectId) ?? null)
    : null;
  const projectRunDialogExistingRun = projectRunDialogProjectId
    ? (projectRunsByProjectId[projectRunDialogProjectId] ?? null)
    : null;
  const closeProjectRunDialog = useCallback(() => {
    setProjectRunDialogProjectId(null);
  }, []);
  // Seed the editable command field with the resolved default each time the dialog
  // opens for a project, without clobbering edits while it stays open.
  useEffect(() => {
    if (projectRunDialogProjectId === null) {
      return;
    }
    const defaultCommand =
      projectRunCommandByProjectIdRef.current.get(projectRunDialogProjectId)?.command ?? "";
    setProjectRunDialogCommandDraft(defaultCommand);
  }, [projectRunDialogProjectId]);
  const projectRunDialogCommandIsValid = projectRunDialogCommandDraft.trim().length > 0;
  // Remember the launched command as the project's primary run script so the
  // dialog defaults to it next time. No-ops when unchanged.
  const persistProjectRunCommand = useCallback(
    async (projectId: ProjectId, command: string) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projectById.get(projectId);
      if (!project) return;
      const nextScripts = upsertProjectRunCommandScripts({ scripts: project.scripts, command });
      if (!nextScripts) return;
      try {
        await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId,
          scripts: nextScripts,
        });
      } catch (error) {
        console.error("Failed to save project run command", { projectId, error });
      }
    },
    [projectById],
  );
  const handleConfirmProjectRun = useCallback(() => {
    const projectId = projectRunDialogProjectId;
    if (!projectId) {
      return;
    }
    const command = projectRunDialogCommandDraft.trim();
    if (!command) {
      return;
    }
    setProjectRunDialogProjectId(null);
    void persistProjectRunCommand(projectId, command);
    void handleStartProjectRun(projectId, command);
  }, [
    handleStartProjectRun,
    persistProjectRunCommand,
    projectRunDialogCommandDraft,
    projectRunDialogProjectId,
  ]);
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
    if (!shouldPrunePinnedThreads({ threadsHydrated })) {
      return;
    }
    prunePinnedProjects(standardProjectsBase.map((project) => project.id));
  }, [prunePinnedProjects, standardProjectsBase, threadsHydrated]);

  useEffect(() => {
    if (!threadsHydrated || persistedPinnedThreadIds.length === 0) {
      return;
    }

    // Older builds stored pins only in localStorage; mirror them to the server
    // projection so the retention job can protect those threads too.
    const threadsById = new Map(sidebarThreads.map((thread) => [thread.id, thread] as const));
    for (const threadId of persistedPinnedThreadIds) {
      const thread = threadsById.get(threadId);
      if (
        !thread ||
        thread.isPinned === true ||
        optimisticPinnedStateByThreadIdRef.current.has(threadId) ||
        legacyPinMigrationThreadIdsRef.current.has(threadId)
      ) {
        continue;
      }
      legacyPinMigrationThreadIdsRef.current.add(threadId);
      void dispatchThreadPinnedState(threadId, true)
        .catch((error) => {
          console.error("Failed to migrate pinned thread state", {
            threadId,
            error,
          });
        })
        .finally(() => {
          legacyPinMigrationThreadIdsRef.current.delete(threadId);
        });
    }
  }, [dispatchThreadPinnedState, persistedPinnedThreadIds, sidebarThreads, threadsHydrated]);

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
    isPinned: boolean;
    includePinToggle?: boolean;
    compact?: boolean;
  }) {
    const compact = input.compact === true;
    const includePinToggle = input.includePinToggle !== false;
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
            {includePinToggle ? (
              <ThreadPinToggleButton
                pinned={input.isPinned}
                presentation="inline"
                toneClassName={input.toneClassName}
                onToggle={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleThreadPinned(input.threadId);
                }}
              />
            ) : null}
            {renderThreadArchiveAction(input.threadId, input.toneClassName, {
              compact,
            })}
          </div>
        )}
      </SidebarRowHoverActions>
    );
  }

  function renderThreadRowTrailingCluster(input: {
    isSubagentThread: boolean;
    isPendingArchiveConfirmation: boolean;
    threadJumpLabel: string | null;
    threadJumpLabelParts: readonly string[];
    rightMetaChips: ThreadMetaChip[];
    threadStatus: ReturnType<typeof resolveThreadStatusForSidebar>;
    updatedAt: string | null | undefined;
    createdAt: string;
    timestampToneClassName?: string;
    hoverActions: ReactNode;
  }) {
    return (
      <div className="relative flex shrink-0 items-center justify-end gap-1">
        {!input.isPendingArchiveConfirmation && input.rightMetaChips.length > 0 ? (
          <div className={THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME}>
            <SidebarMetaChipStack chips={input.rightMetaChips} />
          </div>
        ) : null}
        {!input.isPendingArchiveConfirmation && input.threadJumpLabel ? (
          <KbdGroup className={THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME}>
            {input.threadJumpLabelParts.map((part) => (
              <Kbd key={part}>{part}</Kbd>
            ))}
          </KbdGroup>
        ) : null}
        {!input.isPendingArchiveConfirmation && !input.threadJumpLabel ? (
          input.threadStatus ? (
            <span
              className={threadRowTimestampSlotClassName(
                input.isSubagentThread,
                input.timestampToneClassName,
              )}
            >
              <ThreadStatusTrailingGlyph threadStatus={input.threadStatus} />
            </span>
          ) : (
            <span
              className={threadRowTimestampSlotClassName(
                input.isSubagentThread,
                input.timestampToneClassName,
              )}
            >
              {formatRelativeTime(input.updatedAt ?? input.createdAt)}
            </span>
          )
        ) : null}
        {input.hoverActions}
      </div>
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
    return (
      <div
        key={thread.id}
        className="group/thread-row relative w-full opacity-85"
        onPointerLeave={() => dismissPendingArchiveConfirmation(thread.id)}
      >
        {leadingPrStatus ? (
          <ThreadPrStatusBadge
            prStatus={leadingPrStatus}
            onOpen={openPrLink}
            className="pointer-events-auto absolute left-1.5 top-1/2 z-30 size-5 -translate-y-1/2"
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
            <SidebarGlyph
              icon={TerminalIcon}
              variant="chrome"
              className="text-[var(--color-text-accent)]"
            />
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
              <span className="truncate text-right text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/38">
                {projectLabel}
              </span>
            ) : null}
          </div>
          <div className="flex w-14 shrink-0 items-center justify-end">
            {renderThreadRowTrailingCluster({
              isSubagentThread,
              isPendingArchiveConfirmation,
              threadJumpLabel,
              threadJumpLabelParts,
              rightMetaChips,
              threadStatus,
              updatedAt: thread.updatedAt,
              createdAt: thread.createdAt,
              timestampToneClassName: "text-muted-foreground/38",
              hoverActions: renderThreadHoverActions({
                threadId: thread.id,
                toneClassName: "text-muted-foreground/42",
                isPinned: true,
                compact: isSubagentThread,
              }),
            })}
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
      ? "text-foreground/54 dark:text-foreground/64"
      : "text-muted-foreground/34";
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
    const childCountLabel = `${childCount} ${pluralize(childCount, "subagent")}`;
    const toggleButtonClassName = isHighlighted
      ? "border-[color:var(--color-border)] bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]"
      : "border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] text-[var(--color-text-foreground-secondary)] hover:border-[color:var(--color-border)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]";

    return (
      <SidebarMenuSubItem
        key={thread.id}
        className="group/thread-row w-full opacity-85"
        data-thread-item
        onPointerLeave={() => dismissPendingArchiveConfirmation(thread.id)}
      >
        {leadingPrStatus ? (
          <ThreadPrStatusBadge
            prStatus={leadingPrStatus}
            onOpen={openPrLink}
            className="pointer-events-auto absolute left-1.5 top-1/2 z-30 size-5 -translate-y-1/2"
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
          draggable
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
            <SidebarGlyph
              icon={TerminalIcon}
              variant="chrome"
              className="text-[var(--color-text-accent)]"
            />
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
                  roleClassName="text-muted-foreground/42"
                />
              ) : (
                thread.title
              )}
            </span>
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
            {showCompactMeta && isDisposableThread && !thread.sidechatSourceThreadId ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex shrink-0 items-center text-muted-foreground/55">
                      <DisposableThreadIcon />
                    </span>
                  }
                />
                <TooltipPopup side="top">Disposable chat</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
          <div className={cn("absolute top-1/2 flex -translate-y-1/2 items-center", "right-1.5")}>
            {renderThreadRowTrailingCluster({
              isSubagentThread,
              isPendingArchiveConfirmation,
              threadJumpLabel,
              threadJumpLabelParts,
              rightMetaChips: showCompactMeta ? rightMetaChips : [],
              threadStatus,
              updatedAt: thread.updatedAt,
              createdAt: thread.createdAt,
              timestampToneClassName: isSubagentThread
                ? isHighlighted
                  ? "text-foreground/38 dark:text-foreground/46"
                  : "text-muted-foreground/24"
                : secondaryMetaClass,
              hoverActions: renderThreadHoverActions({
                threadId: thread.id,
                toneClassName: secondaryMetaClass,
                isPinned,
                compact: isSubagentThread,
              }),
            })}
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
    const isProjectPinned = pinnedProjectIdSet.has(project.id);
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
    const projectFolderIconClassName = isProjectPinned
      ? "opacity-0"
      : "transition-opacity md:group-hover/project-header:opacity-0 md:group-has-[:focus-visible]/project-header:opacity-0";
    const projectRun = projectRunsByProjectId[project.id] ?? null;
    const projectRunServer = projectRunServerByProjectId.get(project.id) ?? null;
    // A project reads as "running" when Synara tracks a run for it or when a
    // local server (possibly started outside Synara) is attributed by cwd.
    const isProjectRunning = projectRun !== null || projectRunServer !== null;
    // The "open dev server" affordance now lives in the project context menu, so
    // the hover toolbar always reserves space for the three thread actions.
    const projectToolbarReserveClassName =
      "group-hover/project-header:pr-[4.75rem] focus-visible:pr-[4.75rem]";

    return (
      <div className="group/collapsible">
        <div className="group/project-header relative">
          <SidebarMenuButton
            ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
            size="sm"
            className={cn(
              SIDEBAR_HEADER_ROW_CLASS_NAME,
              "transition-[padding] duration-150 ease-out hover:bg-[var(--sidebar-accent)] group-hover/project-header:bg-[var(--sidebar-accent)] group-hover/project-header:text-[var(--sidebar-accent-foreground)]",
              projectToolbarReserveClassName,
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
            <SidebarLeadingIcon size="sm" className={projectFolderIconClassName}>
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
              {isProjectRunning ? <ProjectRunIndicatorDot className="self-center" /> : null}
              <span className="truncate font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/79">
                {project.name}
              </span>
              {project.localName ? (
                <span className="shrink-0 truncate text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/40">
                  {project.folderName}
                </span>
              ) : null}
            </div>
          </SidebarMenuButton>
          <button
            type="button"
            aria-label={isProjectPinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
            aria-pressed={isProjectPinned}
            title={isProjectPinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
            className={cn(
              "sidebar-icon-button absolute left-2 top-1/2 z-20 inline-flex size-4 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/62 transition-opacity hover:text-foreground/82 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
              isProjectPinned
                ? "pointer-events-auto opacity-100"
                : "pointer-events-none opacity-0 md:group-hover/project-header:pointer-events-auto md:group-hover/project-header:opacity-100 md:group-has-[:focus-visible]/project-header:pointer-events-auto md:group-has-[:focus-visible]/project-header:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              toggleProjectPinned(project.id);
            }}
          >
            <PinIcon className="size-3.5" />
          </button>
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
    const clearThreadJumpHints = () => {
      setThreadJumpLabelByThreadId((current) =>
        current === EMPTY_THREAD_JUMP_LABELS ? current : EMPTY_THREAD_JUMP_LABELS,
      );
      setShowThreadJumpHints(false);
    };
    const shouldIgnoreThreadJumpHintUpdate = (event: KeyboardEvent) =>
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.key !== "Meta" &&
      event.key !== "Control" &&
      event.key !== "Alt" &&
      event.key !== "Shift" &&
      !showThreadJumpHintsRef.current &&
      threadJumpLabelsRef.current === EMPTY_THREAD_JUMP_LABELS;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (
        (event.metaKey || event.ctrlKey) &&
        event.key === "k" &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        setSearchPaletteMode("search");
        setSearchPaletteInitialQuery(null);
        setSearchPaletteOpen((prev) => !prev || searchPaletteMode !== "search");
        return;
      }

      const shortcutContext = getCurrentSidebarShortcutContext();
      if (!shouldIgnoreThreadJumpHintUpdate(event)) {
        const shouldShowHints = shouldShowThreadJumpHints(event, keybindings, {
          platform: navigator.platform,
          context: shortcutContext,
        });
        if (!shouldShowHints) {
          if (
            showThreadJumpHintsRef.current ||
            threadJumpLabelsRef.current !== EMPTY_THREAD_JUMP_LABELS
          ) {
            clearThreadJumpHints();
          }
        } else {
          setThreadJumpLabelByThreadId((current) => {
            const nextLabelMap = buildThreadJumpLabelMap({
              keybindings,
              platform: navigator.platform,
              terminalOpen: shortcutContext.terminalOpen,
              threadJumpCommandByThreadId,
            });
            return threadJumpLabelMapsEqual(current, nextLabelMap) ? current : nextLabelMap;
          });
          setShowThreadJumpHints(true);
        }
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (command === "sidebar.search") {
        event.preventDefault();
        event.stopPropagation();
        setSearchPaletteMode("search");
        setSearchPaletteInitialQuery(null);
        setSearchPaletteOpen((prev) => !prev || searchPaletteMode !== "search");
        return;
      }
      if (command === "sidebar.addProject") {
        event.preventDefault();
        event.stopPropagation();
        setSearchPaletteMode("search");
        setSearchPaletteInitialQuery(getInitialBrowseQuery(homeDir));
        setSearchPaletteOpen(true);
        return;
      }
      if (command === "sidebar.importThread") {
        event.preventDefault();
        event.stopPropagation();
        setSearchPaletteMode("import");
        setSearchPaletteInitialQuery(null);
        setSearchPaletteOpen((prev) => !prev || searchPaletteMode !== "import");
        return;
      }
      if (command === "settings.usage") {
        event.preventDefault();
        event.stopPropagation();
        void navigate({
          to: "/settings",
          search: { section: "usage" },
        });
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex !== null) {
        event.preventDefault();
        event.stopPropagation();
        const threadJumpTargetId = threadJumpThreadIds[jumpIndex];
        if (threadJumpTargetId) {
          activateThreadFromSidebarIntent(threadJumpTargetId);
        }
        return;
      }
      if (command !== "chat.visible.next" && command !== "chat.visible.previous") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const nextThreadId = getNextVisibleSidebarThreadId({
        visibleThreadIds: visibleSidebarThreadIds,
        activeThreadId: activeSidebarThreadId ?? undefined,
        direction: command === "chat.visible.previous" ? "backward" : "forward",
      });
      if (nextThreadId && nextThreadId !== activeSidebarThreadId) {
        activateThreadFromSidebarIntent(nextThreadId);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (shouldIgnoreThreadJumpHintUpdate(event)) {
        return;
      }
      const shortcutContext = getCurrentSidebarShortcutContext();
      const shouldShowHints = shouldShowThreadJumpHints(event, keybindings, {
        platform: navigator.platform,
        context: shortcutContext,
      });
      if (!shouldShowHints) {
        clearThreadJumpHints();
        return;
      }
      setThreadJumpLabelByThreadId((current) => {
        const nextLabelMap = buildThreadJumpLabelMap({
          keybindings,
          platform: navigator.platform,
          terminalOpen: shortcutContext.terminalOpen,
          threadJumpCommandByThreadId,
        });
        return threadJumpLabelMapsEqual(current, nextLabelMap) ? current : nextLabelMap;
      });
      setShowThreadJumpHints(true);
    };
    const onWindowBlur = () => {
      clearThreadJumpHints();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [
    activateThreadFromSidebarIntent,
    activeSidebarThreadId,
    keybindings,
    getCurrentSidebarShortcutContext,
    homeDir,
    navigate,
    searchPaletteMode,
    threadJumpCommandByThreadId,
    threadJumpThreadIds,
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

  // Single entry point for update error toasts. Attaches the manual-download
  // fallback (copy link + "Download manually") whenever a release URL is known,
  // and dedupes by error signature so the same failure is not toasted twice.
  const surfaceDesktopUpdateError = useCallback(
    (input: { title: string; description: string; state: DesktopUpdateState | null }) => {
      const signature = getDesktopUpdateErrorSignature(input.state) ?? `adhoc:${input.description}`;
      if (lastDesktopUpdateErrorToastSignatureRef.current === signature) {
        return;
      }
      lastDesktopUpdateErrorToastSignatureRef.current = signature;
      const releaseUrl = input.state?.releaseUrl ?? null;
      const fallbackProps = releaseUrl
        ? {
            data: { copyText: releaseUrl },
            actionProps: {
              children: "Download manually",
              onClick: () => {
                void window.desktopBridge?.openExternal(releaseUrl);
              },
            },
          }
        : {};
      toastManager.add({
        type: "error",
        title: input.title,
        description: input.description,
        ...fallbackProps,
      });
    },
    [],
  );

  // The install watchdog (and any background-pushed failure) flips the update
  // state to a download/install error without going through a click handler, so
  // the fallback must also be surfaced reactively here. Dedup keeps it from
  // doubling up with the click-handler toast for user-initiated failures.
  useEffect(() => {
    if (!getDesktopUpdateErrorSignature(desktopUpdateState)) {
      // Returning to any non-error state (new download, success, up-to-date)
      // clears the dedup key so the next distinct failure notifies again.
      lastDesktopUpdateErrorToastSignatureRef.current = null;
      return;
    }
    if (!desktopUpdateState?.releaseUrl) {
      return;
    }
    surfaceDesktopUpdateError({
      title:
        desktopUpdateState.errorContext === "install"
          ? "Couldn’t finish updating"
          : "Couldn’t download the update",
      description:
        desktopUpdateState.message ??
        "The in-app update could not complete. You can download it manually.",
      state: desktopUpdateState,
    });
  }, [desktopUpdateState, surfaceDesktopUpdateError]);

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
    "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 font-system-ui text-[length:var(--app-font-size-ui-sm,11px)] font-medium leading-none text-white transition-colors",
    desktopUpdateButtonHasSecondaryLabel && "min-h-7 py-1",
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
  const usageSettingsShortcutLabel = shortcutLabelForCommand(keybindings, "settings.usage");
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
      {
        id: "usage-settings",
        label: "Usage settings",
        description: "Open provider usage and remaining credits.",
        keywords: ["usage", "limits", "credits", "quota", "providers"],
        shortcutLabel: usageSettingsShortcutLabel,
      },
    ],
    [
      addProjectShortcutLabel,
      importThreadShortcutLabel,
      newChatShortcutLabel,
      newThreadShortcutLabel,
      usageSettingsShortcutLabel,
    ],
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
              type: "info",
              title: "Preparing update",
              description: `Synara is preparing version ${nextState.availableVersion ?? "available"} in the background.`,
            });
            return;
          }

          if (nextState.status === "downloading") {
            toastManager.add({
              type: "info",
              title: "Preparing update",
              description: "Synara is downloading the update in the background.",
            });
            return;
          }

          if (nextState.status === "downloaded") {
            toastManager.add({
              type: "success",
              title: "Update ready",
              description: "Click Update when you’re ready to restart and install it.",
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
            surfaceDesktopUpdateError({
              title: "Could not check for updates",
              description: nextState.message ?? "An unexpected error occurred.",
              state: nextState,
            });
          }
        })
        .catch((error) => {
          surfaceDesktopUpdateError({
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
            state: desktopUpdateState,
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
              title: "Update ready",
              description: "Click Update when you’re ready to restart and install it.",
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
          surfaceDesktopUpdateError({
            title: "Could not download update",
            description: actionError,
            state: result.state,
          });
        })
        .catch((error) => {
          surfaceDesktopUpdateError({
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
            state: desktopUpdateState,
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
          surfaceDesktopUpdateError({
            title: "Could not install update",
            description: actionError,
            state: result.state,
          });
        })
        .catch((error) => {
          setInstallingDesktopUpdate(false);
          surfaceDesktopUpdateError({
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
            state: desktopUpdateState,
          });
        });
    }
  }, [
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled,
    desktopUpdateState,
    surfaceDesktopUpdateError,
  ]);

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

  // Only macOS draws the traffic lights in the renderer's top-left, so only there
  // does the open-sidebar header need to reserve the gutter (mirrors the mac guard
  // in useDesktopTopBarTrafficLightGutterClassName used by the closed-state surfaces).
  const isMacDesktop = typeof navigator !== "undefined" ? isMacPlatform(navigator.platform) : false;

  // Open-sidebar (in-sidebar) and non-electron wordmark clusters share the one
  // SidebarLeadingControls primitive with the closed-state host headers, so the
  // toggle + arrows look identical whether the sidebar is open or collapsed; only
  // the wrapper layout differs per host.
  const titlebarControls = <SidebarLeadingControls className="hidden md:flex" />;

  const headerControls = <SidebarLeadingControls className="ml-auto hidden md:flex" />;

  const wordmark = (
    <div className="flex w-full items-center gap-1.5">
      <SidebarTrigger className="shrink-0 text-muted-foreground/75 hover:text-foreground md:hidden" />
      {headerControls}
    </div>
  );
  const renameProjectDialogProject = renameProjectDialogId
    ? (projectById.get(renameProjectDialogId) ?? null)
    : null;
  const projectContextMenuProject = projectContextMenuState
    ? (projectById.get(projectContextMenuState.projectId) ?? null)
    : null;
  const projectContextMenuThreads = useMemo(
    () =>
      projectContextMenuState
        ? sidebarThreads.filter((thread) => thread.projectId === projectContextMenuState.projectId)
        : [],
    [projectContextMenuState, sidebarThreads],
  );
  const projectContextMenuAnchor = useMemo(
    () =>
      projectContextMenuState
        ? createClientPointMenuAnchor(projectContextMenuState.position)
        : null,
    [projectContextMenuState],
  );
  const projectContextMenuHasAnyThreads = projectContextMenuThreads.length > 0;
  const projectContextMenuHasArchivableThreads = projectContextMenuThreads.some(
    (thread) => thread.archivedAt == null,
  );
  const projectContextMenuIsPinned = projectContextMenuProject
    ? pinnedProjectIdSet.has(projectContextMenuProject.id)
    : false;
  const projectContextMenuIsRunning = projectContextMenuProject
    ? Boolean(projectRunsByProjectId[projectContextMenuProject.id])
    : false;
  const projectContextMenuServer = projectContextMenuProject
    ? (projectRunServerByProjectId.get(projectContextMenuProject.id) ?? null)
    : null;
  const projectContextMenuHasOpenServer =
    projectContextMenuServer !== null && firstLocalServerUrl(projectContextMenuServer) !== null;

  return (
    <>
      {isElectron ? (
        <>
          <SidebarHeader
            className={cn(
              "drag-region flex-row items-center gap-2 px-4 py-0 font-system-ui",
              CHAT_SURFACE_HEADER_HEIGHT_CLASS,
              isMacDesktop && DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS,
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
                      ? "Preparing ARM build"
                      : desktopUpdateButtonAction === "install"
                        ? "Update ARM build"
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
              onBack={handleBackToAppFromSettings}
              onSelectSection={(section, options) => {
                void navigate({
                  to: "/settings",
                  search: (previous) => ({
                    ...previous,
                    section: section === "general" ? undefined : section,
                    target: options?.target,
                  }),
                });
              }}
            />
          </SidebarGroup>
        ) : (
          <>
            <SidebarSegmentedPicker
              views={["threads", ...(workspaceSectionVisible ? (["workspace"] as const) : [])]}
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
                      icon={KanbanIcon}
                      label="Kanban"
                      active={isOnKanban}
                      onClick={() => {
                        void navigate({ to: "/kanban" });
                      }}
                    />
                    <SidebarPrimaryAction
                      icon={ClockIcon}
                      label="Automations"
                      active={isOnAutomations}
                      badgeCount={automationAttentionCount}
                      onClick={() => {
                        void navigate({ to: "/automations" });
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
                                      <span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] tabular-nums text-muted-foreground/50">
                                        {workspace.terminalCount}
                                      </span>
                                    )}
                                  </SidebarMenuButton>
                                  <SidebarIconButton
                                    icon={Trash2}
                                    label="Delete workspace"
                                    glyph="meta"
                                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 opacity-0 transition-opacity group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100"
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
                  <div className="mb-3">
                    <div className="my-1 flex items-center justify-between px-2 py-1">
                      <span className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>Pinned</span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {pinnedThreads.map((thread) => renderPinnedThreadRow(thread))}
                    </div>
                  </div>
                ) : null}
                <div className="group/project-header relative my-1">
                  <div
                    className={cn(
                      "flex h-7 w-full min-w-0 items-center px-2 py-0.5 pr-[4.75rem]",
                      SIDEBAR_SECTION_LABEL_CLASS_NAME,
                    )}
                  >
                    <span className="truncate">Projects</span>
                  </div>
                  <SidebarSectionToolbar placement="overlay" revealOnHover>
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
                        items={standardProjects.map((project) => project.id)}
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
                    <div className="text-center text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/58">
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
                  <div className="px-2 pt-4 text-center text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/58">
                    No projects yet
                  </div>
                )}
              </SidebarGroup>
            )}
          </>
        )}
      </SidebarContent>

      <SidebarFooter className="gap-2 p-2 font-system-ui">
        {!isOnSettings && chatsSectionVisible ? (
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
                    <div className="px-2 py-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/48">
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
                            <span className="min-w-0 truncate text-center">
                              {desktopUpdateButtonPresentation.label}
                            </span>
                            {desktopUpdateButtonPresentation.secondaryLabel ? (
                              <span className="min-w-0 truncate text-center text-[length:var(--app-font-size-ui-xs,10px)] text-white/80">
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

      {projectContextMenuState && projectContextMenuProject && projectContextMenuAnchor ? (
        <Menu
          open
          onOpenChange={(open) => {
            if (!open) {
              setProjectContextMenuState(null);
            }
          }}
        >
          <ComposerPickerMenuPopup
            anchor={projectContextMenuAnchor}
            align="start"
            side="bottom"
            sideOffset={0}
            className={PROJECT_CONTEXT_MENU_PANEL_CLASS_NAME}
          >
            <MenuGroup>
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(
                    projectContextMenuState.projectId,
                    "open-in-finder",
                  )
                }
              >
                <ProjectContextMenuIcon icon={FolderOpenIcon} />
                <span>Open in Finder</span>
              </MenuItem>
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(
                    projectContextMenuState.projectId,
                    "open-in-kanban",
                  )
                }
              >
                <ProjectContextMenuIcon icon={KanbanIcon} />
                <span>Open in Kanban</span>
              </MenuItem>
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(
                    projectContextMenuState.projectId,
                    "copy-path",
                  )
                }
              >
                <ProjectContextMenuIcon icon={CopyIcon} />
                <span>Copy Path</span>
              </MenuItem>
              <MenuSeparator />
              {projectContextMenuIsRunning ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "stop-dev",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={StopFilledIcon} />
                  <span>Stop dev</span>
                </MenuItem>
              ) : (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "start-dev",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={PlayIcon} />
                  <span>Start dev</span>
                </MenuItem>
              )}
              {projectContextMenuHasOpenServer ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "open-dev-server",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={ExternalLinkIcon} />
                  <span>Open dev server</span>
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(projectContextMenuState.projectId, "rename")
                }
              >
                <ProjectContextMenuIcon icon={PencilIcon} />
                <span>Edit name</span>
              </MenuItem>
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(
                    projectContextMenuState.projectId,
                    "toggle-pin",
                  )
                }
              >
                <ProjectContextMenuIcon icon={PinIcon} />
                <span>{projectContextMenuIsPinned ? "Unpin project" : "Pin project"}</span>
              </MenuItem>
              {projectContextMenuHasArchivableThreads || projectContextMenuHasAnyThreads ? (
                <MenuSeparator />
              ) : null}
              {projectContextMenuHasArchivableThreads ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "archive-threads",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={ArchiveIcon} />
                  <span>Archive threads</span>
                </MenuItem>
              ) : null}
              {projectContextMenuHasAnyThreads ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "delete-threads",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={Trash2} />
                  <span>Delete threads</span>
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(projectContextMenuState.projectId, "delete")
                }
              >
                <ProjectContextMenuIcon icon={XIcon} />
                <span>Remove</span>
              </MenuItem>
            </MenuGroup>
          </ComposerPickerMenuPopup>
        </Menu>
      ) : null}

      <Dialog
        open={projectRunDialogProjectId !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeProjectRunDialog();
          }
        }}
      >
        <DialogPopup surface="solid" className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <PlayIcon className="size-4 text-emerald-500" />
              Start dev
            </DialogTitle>
            <DialogDescription>
              {projectRunDialogProject ? projectRunDialogProject.name : "Project"}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            <label
              htmlFor="project-run-command-input"
              className="block text-[length:var(--app-font-size-ui-xs,10px)] font-medium uppercase tracking-[0.08em] text-[var(--color-text-foreground-secondary)]"
            >
              Command
            </label>
            <Input
              id="project-run-command-input"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="e.g. npm run dev"
              className="font-mono"
              value={projectRunDialogCommandDraft}
              aria-invalid={projectRunDialogCommandIsValid ? undefined : true}
              onChange={(event) => setProjectRunDialogCommandDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleConfirmProjectRun();
                }
              }}
            />
            {projectRunDialogCommandIsValid ? null : (
              <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
                Enter a command to run.
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeProjectRunDialog}>
              Cancel
            </Button>
            <Button
              onClick={handleConfirmProjectRun}
              disabled={!projectRunDialogCommandIsValid || Boolean(projectRunDialogExistingRun)}
            >
              <PlayIcon className="size-4" />
              Run
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

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

      <RenameDialog
        open={renameProjectDialogId !== null && renameProjectDialogProject !== null}
        title="Rename project"
        description="Keep it short and recognizable."
        initialValue={
          renameProjectDialogProject?.localName ?? renameProjectDialogProject?.name ?? ""
        }
        allowEmpty
        placeholder={renameProjectDialogProject?.folderName}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setRenameProjectDialogId(null);
        }}
        onSave={(nextName) => {
          if (!renameProjectDialogProject) return;
          handleRenameProjectSave(
            renameProjectDialogProject.id,
            nextName,
            renameProjectDialogProject.localName,
          );
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
          onOpenUsageSettings={() => {
            void navigate({
              to: "/settings",
              search: { section: "usage" },
            });
          }}
          onOpenProject={handleOpenProjectFromSearch}
          onImportThread={handleImportThread}
          onOpenThread={(threadId) => {
            activateThreadFromSidebarIntent(ThreadId.makeUnsafe(threadId));
          }}
        />
      ) : null}
    </>
  );
}

function SidebarSearchPaletteController(props: {
  open: boolean;
  mode: SidebarSearchPaletteMode;
  onModeChange: (mode: SidebarSearchPaletteMode) => void;
  onOpenChange: (open: boolean) => void;
  actions: readonly SidebarSearchAction[];
  projects: readonly SidebarSearchProject[];
  projectById: ReadonlyMap<ProjectId, { name: string; remoteName: string }>;
  onCreateChat: () => void;
  onCreateThread: () => void;
  onAddProjectPath: (path: string, options?: { createIfMissing?: boolean }) => Promise<void>;
  homeDir: string | null;
  initialBrowseQuery: string | null;
  onOpenSettings: () => void;
  onOpenUsageSettings: () => void;
  onOpenProject: (projectId: string) => void;
  onImportThread: (provider: ImportProviderKind, externalId: string) => Promise<void>;
  onOpenThread: (threadId: string) => void;
}) {
  const selectAllThreads = useMemo(() => createAllThreadsSelector(), []);
  const selectSidebarDisplayThreads = useMemo(() => createSidebarDisplayThreadsSelector(), []);
  const importProviderCapabilityQueries = useQueries({
    queries: (["codex", "claudeAgent", "cursor", "kilo", "opencode"] as const).map((provider) =>
      providerComposerCapabilitiesQueryOptions(provider),
    ),
  });
  const threads = useStore(selectAllThreads);
  const sidebarDisplayThreads = useStore(selectSidebarDisplayThreads);
  const importProviders: ReadonlyArray<ImportProviderKind> = (
    ["codex", "claudeAgent", "cursor", "kilo", "opencode"] as const
  ).filter((provider, index) => supportsThreadImport(importProviderCapabilityQueries[index]?.data));
  const searchPaletteThreads = useMemo<SidebarSearchThread[]>(() => {
    const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
    return sidebarDisplayThreads.flatMap((threadSummary) => {
      const thread = threadById.get(threadSummary.id);
      if (!thread) {
        return [];
      }

      return [
        {
          id: thread.id,
          title: thread.title,
          projectId: thread.projectId,
          projectName: props.projectById.get(thread.projectId)?.name ?? "Unknown project",
          projectRemoteName:
            props.projectById.get(thread.projectId)?.remoteName ?? "Unknown project",
          provider: thread.modelSelection.provider,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          messages: thread.messages.map((message) => ({
            text: message.text,
          })),
        },
      ];
    });
  }, [props.projectById, sidebarDisplayThreads, threads]);

  return (
    <SidebarSearchPalette
      open={props.open}
      mode={props.mode}
      onModeChange={props.onModeChange}
      onOpenChange={props.onOpenChange}
      actions={props.actions}
      projects={props.projects}
      threads={searchPaletteThreads}
      onCreateChat={props.onCreateChat}
      onCreateThread={props.onCreateThread}
      onAddProjectPath={props.onAddProjectPath}
      homeDir={props.homeDir}
      initialBrowseQuery={props.initialBrowseQuery}
      onOpenSettings={props.onOpenSettings}
      onOpenUsageSettings={props.onOpenUsageSettings}
      onOpenProject={props.onOpenProject}
      importProviders={importProviders}
      onImportThread={props.onImportThread}
      onOpenThread={props.onOpenThread}
    />
  );
}
