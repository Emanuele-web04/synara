// FILE: ChatHeader.tsx
// Purpose: Renders the chat top bar with project actions and panel toggles.
// Layer: Chat shell header
// Depends on: project action controls, git actions, and panel toggle callbacks

import {
  type EditorId,
  type ProjectId,
  type ProjectScript,
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@synara/contracts";
import { isGenericChatThreadTitle } from "@synara/shared/chatThreads";
import React, { useEffect, useRef, useState } from "react";
import type { ThreadPrimarySurface } from "../../types";
import GitActionsControl from "../GitActionsControl";
import {
  CheckIcon,
  FoldersIcon,
  HandoffIcon,
  HistoryIcon,
  MessageCircleIcon,
  LayoutAlignRightIcon,
  LayoutRightIcon,
  PlusIcon,
  TerminalIcon,
  WorkflowIcon,
  XIcon,
  GitBranchIcon,
} from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import {
  CHAT_HEADER_TOGGLE_CLASS_NAME,
  ChatHeaderGroupDivider,
  ChatHeaderIconButton,
  SurfaceChipIcon,
  SurfaceTabChip,
  SurfaceTabStrip,
} from "./chatHeaderControls";
import { DiffStat } from "../ui/diff-stat";
import { IconButton } from "../ui/icon-button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { OpenInPicker } from "./OpenInPicker";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarHeaderNavigationControls } from "../SidebarHeaderNavigationControls";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { useAppSettings } from "../../appSettings";
import { useStore } from "../../store";
import { createSidebarDisplayThreadsSelector } from "../../storeSelectors";
import { sortThreadsForSidebar } from "../Sidebar.logic";
import {
  useOpenThreadTabs,
  useReadRouteThreadId,
  useRecordOpenThreadTab,
} from "../../hooks/useOpenThreadTabs";
import { useOptimisticTabSelection } from "../../hooks/useOptimisticTabSelection";
import { closeOpenThreadTab, createOpenThreadTabCloseQueue } from "../../openThreadTabs.logic";
import { useOpenThreadTabsStore } from "../../openThreadTabsStore";
import { StatusDot } from "~/components/ui/status-chip";
import { cn } from "~/lib/utils";
import { useOpenFavoriteEditorShortcut } from "~/hooks/useOpenFavoriteEditorShortcut";
import type { RepoDiffTotals } from "~/hooks/useRepoDiffTotals";
import { ProviderIcon } from "../ProviderIcon";
import { ProviderUsageMenuControl } from "../ProviderUsageMenuControl";
import { EnvironmentToggle, type EnvironmentToggleState } from "./environment/EnvironmentToggle";
import { SurfacePanelToggle, type SurfacePanelToggleState } from "./chatHeaderControls";
import type { ThreadHandoffTarget } from "~/lib/threadHandoff";

/**
 * Width (px) below which collapsible header controls drop their text labels and
 * fold into icon-only buttons. Measured on the header element itself, so it fires
 * for any layout that narrows the chat column (split chat, right dock, small window).
 */
const HEADER_COMPACT_BREAKPOINT = 700;

interface ChatHeaderProps {
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeThreadEntryPoint: ThreadPrimarySurface;
  activeProvider: ProviderKind;
  activeProjectName: string | undefined;
  threadBreadcrumbs: ReadonlyArray<{
    threadId: ThreadId;
    title: string;
  }>;
  className?: string;
  // Open-thread tabs rendered in place of the thread title (the rail shell's single chat).
  // They stay visible on the empty-draft landing so switching threads never loses the row.
  threadTabs?: React.ReactNode;
  hideSidebarControls?: boolean;
  hideHandoffControls?: boolean;
  // Empty-draft landings hide all thread-scoped chrome (title, Hand off, project
  // scripts, git/open-in) — the chat hasn't started yet — keeping only the sidebar
  // cluster plus the Environment and right-panel toggles.
  minimalChrome?: boolean;
  isGitRepo: boolean;
  openInTarget: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  diffToggleShortcutLabel: string | null;
  handoffActionLabel: string;
  handoffDisabled: boolean;
  handoffActionTargets: ReadonlyArray<ThreadHandoffTarget>;
  /** Subset of `handoffActionTargets` that can continue in this same thread. */
  continueHandoffActionTargets: ReadonlyArray<ThreadHandoffTarget>;
  // Coordinator threads pass false — a hand-off copy would read as a second
  // coordinator, so the action itself is hidden rather than disabled.
  showHandoffAction?: boolean;
  gitCwd: string | null;
  diffTotals: RepoDiffTotals;
  showGitActions?: boolean;
  showDiffToggle?: boolean;
  diffOpen: boolean;
  diffDisabledReason?: string | null;
  rightDockOpen?: boolean;
  onToggleRightDock?: () => void;
  surfaceMode?: "single" | "split";
  isSidechat?: boolean;
  // When provided, the header collapses the
  // Open-in-editor + git-actions + diff-toggle cluster into one Environment button that
  // drives the Environment panel; otherwise the legacy cluster is rendered.
  environment?: EnvironmentToggleState | null;
  projectPanel?: SurfacePanelToggleState | null;
  libraryPanel?: SurfacePanelToggleState | null;
  // Editor-rail chat controls rendered beside the title: a "new chat" button and
  // a project chat-history menu. Provided only by the editor workspace chat pane.
  editorChatControls?: {
    projectId: ProjectId;
    activeSurface: "chat" | "terminal";
    terminalAvailable: boolean;
    terminalHasRunningActivity: boolean;
    onNewChat: () => void;
    onNewTerminal: () => void;
    // Resolves once the navigation settles, so a closed tab can wait for it.
    onOpenChat: (threadId: ThreadId) => Promise<unknown>;
    onOpenTerminal: () => void;
    onCloseTerminal: () => void;
  } | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleDiff: () => void;
  onRegisterCommitAndPushTrigger?: (trigger: (() => void) | null) => void;
  onCreateHandoff: (target: ThreadHandoffTarget) => void;
  onContinueHandoff: (target: ThreadHandoffTarget) => void;
  onNavigateToThread: (threadId: ThreadId) => void;
  onRenameThread: () => void;
  onCloseThreadPane?: () => void;
}

const EDITOR_CHAT_HISTORY_LIMIT = 30;

// Compact recent-chats picker for the editor rail; selecting a thread keeps the
// editor view because the caller's navigation preserves the `view` search param.
function EditorChatHistoryMenu(props: {
  projectId: ProjectId;
  activeThreadId: ThreadId;
  onNavigateToThread: (threadId: ThreadId) => void;
}) {
  const { settings } = useAppSettings();
  const selectDisplayThreads = createSidebarDisplayThreadsSelector({
    hideAutomationRunThreads: !settings.showAutomationRunThreads,
  });
  const displayThreads = useStore(selectDisplayThreads);
  const historyThreads = sortThreadsForSidebar(
    displayThreads.filter((thread) => thread.projectId === props.projectId),
    settings.sidebarThreadSortOrder,
  ).slice(0, EDITOR_CHAT_HISTORY_LIMIT);

  return (
    <Menu modal={false}>
      <MenuTrigger
        render={
          <IconButton
            variant="ghost"
            size="icon-xs"
            label="Chat history"
            title="Chat history"
            className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <HistoryIcon className="size-3.5" />
          </IconButton>
        }
      />
      <ComposerPickerMenuPopup align="start" side="bottom" sideOffset={6} className="w-72 min-w-72">
        {historyThreads.length === 0 ? (
          <MenuItem disabled>No chats in this project yet</MenuItem>
        ) : (
          historyThreads.map((thread) => (
            <MenuItem
              key={thread.id}
              onClick={() => {
                if (thread.id !== props.activeThreadId) {
                  props.onNavigateToThread(thread.id);
                }
              }}
            >
              <ProviderIcon
                provider={thread.session?.provider ?? thread.modelSelection.provider}
                tone="header"
                className="size-3.5 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              {thread.id === props.activeThreadId ? (
                <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <span className="shrink-0 text-ui-xs text-muted-foreground tabular-nums">
                  {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
                </span>
              )}
            </MenuItem>
          ))
        )}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function EditorRailTabs(props: {
  projectId: ProjectId;
  activeThreadId: ThreadId;
  activeSurface: "chat" | "terminal";
  terminalAvailable: boolean;
  terminalHasRunningActivity: boolean;
  onNewChat: () => void;
  onNewTerminal: () => void;
  onOpenChat: (threadId: ThreadId) => Promise<unknown>;
  onOpenTerminal: () => void;
  onCloseTerminal: () => void;
}) {
  // The rail's chat tabs are this project's slice of the app-wide open threads, so a chat
  // opened or closed here is opened or closed in the chat header strip too.
  useRecordOpenThreadTab(props.activeSurface === "chat" ? props.activeThreadId : null);
  const chatTabs = useOpenThreadTabs({
    activeThreadId: props.activeThreadId,
    projectId: props.projectId,
  });
  const closeThreadTab = useOpenThreadTabsStore((state) => state.closeThreadTab);
  const readRouteThreadId = useReadRouteThreadId();
  const [enqueueClose] = useState(createOpenThreadTabCloseQueue);
  // Same click feedback as the chat header strip: the clicked chat tab highlights at once
  // and its thread opens after that frame. The terminal tab only flips a surface, so it
  // stays a direct switch.
  const activeTabKey = props.activeSurface === "chat" ? props.activeThreadId : "terminal";
  const {
    shownKey: shownTabKey,
    select: selectChatTab,
    cancel: cancelChatTabSelection,
  } = useOptimisticTabSelection<string>({
    activeKey: activeTabKey,
    hasTab: (key) => chatTabs.some((tab) => tab.threadId === key),
    activate: (key) => props.onOpenChat(key as ThreadId),
  });
  const [terminalTabOpen, setTerminalTabOpen] = useState(props.terminalAvailable);
  // Timeout-0 keeps the state write asynchronous (no wasted pre-paint render), which also
  // keeps this component eligible for React Compiler; the reveal is invisible at a tick.
  useEffect(() => {
    if (!props.terminalAvailable) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setTerminalTabOpen(true);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [props.terminalAvailable]);
  const terminalTabVisible = terminalTabOpen || props.terminalAvailable;
  const tabCount = chatTabs.length + (terminalTabVisible ? 1 : 0);
  const shouldShowTabs =
    tabCount > 1 ||
    (props.activeSurface === "chat" &&
      chatTabs.length > 0 &&
      !chatTabs.some((tab) => tab.threadId === props.activeThreadId));
  const newTerminalTab = () => {
    cancelChatTabSelection();
    setTerminalTabOpen(true);
    props.onNewTerminal();
  };
  const openTerminalTab = () => {
    cancelChatTabSelection();
    setTerminalTabOpen(true);
    props.onOpenTerminal();
  };
  const closeTerminalTab = () => {
    setTerminalTabOpen(false);
    props.onCloseTerminal();
  };
  const closeChatTab = (threadId: ThreadId) => {
    cancelChatTabSelection();
    // Same close flow as the chat header strip: the active chat's tab goes only once the
    // route has left it, so a guarded navigation keeps it in both places.
    void enqueueClose(() => {
      const openThreadIds = useOpenThreadTabsStore.getState().threadIds;
      return closeOpenThreadTab({
        tabs: chatTabs.filter((tab) => openThreadIds.includes(tab.threadId)),
        closedThreadId: threadId,
        activeThreadId: props.activeSurface === "chat" ? readRouteThreadId() : null,
        closeTab: closeThreadTab,
        openTab: props.onOpenChat,
        // The last chat tab gives way to the terminal tab, which keeps the thread's route.
        replaceLastTab: terminalTabVisible
          ? async () => {
              openTerminalTab();
              return { ok: true, leavesRoute: false };
            }
          : undefined,
        readRouteThreadId,
      });
    });
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 [-webkit-app-region:no-drag]">
      <div className="flex shrink-0 items-center gap-0.5">
        <Menu modal={false}>
          <MenuTrigger
            render={
              <IconButton
                variant="ghost"
                size="icon-xs"
                label="New editor rail item"
                title="New"
                className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
              >
                <PlusIcon className="size-3.5" />
              </IconButton>
            }
          />
          <ComposerPickerMenuPopup
            align="start"
            side="bottom"
            sideOffset={6}
            className="w-44 min-w-44"
          >
            <MenuItem onClick={props.onNewChat}>
              <MessageCircleIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span>New chat</span>
            </MenuItem>
            <MenuItem onClick={newTerminalTab}>
              <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span>New terminal</span>
            </MenuItem>
          </ComposerPickerMenuPopup>
        </Menu>
        <EditorChatHistoryMenu
          projectId={props.projectId}
          activeThreadId={props.activeThreadId}
          onNavigateToThread={props.onOpenChat}
        />
      </div>
      {shouldShowTabs ? (
        // Same chip tabs as the right dock's pane strip so every tab row in the
        // app reads identically. Pushed to the header's right edge (ml-auto) so the
        // title and new/history controls stay grouped on the left.
        <SurfaceTabStrip className="ml-auto" activeKey={shownTabKey}>
          {chatTabs.map((thread, index) => (
            <SurfaceTabChip
              key={thread.threadId}
              active={thread.threadId === shownTabKey}
              title={thread.title}
              label={`Chat ${index + 1}`}
              labelClassName="max-w-24"
              icon={
                <ProviderIcon
                  provider={thread.provider}
                  tone="header"
                  className="size-3 shrink-0"
                />
              }
              closeLabel={`Close ${thread.title}`}
              onSelect={() => selectChatTab(thread.threadId)}
              onClose={() => closeChatTab(thread.threadId)}
            />
          ))}
          {terminalTabVisible ? (
            <SurfaceTabChip
              active={shownTabKey === "terminal"}
              title="Terminal"
              label="Terminal"
              labelClassName="max-w-24"
              icon={<TerminalIcon className="size-3 shrink-0 text-[var(--color-text-accent)]" />}
              trailing={
                props.terminalHasRunningActivity ? (
                  <StatusDot className="bg-emerald-500/80" />
                ) : null
              }
              onSelect={openTerminalTab}
              closeLabel="Close Terminal"
              onClose={closeTerminalTab}
            />
          ) : null}
        </SurfaceTabStrip>
      ) : null}
    </div>
  );
}

export type ChatHeaderThreadIconKind = "none" | "provider" | "terminal";

function resolveChatHeaderThreadIconKind(
  entryPoint: ThreadPrimarySurface,
  title?: string,
): ChatHeaderThreadIconKind {
  if (entryPoint === "chat" && isGenericChatThreadTitle(title)) {
    return "none";
  }
  return entryPoint === "terminal" ? "terminal" : "provider";
}

export function ChatHeader({
  activeThreadId,
  activeThreadTitle,
  activeThreadEntryPoint,
  activeProvider,
  activeProjectName,
  threadBreadcrumbs,
  className,
  threadTabs,
  hideSidebarControls: hideSidebarControlsProp,
  hideHandoffControls: hideHandoffControlsProp,
  minimalChrome: minimalChromeProp,
  isGitRepo,
  openInTarget,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  diffToggleShortcutLabel,
  handoffActionLabel,
  handoffDisabled,
  handoffActionTargets,
  continueHandoffActionTargets,
  showHandoffAction: showHandoffActionProp,
  gitCwd,
  diffTotals,
  showGitActions: showGitActionsProp,
  showDiffToggle: showDiffToggleProp,
  diffOpen,
  diffDisabledReason: diffDisabledReasonProp,
  rightDockOpen: rightDockOpenProp,
  onToggleRightDock,
  surfaceMode: surfaceModeProp,
  isSidechat: isSidechatProp,
  environment: environmentProp,
  projectPanel = null,
  libraryPanel = null,
  editorChatControls: editorChatControlsProp,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleDiff,
  onRegisterCommitAndPushTrigger,
  onCreateHandoff,
  onContinueHandoff,
  onNavigateToThread,
  onRenameThread,
  onCloseThreadPane,
}: ChatHeaderProps) {
  const hideSidebarControls = hideSidebarControlsProp ?? false;
  const hideHandoffControls = hideHandoffControlsProp ?? false;
  const showHandoffAction = showHandoffActionProp ?? true;
  const minimalChrome = minimalChromeProp ?? false;
  const showGitActions = showGitActionsProp ?? true;
  const showDiffToggle = showDiffToggleProp ?? true;
  const diffDisabledReason = diffDisabledReasonProp ?? null;
  const rightDockOpen = rightDockOpenProp ?? false;
  const surfaceMode = surfaceModeProp ?? "single";
  const isSidechat = isSidechatProp ?? false;
  const environment = environmentProp ?? null;
  const editorChatControls = editorChatControlsProp ?? null;
  const headerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const { additions: diffAdditions, deletions: diffDeletions, hasChanges } = diffTotals;

  // Own the open-favorite editor shortcut here so it survives regardless of which editor UI
  // is mounted (the legacy Open-in button, the Environment panel's Editor section, or
  // neither while the panel is closed). The header is always present for a project thread.
  useOpenFavoriteEditorShortcut({
    keybindings,
    availableEditors,
    openInTarget,
    enabled: Boolean(activeProjectName),
  });

  const isSplitPane = surfaceMode === "split";
  const showDiffTotals = hasChanges && !isSplitPane;
  const threadIconKind = resolveChatHeaderThreadIconKind(activeThreadEntryPoint, activeThreadTitle);
  const showSidechatTitleChip = isSidechat && compact;

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const measure = () => setCompact(isSplitPane || el.clientWidth < HEADER_COMPACT_BREAKPOINT);
    measure();
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [isSplitPane]);

  const renderProviderIcon = (provider: ProviderKind | null, className: string) => {
    return (
      <ProviderIcon
        provider={provider}
        tone="header"
        className={className}
        fallback={<GitBranchIcon className={className} />}
      />
    );
  };

  // Single-chat surfaces use this as a true right-dock visibility toggle. Hosts
  // without a multi-pane dock (split/editor surfaces) keep the legacy diff-only
  // behavior until they gain their own launcher surface.
  const togglesRightDock = onToggleRightDock !== undefined;
  const hasActionControls =
    !minimalChrome && (!hideHandoffControls || activeProjectScripts !== undefined);
  const rightPanelToggleControl = showDiffToggle ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className={cn(
              CHAT_HEADER_TOGGLE_CLASS_NAME,
              togglesRightDock || !showDiffTotals
                ? "!size-7 [&_svg,&_[data-slot=central-icon]]:mx-0"
                : null,
            )}
            pressed={togglesRightDock ? rightDockOpen : diffOpen}
            onPressedChange={togglesRightDock ? onToggleRightDock : onToggleDiff}
            aria-label={togglesRightDock ? "Toggle right sidebar" : "Toggle diff panel"}
            variant="default"
            size="xs"
            disabled={
              togglesRightDock ? false : !isGitRepo || (diffDisabledReason !== null && !diffOpen)
            }
          >
            {!togglesRightDock && showDiffTotals ? (
              <DiffStat
                className="font-system-ui text-ui-sm sm:text-ui-xs font-normal tracking-normal"
                insertions={diffAdditions}
                deletions={diffDeletions}
              />
            ) : null}
            <SurfaceChipIcon
              icon={
                (togglesRightDock ? rightDockOpen : diffOpen)
                  ? LayoutRightIcon
                  : LayoutAlignRightIcon
              }
              className="size-4"
            />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {togglesRightDock
          ? rightDockOpen
            ? "Close right sidebar"
            : "Open right sidebar"
          : !isGitRepo
            ? "Diff panel is unavailable because this project is not a git repository."
            : diffDisabledReason && !diffOpen
              ? diffDisabledReason
              : diffToggleShortcutLabel
                ? `Toggle diff panel (${diffToggleShortcutLabel})`
                : "Toggle diff panel"}
      </TooltipPopup>
    </Tooltip>
  ) : null;

  const breadcrumbLinks = threadBreadcrumbs.map((breadcrumb, index) => (
    <React.Fragment key={breadcrumb.threadId}>
      {index > 0 ? <span className="shrink-0 text-muted-foreground/35">/</span> : null}
      <button
        type="button"
        className="min-w-0 truncate transition-colors hover:text-foreground/80"
        title={breadcrumb.title}
        onClick={() => onNavigateToThread(breadcrumb.threadId)}
      >
        {breadcrumb.title}
      </button>
    </React.Fragment>
  ));
  return (
    <div ref={headerRef} className={cn("flex min-w-0 flex-1 items-center gap-2", className)}>
      <div
        className={cn(
          // Keep the whole leading/header surface draggable when the chat pane
          // is mounted inside the frameless Electron window. Interactive
          // descendants are excluded by the shared `.drag-region` rules and
          // their explicit no-drag controls, while the empty space between
          // them remains a reliable caption target.
          "drag-region flex min-w-0 flex-1 items-center",
          editorChatControls ? "h-full overflow-visible" : "overflow-hidden",
          "gap-2 sm:gap-3",
        )}
      >
        {hideSidebarControls ? null : (
          // The extra end padding keeps the wider gap the collapsed header had (gap-4).
          <SidebarHeaderNavigationControls
            className="md:pe-1"
            collapsedGapClassName="-me-2 sm:-me-3"
          />
        )}
        {threadTabs ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {!minimalChrome && threadBreadcrumbs.length > 0 ? (
              // Inline lineage for a subagent thread: the tabs own the row, so its
              // parents sit ahead of them instead of stacked above the title.
              <div className="flex min-w-0 max-w-[30%] shrink-0 items-center gap-1 overflow-hidden text-ui-sm text-muted-foreground/55">
                {breadcrumbLinks}
                <span className="shrink-0 text-muted-foreground/35">/</span>
              </div>
            ) : null}
            {threadTabs}
          </div>
        ) : (
          <div
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2",
              editorChatControls && "h-full",
              minimalChrome && "hidden",
            )}
          >
            <div
              className={cn(
                "flex min-w-0 flex-1 flex-col",
                editorChatControls && "h-full justify-center",
              )}
            >
              {threadBreadcrumbs.length > 0 ? (
                <div className="flex min-w-0 items-center gap-1 overflow-hidden text-ui-sm text-muted-foreground/55">
                  {breadcrumbLinks}
                </div>
              ) : null}
              <div
                className={cn("flex min-w-0 items-center gap-2", editorChatControls && "h-full")}
              >
                <div
                  className={cn(
                    "flex min-w-0 items-center gap-2",
                    showSidechatTitleChip &&
                      "rounded-lg bg-secondary py-1 pl-2 pr-1 text-secondary-foreground",
                  )}
                >
                  {threadIconKind === "none" ? null : (
                    <span
                      className="inline-flex size-3.5 shrink-0 items-center justify-center"
                      title={
                        threadIconKind === "terminal"
                          ? "Terminal"
                          : PROVIDER_DISPLAY_NAMES[activeProvider]
                      }
                    >
                      {threadIconKind === "terminal" ? (
                        <TerminalIcon className="size-3.5 text-[var(--color-text-accent)]" />
                      ) : (
                        renderProviderIcon(activeProvider, "size-3.5")
                      )}
                    </span>
                  )}
                  <h2
                    className="max-w-[clamp(12rem,42vw,36rem)] truncate font-system-ui text-ui font-normal text-foreground [-webkit-app-region:no-drag]"
                    title={activeThreadTitle}
                    onDoubleClick={() => onRenameThread()}
                  >
                    {activeThreadTitle}
                  </h2>
                  {showSidechatTitleChip && !isSplitPane && onCloseThreadPane ? (
                    <IconButton
                      variant="chrome"
                      size="icon-xs"
                      label="Close selected Side"
                      tooltip="Close selected Side"
                      tooltipSide="bottom"
                      className="size-5 rounded-lg [-webkit-app-region:no-drag] [&_svg]:size-3"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCloseThreadPane();
                      }}
                    >
                      <XIcon />
                    </IconButton>
                  ) : null}
                </div>
                {editorChatControls ? (
                  <EditorRailTabs
                    projectId={editorChatControls.projectId}
                    activeThreadId={activeThreadId}
                    activeSurface={editorChatControls.activeSurface}
                    terminalAvailable={editorChatControls.terminalAvailable}
                    terminalHasRunningActivity={editorChatControls.terminalHasRunningActivity}
                    onNewChat={editorChatControls.onNewChat}
                    onNewTerminal={editorChatControls.onNewTerminal}
                    onOpenChat={editorChatControls.onOpenChat}
                    onOpenTerminal={editorChatControls.onOpenTerminal}
                    onCloseTerminal={editorChatControls.onCloseTerminal}
                  />
                ) : null}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
        {!minimalChrome && !hideHandoffControls && !environment ? (
          <ProviderUsageMenuControl provider={activeProvider} />
        ) : null}
        {!minimalChrome && !hideHandoffControls && showHandoffAction ? (
          <Menu modal={false}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <ChatHeaderIconButton
                        type="button"
                        tone="surface"
                        label={handoffActionLabel}
                        disabled={handoffDisabled || handoffActionTargets.length === 0}
                      />
                    }
                  >
                    <HandoffIcon className="size-4 shrink-0" />
                  </MenuTrigger>
                }
              />
              <TooltipPopup side="bottom">{handoffActionLabel}</TooltipPopup>
            </Tooltip>
            <ComposerPickerMenuPopup align="end" side="bottom" className="w-56 min-w-56">
              {continueHandoffActionTargets.length > 0 ? (
                <>
                  <MenuGroup>
                    <MenuGroupLabel>Continue in this thread</MenuGroupLabel>
                    {continueHandoffActionTargets.map((target) => (
                      <MenuItem
                        key={target.instanceId}
                        data-handoff-destination="this-thread"
                        onClick={() => onContinueHandoff(target)}
                      >
                        {/* opacity-100 opts brand icons out of the option row's 80% icon dim. */}
                        {renderProviderIcon(target.provider, "size-3.5 shrink-0 opacity-100")}
                        <span>{target.label}</span>
                      </MenuItem>
                    ))}
                  </MenuGroup>
                  <MenuSeparator />
                </>
              ) : null}
              <MenuGroup>
                <MenuGroupLabel>Continue in a new thread</MenuGroupLabel>
                {handoffActionTargets.map((target) => (
                  <MenuItem
                    key={target.instanceId}
                    data-handoff-destination="new-thread"
                    onClick={() => onCreateHandoff(target)}
                  >
                    {renderProviderIcon(target.provider, "size-3.5 shrink-0 opacity-100")}
                    <span>{target.label}</span>
                  </MenuItem>
                ))}
              </MenuGroup>
            </ComposerPickerMenuPopup>
          </Menu>
        ) : null}
        {!minimalChrome && activeProjectScripts ? (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        ) : null}

        {!minimalChrome && environment && activeProjectName && showGitActions ? (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadId={activeThreadId}
            hideQuickActionLabel
            visibleWhen="pull-available"
          />
        ) : null}

        {/* Environment: one button consolidating Open-in-editor and most git actions into
            the Environment panel. Pull still appears in this action cluster when the
            branch is behind. The right-side panel control stays beside it, acting as the
            multi-pane dock toggle on single chats and the legacy diff toggle in split hosts.
            Falls back to the legacy controls when no environment is resolved. */}
        {environment ? (
          <>
            {/* Actions on the left, panel toggles on the right. */}
            {hasActionControls ? <ChatHeaderGroupDivider /> : null}
            <EnvironmentToggle environment={environment} />
            {projectPanel ? (
              <SurfacePanelToggle
                state={projectPanel}
                icon={WorkflowIcon}
                ariaLabel="Toggle hub panel"
                tooltip="Hub"
              />
            ) : null}
            {libraryPanel ? (
              <SurfacePanelToggle
                state={libraryPanel}
                icon={FoldersIcon}
                ariaLabel="Toggle library panel"
                tooltip="Library"
              />
            ) : null}
            {rightPanelToggleControl}
          </>
        ) : (
          <>
            {/* Open in editor: dedicated split-button with an editor switcher; the project
                action control sits beside it as its own project command surface. */}
            {!minimalChrome && activeProjectName ? (
              <OpenInPicker
                keybindings={keybindings}
                availableEditors={availableEditors}
                openInTarget={openInTarget}
              />
            ) : null}

            {!minimalChrome && activeProjectName && showGitActions ? (
              <GitActionsControl
                gitCwd={gitCwd}
                activeThreadId={activeThreadId}
                hideQuickActionLabel={compact}
                onRegisterCommitAndPushTrigger={onRegisterCommitAndPushTrigger}
              />
            ) : null}
            {rightPanelToggleControl}
          </>
        )}
        {isSplitPane && onCloseThreadPane ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <ChatHeaderIconButton
                  type="button"
                  tone="surface"
                  label="Close chat"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseThreadPane();
                  }}
                >
                  <XIcon className="size-4" />
                </ChatHeaderIconButton>
              }
            />
            <TooltipPopup side="bottom">Close chat</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
