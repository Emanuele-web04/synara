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
import { GoRepoForked } from "react-icons/go";
import { HiOutlineArchiveBox, HiOutlineCheckCircle, HiOutlineFolderOpen } from "react-icons/hi2";
import { BsChat } from "react-icons/bs";
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
  DEFAULT_MODEL_BY_PROVIDER,
  type DesktopUpdateState,
  type OrchestrationReadModel,
  PROVIDER_DISPLAY_NAMES,
  ProjectId,
  type ProviderKind,
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
import { ClaudeAI, Gemini, OpenAI } from "./Icons";
import { ProjectSidebarIcon } from "./ProjectSidebarIcon";
import { ThreadPinToggleButton } from "./ThreadPinToggleButton";
import { ThreadRunningSpinner } from "./ThreadRunningSpinner";
import { RenameThreadDialog } from "./RenameThreadDialog";
import { terminalRuntimeRegistry } from "./terminal/terminalRuntimeRegistry";
import { SidebarSearchPalette, type SidebarSearchPaletteMode } from "./SidebarSearchPalette";
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
import { Kbd, KbdGroup } from "./ui/kbd";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
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
  deriveSidebarProjectData,
  extractDuplicateProjectCreateProjectId,
  findWorkspaceRootMatch,
  getFallbackThreadIdAfterDelete,
  getPinnedThreadsForSidebar,
  getNextVisibleSidebarThreadId,
  getSidebarThreadIdsToPrewarm,
  getVisibleSidebarEntriesForPreview,
  groupSidebarThreadsByProjectId,
  groupSplitViewsByProjectId,
  pruneExpandedProjectThreadListsForCollapsedProjects,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarRestorableThreadRoute,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  isDuplicateProjectCreateError,
  type SidebarDerivedProjectData,
  shouldPrunePinnedThreads,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic";
import { resolveSubagentPresentationForThread } from "../lib/subagentPresentation";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { getInitialBrowseQuery } from "~/lib/projectPaths";
import {
  canCreateThreadHandoff,
  resolveAvailableHandoffTargetProviders,
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
import { retainThreadDetailSubscription } from "../threadDetailSubscriptionRetention";
import { useWorkspaceStore, workspaceThreadId } from "../workspaceStore";
import type {
  SidebarSearchAction,
  SidebarSearchProject,
  SidebarSearchThread,
} from "./SidebarSearchPalette.logic";
import { useFocusedChatContext } from "../focusedChatContext";
import { showContextMenuFallback } from "../contextMenuFallback";
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

const PROJECT_CONTEXT_MENU_FOLDER_ICON = renderToStaticMarkup(<HiOutlineFolderOpen />);
const PROJECT_CONTEXT_MENU_EDIT_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const PROJECT_CONTEXT_MENU_REMOVE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const PROJECT_CONTEXT_MENU_COPY_PATH_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const PROJECT_CONTEXT_MENU_ARCHIVE_ICON = renderToStaticMarkup(<HiOutlineArchiveBox />);
const PROJECT_CONTEXT_MENU_DELETE_THREADS_ICON = renderToStaticMarkup(<Trash2 />);

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

function ProviderGlyph({ provider, className }: { provider: ProviderKind; className?: string }) {
  if (provider === "claudeAgent") {
    return <ClaudeAI aria-hidden="true" className={cn("text-foreground", className)} />;
  }
  if (provider === "gemini") {
    return <Gemini aria-hidden="true" className={cn("text-foreground", className)} />;
  }
  return <OpenAI aria-hidden="true" className={cn("text-muted-foreground/60", className)} />;
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

type ThreadMetaChip = {
  id: "handoff" | "fork" | "worktree";
  tooltip: string;
  icon: ReactNode;
};

/**
 * Back-to-front order: first = behind, last = in front.
 * Priority lowest → highest: handoff → fork → worktree.
 */
function resolveThreadRowMetaChips(input: {
  thread: Pick<Thread, "forkSourceThreadId" | "envMode" | "worktreePath" | "handoff">;
  includeHandoffBadge: boolean;
}): ThreadMetaChip[] {
  const chips: ThreadMetaChip[] = [];

  const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(input.thread);
  if (input.includeHandoffBadge && handoffBadgeLabel) {
    chips.push({
      id: "handoff",
      tooltip: handoffBadgeLabel,
      icon: <FiGitBranch className="size-3 text-muted-foreground/55" />,
    });
  }

  if (input.thread.forkSourceThreadId) {
    chips.push({
      id: "fork",
      tooltip: "Forked thread",
      icon: <GoRepoForked className="size-3 text-emerald-600 dark:text-emerald-300/90" />,
    });
  }

  const worktreeBadgeLabel = resolveWorktreeBadgeLabel(input.thread);
  if (worktreeBadgeLabel) {
    chips.push({
      id: "worktree",
      tooltip: worktreeBadgeLabel,
      icon: <WorktreeBadgeGlyph className="size-3 text-muted-foreground/55" />,
    });
  }

  return chips;
}

function ThreadMetaChipStack({ chips }: { chips: ThreadMetaChip[] }) {
  if (chips.length === 0) {
    return <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center" />;
  }
  if (chips.length === 1) {
    const only = chips[0]!;
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
              {only.icon}
            </span>
          }
        />
        <TooltipPopup side="top">{only.tooltip}</TooltipPopup>
      </Tooltip>
    );
  }
  const tooltipText = chips.map((chip) => chip.tooltip).join(" · ");
  const chipSize = 14;
  const step = 8;
  const width = chipSize + step * (chips.length - 1);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className="relative h-3.5 shrink-0"
            style={{ width: `${width}px` }}
            aria-label={tooltipText}
          >
            {chips.map((chip, index) => (
              <span
                key={chip.id}
                className="absolute top-1/2 inline-flex size-3.5 -translate-y-1/2 items-center justify-center rounded-full bg-background shadow-xs"
                style={{ left: `${index * step}px`, zIndex: index + 1 }}
              >
                {chip.icon}
              </span>
            ))}
          </div>
        }
      />
      <TooltipPopup side="top">{tooltipText}</TooltipPopup>
    </Tooltip>
  );
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
      ? `${terminalCount} terminal${terminalCount === 1 ? "" : "s"} open`
      : (terminalStatus?.label ?? "Terminal open");
  const badgeColorClass = terminalStatus?.colorClass ?? "text-muted-foreground/55";

  const hasHandoff = Boolean(handoffSourceProvider);
  const containerClass = hasHandoff
    ? "relative inline-flex h-3.5 w-5 shrink-0 items-center"
    : "relative inline-flex size-3.5 shrink-0 items-center justify-center";

  const avatarNode = hasHandoff ? (
    <span className={containerClass}>
      <span className="absolute left-0 top-1/2 inline-flex size-3.5 -translate-y-1/2 items-center justify-center rounded-full bg-background shadow-xs">
        <ProviderGlyph provider={handoffSourceProvider!} className="size-2.5" />
      </span>
      <span className="absolute right-0 top-1/2 z-10 inline-flex size-3.5 -translate-y-1/2 items-center justify-center rounded-full bg-background shadow-xs">
        <ProviderGlyph provider={provider} className="size-2.5" />
      </span>
    </span>
  ) : (
    <span className={containerClass}>
      <ProviderGlyph provider={provider} className="size-3.5 opacity-80" />
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
                className="absolute -top-1.5 -right-1.5 inline-flex size-3 min-w-3 items-center justify-center rounded-full bg-background px-px shadow-xs"
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

type SidebarSplitPreview = {
  title: string;
  provider: ProviderKind;
  threadId: ThreadId | null;
};

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

function resolveSplitPreviewTitle(input: {
  thread: Pick<SidebarThreadSummary, "title"> | null;
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

function ThreadPrStatusBadge({
  prStatus,
  onOpen,
}: {
  prStatus: PrStatusIndicator;
  onOpen: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={prStatus.tooltip}
            className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
            onClick={(event) => {
              onOpen(event, prStatus.url);
            }}
          >
            <GitPullRequestIcon className="size-3" />
          </button>
        }
      />
      <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
    </Tooltip>
  );
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
      <Tooltip>
        <TooltipTrigger
          render={<MenuTrigger className="sidebar-icon-button inline-flex size-5 cursor-pointer" />}
        >
          <IoFilter className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">Sort chats</TooltipPopup>
      </Tooltip>
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
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  shortcutLabel?: string | null;
}) {
  const shortcutParts = shortcutLabel ? splitShortcutLabel(shortcutLabel) : [];

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="default"
        data-active={active}
        aria-current={active ? "page" : undefined}
        className="group/sidebar-primary-action h-8 gap-2.5 rounded-lg px-2 font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-foreground/82 transition-colors hover:bg-[var(--sidebar-accent)] data-[active=true]:bg-[var(--sidebar-accent-active)] data-[active=true]:text-[var(--sidebar-accent-foreground)]"
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={onClick}
      >
        <span className="inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground/72">
          <Icon className="size-[15px]" />
        </span>
        <span className="truncate">{label}</span>
        {shortcutParts.length > 0 ? (
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
  activeView,
  onSelectView,
}: {
  activeView: "threads" | "workspace";
  onSelectView: (view: "threads" | "workspace") => void;
}) {
  return (
    <div className="px-3 pb-2.5">
      <div className="inline-flex w-full rounded-md bg-[var(--color-background-elevated-secondary)] p-0.5">
        {(["threads", "workspace"] as const).map((view) => {
          const active = activeView === view;
          return (
            <button
              key={view}
              type="button"
              className={cn(
                "flex-1 rounded-sm px-2.5 py-1 text-[11.5px] font-medium tracking-tight transition-colors",
                active
                  ? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-xs"
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
  const projects = useStore((store) => store.projects);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const sidebarThreadSummaryById = useStore((store) => store.sidebarThreadSummaryById);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
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
  const pinnedThreadIds = usePinnedThreadsStore((store) => store.pinnedThreadIds);
  const togglePinnedThread = usePinnedThreadsStore((store) => store.togglePinnedThread);
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
  const isOnSettings = useLocation({ select: (loc) => loc.pathname === "/settings" });
  const isOnWorkspace = pathname.startsWith("/workspace");
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
  const [expandedSubagentParentIds, setExpandedSubagentParentIds] = useState<ReadonlySet<ThreadId>>(
    () => new Set(),
  );
  const autoRevealedSubagentThreadIdRef = useRef<ThreadId | null>(null);
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const lastThreadRenameTapRef = useRef<{ threadId: ThreadId; timestamp: number } | null>(null);
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
      sidebarDisplayThreads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        lastKnownPr: thread.lastKnownPr ?? null,
        cwd: resolveThreadWorkspaceCwd({
          projectCwd: projectCwdById.get(thread.projectId) ?? null,
          envMode: thread.envMode,
          worktreePath: thread.worktreePath,
        }),
      })),
    [projectCwdById, sidebarDisplayThreads],
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
    }> =>
      waitForRecoverableProjectInReadModel({
        projectId,
        loadSnapshot: () => api.orchestration.getSnapshot().catch(() => null),
        repairSnapshot: () => api.orchestration.repairState().catch(() => null),
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
      project: OrchestrationReadModel["projects"][number] | null;
      snapshot: OrchestrationReadModel | null;
    }> =>
      waitForRecoverableProjectInReadModel({
        workspaceRoot,
        loadSnapshot: () => api.orchestration.getSnapshot().catch(() => null),
        repairSnapshot: () => api.orchestration.repairState().catch(() => null),
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

      const restorableRoute = resolveSidebarRestorableThreadRoute({
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

      void handleNewChat({ fresh: true });
    },
    [
      handleNewChat,
      lastThreadRoute,
      navigate,
      navigateToWorkspace,
      routeWorkspaceId,
      sidebarThreadSummaryById,
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
          kind: "project",
          title,
          workspaceRoot: cwd,
          createWorkspaceRootIfMissing: options.createIfMissing === true,
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
          const { project, snapshot } = await waitForRecoverableProjectForDuplicateCreate({
            message: description,
            workspaceRoot: cwd,
            loadSnapshot: () => api.orchestration.getSnapshot().catch(() => null),
            repairSnapshot: () => api.orchestration.repairState().catch(() => null),
            maxAttempts: ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS,
            delayMs: ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS,
          });
          if (snapshot) {
            syncServerReadModel(snapshot);
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
            ? await recoverExistingProjectFromServer(api, ProjectId.makeUnsafe(duplicateProjectId))
            : await recoverExistingProjectByWorkspaceRootFromServer(api, cwd);
          if (recovered) {
            finishAddingProject();
            return;
          }

          setIsAddingProject(false);
          throw new Error(ADD_PROJECT_EXISTING_SYNC_ERROR);
        }
        setIsAddingProject(false);
        throw error instanceof Error ? error : new Error(description);
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
      syncServerReadModel,
      openExistingProjectFromSnapshot,
      setProjectExpanded,
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
    async (provider: "codex" | "claudeAgent", externalId: string) => {
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

      const modelSelection =
        activeProject.defaultModelSelection?.provider === provider
          ? activeProject.defaultModelSelection
          : {
              provider,
              model: DEFAULT_MODEL_BY_PROVIDER[provider],
            };
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const trimmedExternalId = externalId.trim();
      const suffix = trimmedExternalId.slice(-8);
      const title =
        provider === "claudeAgent"
          ? `Imported Claude session${suffix ? ` ${suffix}` : ""}`
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
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
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
        `Archive ${archivableThreads.length} thread${archivableThreads.length === 1 ? "" : "s"} in "${project.name}"?`,
        "Archived threads are hidden from the sidebar but can be restored later.",
      ];
      if (runningCount > 0) {
        archiveLines.push(
          "",
          `${runningCount} running thread${runningCount === 1 ? " is" : "s are"} currently active and will be skipped.`,
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
            ? ` Skipped ${runningCount} running thread${runningCount === 1 ? "" : "s"}.`
            : "";
        toastManager.add({
          type: failureCount > 0 ? "warning" : "success",
          title: archivedCount === 1 ? "Thread archived" : `Archived ${archivedCount} threads`,
          description:
            failureCount > 0
              ? `Failed to archive ${failureCount} thread${failureCount === 1 ? "" : "s"}.${skippedDescription}`
              : runningCount > 0
                ? skippedDescription.trim()
                : `"${project.name}" cleared.`,
        });
      } else if (failureCount > 0) {
        toastManager.add({
          type: "error",
          title: "Failed to archive threads",
          description: `Could not archive ${failureCount} thread${failureCount === 1 ? "" : "s"} in "${project.name}".`,
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
              `Delete ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"} in "${project.name}"?`,
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
                ? `Failed to delete ${failureCount} thread${failureCount === 1 ? "" : "s"}.`
                : `"${project.name}" cleared.`,
          });
        } else if (failureCount > 0) {
          toastManager.add({
            type: "error",
            title: "Failed to delete threads",
            description: `Could not delete ${failureCount} thread${failureCount === 1 ? "" : "s"} in "${project.name}".`,
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
      const handoffItems = handoffTargets.map((provider) => ({
        id: `handoff:${provider}`,
        label: `Handoff to ${PROVIDER_DISPLAY_NAMES[provider]}`,
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
          { id: "copy-path", label: "Copy Path" },
          ...(threadWorkspacePath
            ? [{ id: "open-path-in-terminal", label: "Open Path in Terminal" }]
            : []),
          { id: "copy-thread-id", label: "Copy Thread ID" },
          ...(options?.extraItems ?? []),
          { id: "archive", label: "Archive" },
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
        copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
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
          // For existing PTYs we deliberately skip api.terminal.open: the
          // server would otherwise tear down and respawn the shell whenever
          // the requested cwd differs from the session's recorded cwd, which
          // would silently kill any state the user already has set up (env
          // vars, shell history, etc.). Writing `cd` instead navigates in
          // place inside the live shell.
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
        copyThreadIdToClipboard(threadId, { threadId });
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
      pinnedThreadIdSet,
      projectCwdById,
      resolveThreadStatusForSidebar,
      sidebarThreadSummaryById,
      togglePinnedThread,
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
              `Archive ${count} thread${count === 1 ? "" : "s"}?`,
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

      const projectThreadsForMenu = sidebarThreads.filter(
        (thread) => thread.projectId === projectId,
      );
      const hasAnyThreads = projectThreadsForMenu.length > 0;
      const hasArchivableThreads = projectThreadsForMenu.some(
        (thread) => thread.archivedAt == null,
      );

      type ProjectContextMenuId =
        | "open-in-finder"
        | "copy-path"
        | "rename"
        | "archive-threads"
        | "delete-threads"
        | "delete";

      const items: {
        id: ProjectContextMenuId;
        label: string;
        icon: string;
        destructive?: boolean;
      }[] = [
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
      ];

      if (hasArchivableThreads) {
        items.push({
          id: "archive-threads",
          label: "Archive threads",
          icon: PROJECT_CONTEXT_MENU_ARCHIVE_ICON,
        });
      }
      if (hasAnyThreads) {
        items.push({
          id: "delete-threads",
          label: "Delete threads",
          icon: PROJECT_CONTEXT_MENU_DELETE_THREADS_ICON,
          destructive: true,
        });
      }

      items.push({
        id: "delete",
        label: "Remove",
        destructive: true,
        icon: PROJECT_CONTEXT_MENU_REMOVE_ICON,
      });

      const clicked = await showContextMenuFallback<ProjectContextMenuId>(items, position);

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
              `This will delete ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"} in this folder and remove the project.`,
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
            description: `Could not delete ${deletionResult.failureCount} thread${deletionResult.failureCount === 1 ? "" : "s"} in "${project.name}".`,
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
              ? `Deleted ${deletionResult.deletedCount} thread${deletionResult.deletedCount === 1 ? "" : "s"} and removed the project.`
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
      projects,
      sidebarThreads,
    ],
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
  const splitViewBySourceThreadId = useMemo(
    () => new Map(splitViews.map((splitView) => [splitView.sourceThreadId, splitView] as const)),
    [splitViews],
  );
  const splitViewsByProjectId = useMemo(() => groupSplitViewsByProjectId(splitViews), [splitViews]);
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
  const visibleChatThreadRows = useMemo(
    () =>
      buildProjectThreadTree({
        threads: sortThreadsForSidebar(
          chatProjects.flatMap((project) => sortedSidebarThreadsByProjectId.get(project.id) ?? []),
          appSettings.sidebarThreadSortOrder,
        ),
        expandedParentThreadIds: expandedSubagentParentIds,
      }),
    [
      appSettings.sidebarThreadSortOrder,
      chatProjects,
      expandedSubagentParentIds,
      sortedSidebarThreadsByProjectId,
    ],
  );
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
  const standardProjectSidebarDataById = useMemo<ReadonlyMap<ProjectId, SidebarDerivedProjectData>>(
    () =>
      deriveSidebarProjectData({
        projects: standardProjects,
        sortedSidebarThreadsByProjectId,
        splitViewsByProjectId,
        splitViewBySourceThreadId,
        pinnedThreadIds,
        pinnedThreadIdSet,
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
      pinnedThreadIdSet,
      pinnedThreadIds,
      sortedSidebarThreadsByProjectId,
      splitViewBySourceThreadId,
      splitViewsByProjectId,
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

    for (const project of standardProjects) {
      const projectSidebarData = standardProjectSidebarDataById.get(project.id);
      if (!projectSidebarData) {
        continue;
      }

      if (!project.expanded) {
        if (projectSidebarData.activeEntryId) {
          visibleThreadIds.push(projectSidebarData.activeEntryId);
        }
        continue;
      }

      visibleThreadIds.push(...projectSidebarData.visibleEntries.map((entry) => entry.rowId));
    }

    return visibleThreadIds;
  }, [pinnedThreads, standardProjects, standardProjectSidebarDataById]);
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
    });
    const releaseCallbacks = threadIdsToPrewarm.map((threadId) =>
      retainThreadDetailSubscription(threadId),
    );

    return () => {
      for (const release of releaseCallbacks) {
        release();
      }
    };
  }, [visibleSidebarThreadIds]);

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
      <button
        type="button"
        data-testid={`thread-archive-${threadId}`}
        aria-label="Archive thread"
        title="Archive thread"
        className={cn(
          "sidebar-icon-button inline-flex justify-center hover:text-foreground/82",
          compact ? "size-[18px]" : "size-5",
          toneClassName,
        )}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setPendingArchiveConfirmationThreadId(threadId);
        }}
      >
        <HiOutlineArchiveBox className={cn("shrink-0", compact ? "size-[11px]" : "size-3")} />
      </button>
    );
  }

  function renderThreadHoverActions(input: {
    threadId: ThreadId;
    toneClassName: string;
    compact?: boolean;
  }) {
    const compact = input.compact === true;
    const isPendingConfirmation = pendingArchiveConfirmationThreadId === input.threadId;

    if (isPendingConfirmation) {
      return (
        <div
          data-testid={`thread-hover-actions-${input.threadId}`}
          className="pointer-events-none absolute inset-y-0 right-0 my-auto inline-flex items-center opacity-100"
        >
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
        </div>
      );
    }

    return (
      <div
        data-testid={`thread-hover-actions-${input.threadId}`}
        className="pointer-events-none absolute inset-y-0 right-0 my-auto inline-flex items-center opacity-0 transition-opacity group-hover/thread-row:pointer-events-auto group-hover/thread-row:opacity-100 group-focus-within/thread-row:pointer-events-auto group-focus-within/thread-row:opacity-100"
      >
        {renderThreadArchiveAction(input.threadId, input.toneClassName, { compact })}
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
    const isActive = !activeSplitView && routeThreadId === thread.id;
    const projectLabel = resolvePinnedThreadProjectLabel(thread.projectId);
    const rightMetaChips = resolveThreadRowMetaChips({
      thread,
      includeHandoffBadge: true,
    });
    const threadStatus = resolveThreadStatusForSidebar(thread);
    const isSubagentThread = Boolean(thread.parentThreadId);
    const prStatus = prStatusIndicator(prByThreadId.get(thread.id) ?? null);
    const leadingPrStatus = isSubagentThread || thread.forkSourceThreadId ? null : prStatus;
    const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(thread);
    const threadJumpLabel = visibleThreadJumpLabelByThreadId.get(thread.id) ?? null;
    const threadJumpLabelParts =
      visibleThreadJumpLabelPartsByThreadId.get(thread.id) ?? EMPTY_SHORTCUT_PARTS;
    const pinnedTimestampClassName = isSubagentThread
      ? "mr-1 w-[1.2rem] text-right text-[10px] leading-none tabular-nums text-muted-foreground/26 transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0"
      : "mr-1 w-[1.625rem] text-right text-[length:var(--app-font-size-ui-meta,11px)] leading-none tabular-nums text-muted-foreground/38 transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0";

    return (
      <div key={thread.id} className="group/thread-row relative w-full">
        <div
          role="button"
          tabIndex={0}
          data-thread-item
          className={cn(
            "grid h-8 w-full grid-cols-[auto_auto_minmax(0,1fr)_auto_3.5rem] items-center gap-x-1.5 rounded-md px-2 text-left text-[length:var(--app-font-size-ui,12px)] transition-colors cursor-pointer",
            isActive
              ? "bg-[var(--sidebar-accent-active)] text-[var(--sidebar-accent-foreground)]"
              : "text-foreground/72 hover:bg-[var(--sidebar-accent)]",
          )}
          onClick={() => activateThread(thread.id)}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openRenameThreadDialog(thread.id);
          }}
          onPointerUp={(event) => handleThreadRenamePointerUp(event, thread.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              activateThread(thread.id);
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
          <div className="flex shrink-0 items-center gap-1.5">
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
            {threadStatus?.label === "Completed" ? (
              <HiOutlineCheckCircle
                aria-hidden="true"
                className={cn("size-3.5 shrink-0", threadStatus.colorClass)}
              />
            ) : threadStatus?.pulse ? (
              <ThreadRunningSpinner presentation="inline" />
            ) : null}
          </div>
          {threadEntryPoint === "terminal" ? (
            <TerminalIcon aria-hidden="true" className="size-3.5 shrink-0 text-teal-600/85" />
          ) : (
            <ProviderAvatarWithTerminal
              provider={thread.modelSelection.provider}
              handoffSourceProvider={thread.handoff?.sourceProvider ?? null}
              handoffTooltip={handoffBadgeLabel}
              terminalStatus={terminalStatus}
              terminalCount={terminalCount}
            />
          )}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            {leadingPrStatus ? (
              <ThreadPrStatusBadge prStatus={leadingPrStatus} onOpen={openPrLink} />
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate transition-opacity group-hover/thread-row:opacity-100",
                      isActive ? "opacity-100" : "opacity-80",
                    )}
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
            <div className="relative flex shrink-0 items-center justify-end gap-1">
              {!isPendingArchiveConfirmation ? (
                <ThreadMetaChipStack chips={rightMetaChips} />
              ) : null}
              {!isPendingArchiveConfirmation && threadJumpLabel ? (
                <KbdGroup>
                  {threadJumpLabelParts.map((part) => (
                    <Kbd key={part}>{part}</Kbd>
                  ))}
                </KbdGroup>
              ) : null}
              {!isPendingArchiveConfirmation && !threadJumpLabel ? (
                <span className={pinnedTimestampClassName}>
                  {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
                </span>
              ) : null}
              {renderThreadHoverActions({
                threadId: thread.id,
                toneClassName: "text-muted-foreground/42",
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
    const isActive = !activeSplitView && routeThreadId === thread.id;
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
    });
    const isSubagentThread = Boolean(thread.parentThreadId);
    const leadingPrStatus = isSubagentThread || thread.forkSourceThreadId ? null : prStatus;
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
    const childCountLabel = `${childCount} subagent${childCount === 1 ? "" : "s"}`;
    const trailingTimestampClassName = isSubagentThread
      ? cn(
          "mr-1 w-[1.2rem] text-right text-[10px] leading-none tabular-nums tracking-[-0.01em] transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
          isHighlighted ? "text-foreground/38 dark:text-foreground/46" : "text-muted-foreground/24",
        )
      : cn(
          "mr-1 w-[1.625rem] text-right text-[length:var(--app-font-size-ui-meta,11px)] leading-none tabular-nums transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
          secondaryMetaClass,
        );
    const toggleButtonClassName = isHighlighted
      ? "border-[color:var(--color-border)] bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]"
      : "border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] text-[var(--color-text-foreground-secondary)] hover:border-[color:var(--color-border)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]";

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
                "pointer-events-none absolute top-1/2 z-10 size-4 -translate-y-1/2 transition-opacity",
                isPinned ? "left-8" : "left-2",
                threadStatus.colorClass,
                "opacity-100 group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
              )}
            />
          ) : threadStatus.pulse ? (
            <ThreadRunningSpinner
              presentation="overlay"
              className={cn(
                isPinned ? "left-8" : "left-2.5",
                "opacity-100 group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
              )}
            />
          ) : (
            <span
              className={cn(
                "pointer-events-none absolute top-1/2 z-10 h-1.5 w-1.5 -translate-y-1/2 rounded-full transition-opacity",
                isPinned ? "left-8" : "left-3",
                threadStatus.dotClass,
                "opacity-100 group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
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
            openRenameThreadDialog(thread.id);
          }}
          onPointerUp={(event) => handleThreadRenamePointerUp(event, thread.id)}
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
          ) : (
            <ProviderAvatarWithTerminal
              provider={thread.modelSelection.provider}
              handoffSourceProvider={thread.handoff?.sourceProvider ?? null}
              handoffTooltip={handoffBadgeLabel}
              terminalStatus={terminalStatus}
              terminalCount={terminalCount}
            />
          )}
          <div
            className={cn(
              "flex min-w-0 flex-1 items-center text-left",
              isSubagentThread ? "gap-[5px]" : "gap-1.5",
            )}
          >
            {leadingPrStatus ? (
              <ThreadPrStatusBadge prStatus={leadingPrStatus} onOpen={openPrLink} />
            ) : null}
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
                  "min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] text-foreground/86 transition-opacity group-hover/thread-row:opacity-100",
                  isActive ? "opacity-100" : "opacity-80",
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
                  <ChevronDownIcon className="size-3" />
                ) : (
                  <ChevronRightIcon className="size-3" />
                )}
              </button>
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
          <div className={cn("absolute top-1/2 flex -translate-y-1/2 items-center", "right-1.5")}>
            <div className="relative flex shrink-0 items-center justify-end gap-1">
              {showCompactMeta && !isPendingArchiveConfirmation ? (
                <ThreadMetaChipStack chips={rightMetaChips} />
              ) : null}
              {!isPendingArchiveConfirmation && threadJumpLabel ? (
                <KbdGroup>
                  {threadJumpLabelParts.map((part) => (
                    <Kbd key={part}>{part}</Kbd>
                  ))}
                </KbdGroup>
              ) : null}
              {!isPendingArchiveConfirmation && !threadJumpLabel ? (
                <span className={trailingTimestampClassName}>
                  {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
                </span>
              ) : null}
              {renderThreadHoverActions({
                threadId: thread.id,
                toneClassName: secondaryMetaClass,
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
                    "flex min-w-0 flex-1 select-none items-center gap-1 rounded-md px-1.5 py-0.5 text-left outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-[color:var(--color-border-focus)]",
                    splitView.focusedPane === pane
                      ? "bg-[var(--color-background-button-secondary)] shadow-xs"
                      : "hover:bg-[var(--sidebar-accent)]",
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
            className={`h-7.5 gap-2 rounded-lg px-2 py-0.5 text-left text-[length:var(--app-font-size-ui,12px)] font-normal transition-[padding] duration-150 ease-out hover:bg-[var(--sidebar-accent)] group-hover/project-header:bg-[var(--sidebar-accent)] group-hover/project-header:pr-[4.75rem] group-hover/project-header:text-[var(--sidebar-accent-foreground)] group-focus-within/project-header:pr-[4.75rem] ${
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
                    className="h-7 w-full translate-x-0 justify-start rounded-lg pr-2 pl-8 text-left text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/72 hover:bg-[var(--sidebar-accent)]"
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
                    className="h-7 w-full translate-x-0 justify-start rounded-lg pr-2 pl-8 text-left text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/72 hover:bg-[var(--sidebar-accent)]"
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
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex !== null) {
        const threadJumpTargetId = threadJumpThreadIds[jumpIndex];
        if (!threadJumpTargetId) {
          return;
        }
        if (threadJumpTargetId === activeSidebarThreadId) return;
        event.preventDefault();
        event.stopPropagation();
        activateThread(threadJumpTargetId);
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
    activateThread,
    activeSidebarThreadId,
    keybindings,
    getCurrentSidebarShortcutContext,
    homeDir,
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
          : "bg-[var(--info)] hover:brightness-110";
  const desktopUpdateButtonHasSecondaryLabel =
    desktopUpdateButtonPresentation.secondaryLabel !== null;
  const desktopUpdateRowButtonClasses = cn(
    "inline-flex shrink-0 items-center justify-between gap-2 rounded-full px-2.5 text-left text-white transition-colors",
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
        description: "Attach a local thread to an existing Codex or Claude session.",
        keywords: ["import", "resume", "thread", "session", "codex", "claude"],
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
      persistAppStateNow();
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
                  className="h-8 gap-2.5 rounded-lg px-2 text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/72 hover:bg-[var(--sidebar-accent)] hover:text-foreground"
                  onClick={() => handleSidebarViewChange("threads")}
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
                              className="group/settings-nav-item h-7.5 w-full justify-start gap-2 rounded-lg px-2 py-0.5 text-[length:var(--app-font-size-ui,12px)] font-normal hover:bg-[var(--sidebar-accent)]"
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
                              <span
                                className={cn(
                                  "truncate text-[length:var(--app-font-size-ui,12px)] leading-5 transition-opacity group-hover/settings-nav-item:opacity-100",
                                  isActive ? "opacity-100" : "opacity-80",
                                )}
                              >
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
                                    className="h-7 w-full rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] px-2 text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)] outline-none focus:border-[color:var(--color-border-focus)]"
                                  />
                                </div>
                              ) : (
                                <SidebarMenuItem>
                                  <SidebarMenuButton
                                    size="sm"
                                    isActive={isActive}
                                    className="group/ws h-8 gap-2 rounded-lg px-2 font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-foreground/82 transition-colors hover:bg-[var(--sidebar-accent)] data-[active=true]:bg-[var(--sidebar-accent-active)] data-[active=true]:text-[var(--sidebar-accent-foreground)]"
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
                    <div className="my-1 flex items-center justify-between px-2 py-1">
                      <span className="text-[length:var(--app-font-size-ui,12px)] font-normal tracking-tight text-muted-foreground/58">
                        Pinned
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {pinnedThreads.map((thread) => renderPinnedThreadRow(thread))}
                    </div>
                    <div className="-mx-1.5 my-1.5 h-px bg-border/70" />
                  </>
                ) : (
                  <div className="-mx-1.5 my-1 h-px bg-border" />
                )}
                <div className="my-1 flex items-center justify-between px-2 py-1">
                  <span className="text-[length:var(--app-font-size-ui,12px)] font-normal tracking-tight text-muted-foreground/58">
                    Threads
                  </span>
                  <div className="-mr-1 flex items-center gap-1.5">
                    {standardProjects.length > 0 ? (
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
                            className="flex h-8 flex-1 items-center justify-center gap-2 rounded-lg bg-[var(--color-background-elevated-secondary)] px-2 text-[length:var(--app-font-size-ui,12px)] font-normal text-[var(--color-text-foreground-secondary)] transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-50"
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
                          className="flex h-8 flex-1 items-center justify-center gap-2 rounded-lg bg-[var(--color-background-elevated-secondary)] px-2 text-[length:var(--app-font-size-ui,12px)] font-normal text-[var(--color-text-foreground-secondary)] transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]"
                          onClick={() => setShowManualPathInput(true)}
                        >
                          <TbCursorText className="size-3.5" />
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

                {standardProjects.length === 0 && !shouldShowProjectPathEntry && (
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
      <SidebarFooter className="gap-2 p-2 font-system-ui">
        {!isOnSettings ? (
          <div className="group/collapsible">
            <div className="group/project-header relative">
              <SidebarMenuButton
                size="sm"
                className="h-7.5 gap-2 rounded-lg px-2 py-0.5 text-left text-[length:var(--app-font-size-ui,12px)] font-normal hover:bg-[var(--sidebar-accent)] group-hover/project-header:bg-[var(--sidebar-accent)] cursor-pointer"
                onClick={() => setChatSectionExpanded((current) => !current)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  setChatSectionExpanded((current) => !current);
                }}
              >
                <span className="relative inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/72">
                  <BsChat className="size-3.5" />
                </span>
                <div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
                  <span className="truncate font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/72">
                    Chats
                  </span>
                </div>
              </SidebarMenuButton>
              <div className="absolute top-1 right-1.5 flex items-center gap-1.5">
                <ChatSortMenu
                  threadSortOrder={appSettings.sidebarThreadSortOrder}
                  onThreadSortOrderChange={(sortOrder) => {
                    updateSettings({ sidebarThreadSortOrder: sortOrder });
                  }}
                />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label="Open new chat home"
                        className="sidebar-icon-button inline-flex size-5 cursor-pointer"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void handleCreateHomeChat();
                        }}
                      />
                    }
                  >
                    <SquarePenIcon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">New chat</TooltipPopup>
                </Tooltip>
              </div>
            </div>

            <div
              className={cn(
                "grid pt-1 transition-[grid-template-rows,opacity] duration-220 ease-out",
                chatSectionExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <SidebarMenu
                  className={cn(
                    "gap-1 transition-transform duration-220 ease-out",
                    chatSectionExpanded ? "translate-y-0" : "-translate-y-1 pointer-events-none",
                  )}
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
                        className="h-7 w-full justify-start rounded-lg pr-2 pl-8 text-left text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/72 hover:bg-[var(--sidebar-accent)]"
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
                        className="h-7 w-full justify-start rounded-lg pr-2 pl-8 text-left text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/72 hover:bg-[var(--sidebar-accent)]"
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
            <div className="flex items-center gap-2">
              {!isOnSettings && (
                <SidebarMenuButton
                  size="default"
                  className="h-8 flex-1 gap-2.5 rounded-lg px-2 text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/72 hover:bg-[var(--sidebar-accent)]"
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
                          {desktopUpdateButtonPresentation.secondaryLabel ? (
                            <span className="truncate text-[9px] text-white/80">
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
          onImportThread={handleImportThread}
          onOpenThread={(threadId) => {
            activateThread(ThreadId.makeUnsafe(threadId));
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
  onOpenProject: (projectId: string) => void;
  onImportThread: (provider: "codex" | "claudeAgent", externalId: string) => Promise<void>;
  onOpenThread: (threadId: string) => void;
}) {
  const selectAllThreads = useMemo(() => createAllThreadsSelector(), []);
  const selectSidebarDisplayThreads = useMemo(() => createSidebarDisplayThreadsSelector(), []);
  const threads = useStore(selectAllThreads);
  const sidebarDisplayThreads = useStore(selectSidebarDisplayThreads);
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
      onOpenProject={props.onOpenProject}
      onImportThread={props.onImportThread}
      onOpenThread={props.onOpenThread}
    />
  );
}
