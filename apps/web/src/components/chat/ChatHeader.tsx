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
} from "@t3tools/contracts";
import { isGenericChatThreadTitle } from "@t3tools/shared/chatThreads";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiGitBranch } from "react-icons/fi";
import { HiMiniArrowsPointingOut } from "react-icons/hi2";
import { TbExchange } from "react-icons/tb";
import type { ThreadPrimarySurface } from "../../types";
import GitActionsControl from "../GitActionsControl";
import {
  ArrowRightIcon,
  CheckIcon,
  HandoffIcon,
  HistoryIcon,
  MessageCircleIcon,
  PanelRightCloseIcon,
  PlusIcon,
  TerminalIcon,
  XIcon,
} from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import {
  CHAT_HEADER_TOGGLE_CLASS_NAME,
  ChatHeaderButton,
  ChatHeaderIconButton,
  SurfaceChipIcon,
  SurfaceTabChip,
} from "./chatHeaderControls";
import { IconButton } from "../ui/icon-button";
import { Badge } from "../ui/badge";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { OpenInPicker } from "./OpenInPicker";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarHeaderNavigationControls } from "../SidebarHeaderNavigationControls";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { useSidebar } from "../ui/sidebar";
import { useAppSettings } from "../../appSettings";
import { useStore } from "../../store";
import { createSidebarDisplayThreadsSelector } from "../../storeSelectors";
import { sortThreadsForSidebar } from "../Sidebar.logic";
import {
  readEditorRailChatTabs,
  storeEditorRailChatTabs,
  type EditorRailChatTabSnapshot,
} from "../../editorViewState";
import { cn } from "~/lib/utils";
import { useIsDisposableThread } from "~/hooks/useIsDisposableThread";
import { useOpenFavoriteEditorShortcut } from "~/hooks/useOpenFavoriteEditorShortcut";
import type { RepoDiffTotals } from "~/hooks/useRepoDiffTotals";
import { ProviderIcon } from "../ProviderIcon";
import { ProviderUsageMenuControl } from "../ProviderUsageMenuControl";
import { EnvironmentToggle, type EnvironmentToggleState } from "./environment/EnvironmentToggle";

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
  hideSidebarControls?: boolean;
  hideHandoffControls?: boolean;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  diffToggleShortcutLabel: string | null;
  handoffBadgeLabel: string | null;
  handoffActionLabel: string;
  handoffDisabled: boolean;
  handoffActionTargetProviders: ReadonlyArray<ProviderKind>;
  handoffBadgeSourceProvider: ProviderKind | null;
  handoffBadgeTargetProvider: ProviderKind | null;
  gitCwd: string | null;
  diffTotals: RepoDiffTotals;
  showGitActions?: boolean;
  showDiffToggle?: boolean;
  diffOpen: boolean;
  diffDisabledReason?: string | null;
  surfaceMode?: "single" | "split";
  isSidechat?: boolean;
  // When provided (and the thread is not disposable), the header collapses the
  // Open-in-editor + git-actions + diff-toggle cluster into one Environment button that
  // drives the Environment panel; otherwise the legacy cluster is rendered.
  environment?: EnvironmentToggleState | null;
  chatLayoutAction?: {
    kind: "split" | "maximize";
    label: string;
    shortcutLabel: string | null;
    onClick: () => void;
  } | null;
  changeThreadAction?: {
    label: string;
    onClick: () => void;
  } | null;
  // Editor-rail chat controls rendered beside the title: a "new chat" button and
  // a project chat-history menu. Provided only by the editor workspace chat pane.
  editorChatControls?: {
    projectId: ProjectId;
    activeSurface: "chat" | "terminal";
    terminalAvailable: boolean;
    terminalHasRunningActivity: boolean;
    onNewChat: () => void;
    onNewTerminal: () => void;
    onOpenChat: (threadId: ThreadId) => void;
    onOpenTerminal: () => void;
    onCloseTerminal: () => void;
  } | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleDiff: () => void;
  onCreateHandoff: (targetProvider: ProviderKind) => void;
  onNavigateToThread: (threadId: ThreadId) => void;
  onRenameThread: () => void;
  onCloseThreadPane?: () => void;
}

const EDITOR_CHAT_HISTORY_LIMIT = 30;

type EditorRailChatTab = EditorRailChatTabSnapshot;

// Compact recent-chats picker for the editor rail; selecting a thread keeps the
// editor view because the caller's navigation preserves the `view` search param.
function EditorChatHistoryMenu(props: {
  projectId: ProjectId;
  activeThreadId: ThreadId;
  onNavigateToThread: (threadId: ThreadId) => void;
}) {
  const { settings } = useAppSettings();
  const selectDisplayThreads = useMemo(() => createSidebarDisplayThreadsSelector(), []);
  const displayThreads = useStore(selectDisplayThreads);
  const historyThreads = useMemo(
    () =>
      sortThreadsForSidebar(
        displayThreads.filter((thread) => thread.projectId === props.projectId),
        settings.sidebarThreadSortOrder,
      ).slice(0, EDITOR_CHAT_HISTORY_LIMIT),
    [displayThreads, props.projectId, settings.sidebarThreadSortOrder],
  );

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
                <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
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
  activeThreadTitle: string;
  activeProvider: ProviderKind;
  activeSurface: "chat" | "terminal";
  terminalAvailable: boolean;
  terminalHasRunningActivity: boolean;
  onNewChat: () => void;
  onNewTerminal: () => void;
  onOpenChat: (threadId: ThreadId) => void;
  onOpenTerminal: () => void;
  onCloseTerminal: () => void;
  onNavigateToThread: (threadId: ThreadId) => void;
}) {
  const { settings } = useAppSettings();
  const [openChatTabs, setOpenChatTabs] = useState<ReadonlyArray<EditorRailChatTab>>(() => {
    const storedTabs = readEditorRailChatTabs(props.projectId);
    return storedTabs.length > 0
      ? storedTabs
      : [
          {
            id: props.activeThreadId,
            title: props.activeThreadTitle,
            provider: props.activeProvider,
          },
        ];
  });
  const [terminalTabOpen, setTerminalTabOpen] = useState(props.terminalAvailable);
  const selectDisplayThreads = useMemo(() => createSidebarDisplayThreadsSelector(), []);
  const displayThreads = useStore(selectDisplayThreads);
  const currentChatTab = useMemo<EditorRailChatTab>(
    () => ({
      id: props.activeThreadId,
      title: props.activeThreadTitle,
      provider: props.activeProvider,
    }),
    [props.activeProvider, props.activeThreadId, props.activeThreadTitle],
  );
  const setAndStoreOpenChatTabs = useCallback(
    (updater: (current: ReadonlyArray<EditorRailChatTab>) => ReadonlyArray<EditorRailChatTab>) => {
      setOpenChatTabs((current) => {
        const next = updater(current);
        storeEditorRailChatTabs(props.projectId, next);
        return next;
      });
    },
    [props.projectId],
  );
  useEffect(() => {
    const storedTabs = readEditorRailChatTabs(props.projectId);
    setOpenChatTabs(
      storedTabs.length > 0
        ? storedTabs
        : [
            {
              id: props.activeThreadId,
              title: props.activeThreadTitle,
              provider: props.activeProvider,
            },
          ],
    );
  }, [props.activeProvider, props.activeThreadId, props.activeThreadTitle, props.projectId]);
  useEffect(() => {
    if (props.terminalAvailable) {
      setTerminalTabOpen(true);
    }
  }, [props.terminalAvailable]);
  useEffect(() => {
    if (props.activeSurface !== "chat") {
      return;
    }
    setAndStoreOpenChatTabs((current) => {
      const existingIndex = current.findIndex((thread) => thread.id === currentChatTab.id);
      if (existingIndex < 0) {
        return [...current, currentChatTab];
      }
      const existing = current[existingIndex];
      if (
        existing?.title === currentChatTab.title &&
        existing.provider === currentChatTab.provider
      ) {
        return current;
      }
      return current.map((thread) => (thread.id === currentChatTab.id ? currentChatTab : thread));
    });
  }, [currentChatTab, props.activeSurface, setAndStoreOpenChatTabs]);
  const chatTabs = useMemo(() => {
    const sortedProjectThreads = sortThreadsForSidebar(
      displayThreads.filter((thread) => thread.projectId === props.projectId),
      settings.sidebarThreadSortOrder,
    );
    const sidebarThreadById = new Map(
      sortedProjectThreads.map((thread) => [
        thread.id,
        {
          id: thread.id,
          title: thread.title,
          provider: thread.session?.provider ?? thread.modelSelection.provider,
        },
      ]),
    );
    const activeChatAlreadyOpen = openChatTabs.some((thread) => thread.id === props.activeThreadId);
    const orderedOpenTabs =
      props.activeSurface === "chat" && !activeChatAlreadyOpen
        ? [...openChatTabs, currentChatTab]
        : openChatTabs;
    return orderedOpenTabs.map((thread) => sidebarThreadById.get(thread.id) ?? thread);
  }, [
    currentChatTab,
    displayThreads,
    props.activeSurface,
    props.activeThreadId,
    openChatTabs,
    props.projectId,
    settings.sidebarThreadSortOrder,
  ]);
  const terminalTabVisible = terminalTabOpen || props.terminalAvailable;
  const tabCount = chatTabs.length + (terminalTabVisible ? 1 : 0);
  const shouldShowTabs = tabCount > 1;
  const newTerminalTab = () => {
    setTerminalTabOpen(true);
    props.onNewTerminal();
  };
  const openTerminalTab = () => {
    setTerminalTabOpen(true);
    props.onOpenTerminal();
  };
  const closeTerminalTab = () => {
    setTerminalTabOpen(false);
    props.onCloseTerminal();
  };
  const openChatTab = (threadId: ThreadId) => {
    const sidebarThread = displayThreads.find((thread) => thread.id === threadId);
    if (sidebarThread) {
      const nextTab = {
        id: sidebarThread.id,
        title: sidebarThread.title,
        provider: sidebarThread.session?.provider ?? sidebarThread.modelSelection.provider,
      };
      setAndStoreOpenChatTabs((current) =>
        current.some((thread) => thread.id === threadId) ? current : [...current, nextTab],
      );
    }
    props.onOpenChat(threadId);
  };
  const closeChatTab = (threadId: ThreadId) => {
    const closingActiveChat = props.activeSurface === "chat" && threadId === props.activeThreadId;
    const nextChatTab = chatTabs.find((thread) => thread.id !== threadId);
    setAndStoreOpenChatTabs((current) => current.filter((thread) => thread.id !== threadId));
    if (!closingActiveChat) {
      return;
    }
    if (nextChatTab) {
      props.onOpenChat(nextChatTab.id);
      return;
    }
    if (terminalTabVisible) {
      openTerminalTab();
    }
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
              <TerminalIcon className="size-3.5 shrink-0 text-[var(--color-text-accent)]" />
              <span>New terminal</span>
            </MenuItem>
          </ComposerPickerMenuPopup>
        </Menu>
        <EditorChatHistoryMenu
          projectId={props.projectId}
          activeThreadId={props.activeThreadId}
          onNavigateToThread={openChatTab}
        />
      </div>
      {shouldShowTabs ? (
        // Same chip tabs as the right dock's pane strip so every tab row in the
        // app reads identically. Pushed to the header's right edge (ml-auto) so the
        // title and new/history controls stay grouped on the left.
        <div className="ml-auto flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {chatTabs.map((thread, index) => (
            <SurfaceTabChip
              key={thread.id}
              active={props.activeSurface === "chat" && thread.id === props.activeThreadId}
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
              onSelect={() => openChatTab(thread.id)}
              onClose={() => closeChatTab(thread.id)}
            />
          ))}
          {terminalTabVisible ? (
            <SurfaceTabChip
              active={props.activeSurface === "terminal"}
              title="Terminal"
              label="Terminal"
              labelClassName="max-w-24"
              icon={<TerminalIcon className="size-3 shrink-0 text-[var(--color-text-accent)]" />}
              trailing={
                props.terminalHasRunningActivity ? (
                  <span className="size-1.5 shrink-0 rounded-full bg-emerald-500/80" />
                ) : null
              }
              onSelect={openTerminalTab}
              closeLabel="Close Terminal"
              onClose={closeTerminalTab}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export type ChatHeaderThreadIconKind = "none" | "provider" | "terminal";

export function resolveChatHeaderThreadIconKind(
  entryPoint: ThreadPrimarySurface,
  title?: string,
): ChatHeaderThreadIconKind {
  if (entryPoint === "chat" && isGenericChatThreadTitle(title)) {
    return "none";
  }
  return entryPoint === "terminal" ? "terminal" : "provider";
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadId,
  activeThreadTitle,
  activeThreadEntryPoint,
  activeProvider,
  activeProjectName,
  threadBreadcrumbs,
  className,
  hideSidebarControls = false,
  hideHandoffControls = false,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  diffToggleShortcutLabel,
  handoffBadgeLabel,
  handoffActionLabel,
  handoffDisabled,
  handoffActionTargetProviders,
  handoffBadgeSourceProvider,
  handoffBadgeTargetProvider,
  gitCwd,
  diffTotals,
  showGitActions = true,
  showDiffToggle = true,
  diffOpen,
  diffDisabledReason = null,
  surfaceMode = "single",
  isSidechat = false,
  environment = null,
  chatLayoutAction = null,
  changeThreadAction = null,
  editorChatControls = null,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleDiff,
  onCreateHandoff,
  onNavigateToThread,
  onRenameThread,
  onCloseThreadPane,
}: ChatHeaderProps) {
  const { isMobile, state } = useSidebar();
  const headerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [openAddActionNonce, setOpenAddActionNonce] = useState(0);
  const {
    additions: diffAdditions,
    deletions: diffDeletions,
    hasChanges: showDiffTotals,
  } = diffTotals;
  const isDisposableThread = useIsDisposableThread(activeThreadId);

  // Own the open-favorite editor shortcut here so it survives regardless of which editor UI
  // is mounted (the legacy Open-in button, the Environment panel's Editor section, or
  // neither while the panel is closed). The header is always present for a project thread.
  useOpenFavoriteEditorShortcut({
    keybindings,
    availableEditors,
    openInCwd,
    enabled: !isDisposableThread && Boolean(activeProjectName),
  });

  const isSplitPane = surfaceMode === "split";
  // Split-chat creation moved to a shortcut only; the header keeps just the inline
  // "maximize" affordance for an already-split focused pane.
  const inlineChatLayoutAction = chatLayoutAction?.kind === "maximize" ? chatLayoutAction : null;
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
        fallback={<FiGitBranch className={className} />}
      />
    );
  };

  // The right-side diff toggle (the "open the diff on the right" affordance). It stays in
  // the header in both layouts — beside the Environment button when that is enabled, and
  // inside the legacy cluster otherwise — so the familiar right-sidebar control is always a
  // single click away. Declared once here to avoid duplicating the markup across branches.
  const diffToggleControl = showDiffToggle ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className={cn(
              CHAT_HEADER_TOGGLE_CLASS_NAME,
              showDiffTotals ? null : "!size-7 [&_svg,&_[data-slot=central-icon]]:mx-0",
            )}
            pressed={diffOpen}
            onPressedChange={onToggleDiff}
            aria-label="Toggle diff panel"
            variant="default"
            size="xs"
            disabled={!isGitRepo || (diffDisabledReason !== null && !diffOpen)}
          >
            {showDiffTotals ? (
              <span className="inline-flex items-center gap-1">
                <span className="font-system-ui text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-xs,10px)] font-normal tracking-normal tabular-nums text-success">
                  +{diffAdditions}
                </span>
                <span className="font-system-ui text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-xs,10px)] font-normal tracking-normal tabular-nums text-destructive">
                  -{diffDeletions}
                </span>
              </span>
            ) : null}
            <SurfaceChipIcon icon={PanelRightCloseIcon} className="size-4" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {!isGitRepo
          ? "Diff panel is unavailable because this project is not a git repository."
          : diffDisabledReason && !diffOpen
            ? diffDisabledReason
            : diffToggleShortcutLabel
              ? `Toggle diff panel (${diffToggleShortcutLabel})`
              : "Toggle diff panel"}
      </TooltipPopup>
    </Tooltip>
  ) : null;

  return (
    <div ref={headerRef} className={cn("flex min-w-0 flex-1 items-center gap-2", className)}>
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center",
          editorChatControls ? "h-full overflow-visible" : "overflow-hidden",
          !isMobile && state === "collapsed" ? "gap-4" : "gap-2 sm:gap-3",
        )}
      >
        {hideSidebarControls ? null : <SidebarHeaderNavigationControls />}
        <div
          className={cn("flex min-w-0 flex-1 items-center gap-2", editorChatControls && "h-full")}
        >
          <div
            className={cn(
              "flex min-w-0 flex-1 flex-col",
              editorChatControls && "h-full justify-center",
            )}
          >
            {threadBreadcrumbs.length > 0 ? (
              <div className="flex min-w-0 items-center gap-1 overflow-hidden text-[11px] text-muted-foreground/55">
                {threadBreadcrumbs.map((breadcrumb, index) => (
                  <React.Fragment key={breadcrumb.threadId}>
                    {index > 0 ? (
                      <span className="shrink-0 text-muted-foreground/35">/</span>
                    ) : null}
                    <button
                      type="button"
                      className="min-w-0 truncate transition-colors hover:text-foreground/80"
                      title={breadcrumb.title}
                      onClick={() => onNavigateToThread(breadcrumb.threadId)}
                    >
                      {breadcrumb.title}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            ) : null}
            <div className={cn("flex min-w-0 items-center gap-2", editorChatControls && "h-full")}>
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
                  className="max-w-[clamp(12rem,42vw,36rem)] truncate text-sm font-medium text-foreground"
                  title={activeThreadTitle}
                  onDoubleClick={() => onRenameThread()}
                >
                  {activeThreadTitle}
                </h2>
                {showSidechatTitleChip && onCloseThreadPane ? (
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
                  activeThreadTitle={activeThreadTitle}
                  activeProvider={activeProvider}
                  activeSurface={editorChatControls.activeSurface}
                  terminalAvailable={editorChatControls.terminalAvailable}
                  terminalHasRunningActivity={editorChatControls.terminalHasRunningActivity}
                  onNewChat={editorChatControls.onNewChat}
                  onNewTerminal={editorChatControls.onNewTerminal}
                  onOpenChat={editorChatControls.onOpenChat}
                  onOpenTerminal={editorChatControls.onOpenTerminal}
                  onCloseTerminal={editorChatControls.onCloseTerminal}
                  onNavigateToThread={onNavigateToThread}
                />
              ) : null}
              {!hideHandoffControls && handoffBadgeLabel ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Badge
                        variant="outline"
                        className="hidden !h-6 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-[10px] sm:inline-flex"
                      >
                        <span className="inline-flex size-4 shrink-0 items-center justify-center">
                          {renderProviderIcon(handoffBadgeSourceProvider, "size-3")}
                        </span>
                        <ArrowRightIcon className="size-2.5 shrink-0 opacity-45" />
                        <span className="inline-flex size-4 shrink-0 items-center justify-center">
                          {renderProviderIcon(handoffBadgeTargetProvider, "size-3")}
                        </span>
                      </Badge>
                    }
                  />
                  <TooltipPopup side="bottom">{handoffBadgeLabel}</TooltipPopup>
                </Tooltip>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
        {!isDisposableThread && !hideHandoffControls && !environment ? (
          <ProviderUsageMenuControl provider={activeProvider} />
        ) : null}
        {!isDisposableThread && !hideHandoffControls ? (
          <Menu modal={false}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <ChatHeaderButton
                        type="button"
                        tone="outline"
                        className={compact ? "gap-1" : "gap-1.5"}
                        aria-label={handoffActionLabel}
                        disabled={handoffDisabled || handoffActionTargetProviders.length === 0}
                      />
                    }
                  >
                    <HandoffIcon className="size-[1em] shrink-0 opacity-80" />
                    {!compact ? <span className="truncate font-normal">Hand off</span> : null}
                  </MenuTrigger>
                }
              />
              <TooltipPopup side="bottom">{handoffActionLabel}</TooltipPopup>
            </Tooltip>
            <ComposerPickerMenuPopup align="end" side="bottom" className="w-48 min-w-48">
              {handoffActionTargetProviders.map((provider) => (
                <MenuItem key={provider} onClick={() => onCreateHandoff(provider)}>
                  {renderProviderIcon(provider, "size-3.5 shrink-0")}
                  <span>Handoff to {PROVIDER_DISPLAY_NAMES[provider]}</span>
                </MenuItem>
              ))}
            </ComposerPickerMenuPopup>
          </Menu>
        ) : null}
        {/* Keep one shared project-actions controller mounted so both inline and
            compact header menus open the same dialog/state machine. */}
        {!isDisposableThread && activeProjectScripts ? (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            showInlineControls={!compact}
            openAddActionNonce={openAddActionNonce}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        ) : null}

        {!isDisposableThread && inlineChatLayoutAction ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <ChatHeaderIconButton
                  type="button"
                  label={inlineChatLayoutAction.label}
                  onClick={inlineChatLayoutAction.onClick}
                >
                  <HiMiniArrowsPointingOut className="size-3.5" />
                </ChatHeaderIconButton>
              }
            />
            <TooltipPopup side="bottom">{inlineChatLayoutAction.label}</TooltipPopup>
          </Tooltip>
        ) : null}

        {/* Change thread stays as a standalone control (split/sidechat only). */}
        {!isDisposableThread && changeThreadAction ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <ChatHeaderIconButton
                  type="button"
                  label={changeThreadAction.label}
                  onClick={changeThreadAction.onClick}
                >
                  <TbExchange className="size-3.5" />
                </ChatHeaderIconButton>
              }
            />
            <TooltipPopup side="bottom">{changeThreadAction.label}</TooltipPopup>
          </Tooltip>
        ) : null}

        {/* Environment: one button consolidating Open-in-editor and git actions into the
            Environment panel. The right-side diff toggle stays beside it so the familiar
            "open the diff on the right" control is preserved. Falls back to the legacy split
            controls for disposable threads (which never surface the panel). */}
        {environment && !isDisposableThread ? (
          <>
            <EnvironmentToggle environment={environment} />
            {diffToggleControl}
          </>
        ) : (
          <>
            {/* Open in editor: dedicated split-button with an editor switcher; the project
                "Add action" entry lives at the bottom of that same menu. */}
            {!isDisposableThread && activeProjectName ? (
              <OpenInPicker
                keybindings={keybindings}
                availableEditors={availableEditors}
                openInCwd={openInCwd}
                {...(activeProjectScripts
                  ? { onAddAction: () => setOpenAddActionNonce((current) => current + 1) }
                  : {})}
              />
            ) : null}

            {!isDisposableThread && activeProjectName && showGitActions ? (
              <GitActionsControl
                gitCwd={gitCwd}
                activeThreadId={activeThreadId}
                hideQuickActionLabel={compact}
              />
            ) : null}
            {diffToggleControl}
          </>
        )}
      </div>
    </div>
  );
});
