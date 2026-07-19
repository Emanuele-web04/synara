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
  type WorktreeWorkspaceId,
} from "@synara/contracts";
import { isGenericChatThreadTitle } from "@synara/shared/chatThreads";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FiGitBranch } from "react-icons/fi";
import { HiMiniArrowsPointingOut } from "react-icons/hi2";
import { TbExchange } from "react-icons/tb";
import type { ThreadPrimarySurface } from "../../types";
import GitActionsControl from "../GitActionsControl";
import {
  ArrowRightIcon,
  CheckIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  HandoffIcon,
  HistoryIcon,
  MessageCircleIcon,
  PanelRightCloseIcon,
  PlusIcon,
  TerminalIcon,
  WorktreeIcon,
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
import {
  resolveThreadStatusPill,
  sortThreadsForConversationTabs,
  sortThreadsForSidebar,
  type ThreadStatusPill,
} from "../Sidebar.logic";
import {
  pushEditorRailClosedChatTab,
  readEditorRailClosedChatTabs,
  storeEditorRailActiveChat,
  readEditorRailChatTabs,
  storeEditorRailClosedChatTabs,
  storeEditorRailChatTabs,
  type EditorRailChatTabSnapshot,
} from "../../editorViewState";
import { resolveShortcutCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { cn } from "~/lib/utils";
import { useOpenFavoriteEditorShortcut } from "~/hooks/useOpenFavoriteEditorShortcut";
import type { RepoDiffTotals } from "~/hooks/useRepoDiffTotals";
import { ProviderIcon } from "../ProviderIcon";
import { ProviderUsageMenuControl } from "../ProviderUsageMenuControl";
import { EnvironmentToggle, type EnvironmentToggleState } from "./environment/EnvironmentToggle";
import { readNativeApi } from "../../nativeApi";
import { ThreadRunningSpinner } from "../ThreadRunningSpinner";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";

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
  openInTarget: string | null;
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
  // When provided, the header collapses the
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
    workspaceId: WorktreeWorkspaceId | null;
    activeSurface: "chat" | "terminal";
    terminalAvailable: boolean;
    terminalHasRunningActivity: boolean;
    menuActionsEnabled: boolean;
    onNewChat: () => void;
    onNewTerminal: () => void;
    onOpenChat: (threadId: ThreadId) => void;
    onOpenTerminal: () => void;
    onCloseTerminal: () => void;
    onRenameChat: (threadId: ThreadId, title: string) => void;
    onCloseChat: (threadId: ThreadId, nextThreadId: ThreadId | null) => Promise<boolean>;
    onReopenChat: (threadId: ThreadId) => Promise<boolean>;
  } | null;
  workspaceHeader?: {
    title: string;
    targetRef: string;
    targetBranchOptions: readonly string[];
    targetBranchesLoading: boolean;
    targetRefUpdating: boolean;
    onTargetRefChange: (targetRef: string) => void;
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

function ConversationTabStatus({ status }: { status: ThreadStatusPill }) {
  if (status.label === "Completed") {
    return <CheckCircle2Icon aria-hidden="true" className={cn("size-3", status.colorClass)} />;
  }
  if (status.pulse) {
    return <ThreadRunningSpinner className={cn("size-2.5", status.colorClass)} />;
  }
  return <span aria-hidden="true" className={cn("size-1.5 rounded-full", status.dotClass)} />;
}

export function resolveVisibleConversationTabs(input: {
  workspaceScoped: boolean;
  availableTabs: ReadonlyArray<EditorRailChatTab>;
  openTabs: ReadonlyArray<EditorRailChatTab>;
  activeTab: EditorRailChatTab;
  activeSurface: "chat" | "terminal";
}): ReadonlyArray<EditorRailChatTab> {
  const availableTabById = new Map(input.availableTabs.map((tab) => [tab.id, tab] as const));
  const activeTabIsAvailable = availableTabById.has(input.activeTab.id);

  if (input.workspaceScoped) {
    if (input.activeSurface !== "chat" || activeTabIsAvailable) {
      return input.availableTabs;
    }
    return [...input.availableTabs, input.activeTab];
  }

  const activeTabIsOpen = input.openTabs.some((tab) => tab.id === input.activeTab.id);
  const orderedOpenTabs =
    input.activeSurface === "chat" && !activeTabIsOpen
      ? [...input.openTabs, input.activeTab]
      : input.openTabs;
  return orderedOpenTabs.map((tab) => availableTabById.get(tab.id) ?? tab);
}

export function resolveTabStripScrollLeft(input: {
  scrollLeft: number;
  viewportStart: number;
  viewportEnd: number;
  tabStart: number;
  tabEnd: number;
  inset?: number;
}): number | null {
  const inset = input.inset ?? 4;
  const visibleStart = input.viewportStart + inset;
  const visibleEnd = input.viewportEnd - inset;
  if (input.tabStart < visibleStart) {
    return Math.max(0, input.scrollLeft - (visibleStart - input.tabStart));
  }
  if (input.tabEnd > visibleEnd) {
    return Math.max(0, input.scrollLeft + (input.tabEnd - visibleEnd));
  }
  return null;
}

// Compact recent-chats picker for the editor rail; selecting a thread keeps the
// editor view because the caller's navigation preserves the `view` search param.
function EditorChatHistoryMenu(props: {
  projectId: ProjectId;
  workspaceId: WorktreeWorkspaceId | null;
  activeThreadId: ThreadId;
  onNavigateToThread: (threadId: ThreadId) => void;
}) {
  const { settings } = useAppSettings();
  const selectDisplayThreads = createSidebarDisplayThreadsSelector();
  const displayThreads = useStore(selectDisplayThreads);
  const historyThreads = sortThreadsForSidebar(
    displayThreads.filter((thread) =>
      props.workspaceId
        ? thread.workspaceId === props.workspaceId
        : thread.projectId === props.projectId,
    ),
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
          <MenuItem disabled>
            {props.workspaceId
              ? "No conversations in this workspace yet"
              : "No chats in this project yet"}
          </MenuItem>
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
  workspaceId: WorktreeWorkspaceId | null;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeProvider: ProviderKind;
  activeSurface: "chat" | "terminal";
  terminalAvailable: boolean;
  terminalHasRunningActivity: boolean;
  menuActionsEnabled: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onNewChat: () => void;
  onNewTerminal: () => void;
  onOpenChat: (threadId: ThreadId) => void;
  onOpenTerminal: () => void;
  onCloseTerminal: () => void;
  onRenameChat: (threadId: ThreadId, title: string) => void;
  onCloseChat: (threadId: ThreadId, nextThreadId: ThreadId | null) => Promise<boolean>;
  onReopenChat: (threadId: ThreadId) => Promise<boolean>;
  onNavigateToThread: (threadId: ThreadId) => void;
}) {
  const tabScopeKey = props.workspaceId
    ? `workspace:${props.workspaceId}`
    : `project:${props.projectId}`;
  const [openChatTabs, setOpenChatTabs] = useState<ReadonlyArray<EditorRailChatTab>>(() => {
    const storedTabs = readEditorRailChatTabs(tabScopeKey);
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
  const tabStripRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  const previousActiveTabKeyRef = useRef<string | null>(null);
  const selectDisplayThreads = useMemo(() => createSidebarDisplayThreadsSelector(), []);
  const displayThreads = useStore(selectDisplayThreads);
  const conversationStatusByThreadId = useMemo(
    () =>
      new Map(
        displayThreads.map(
          (thread) =>
            [
              thread.id,
              resolveThreadStatusPill({
                thread,
                hasPendingApprovals: thread.hasPendingApprovals,
                hasPendingUserInput: thread.hasPendingUserInput,
              }),
            ] as const,
        ),
      ),
    [displayThreads],
  );
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
        storeEditorRailChatTabs(tabScopeKey, next);
        return next;
      });
    },
    [tabScopeKey],
  );
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const storedTabs = readEditorRailChatTabs(tabScopeKey);
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
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [props.activeProvider, props.activeThreadId, props.activeThreadTitle, tabScopeKey]);
  useEffect(() => {
    if (!props.terminalAvailable) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setTerminalTabOpen(true);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [props.terminalAvailable]);
  useEffect(() => {
    if (props.activeSurface !== "chat") {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      storeEditorRailActiveChat(tabScopeKey, props.activeThreadId);
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
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [
    currentChatTab,
    props.activeSurface,
    props.activeThreadId,
    setAndStoreOpenChatTabs,
    tabScopeKey,
  ]);
  const chatTabs = useMemo(() => {
    const sortedProjectThreads = sortThreadsForConversationTabs(
      displayThreads.filter((thread) =>
        props.workspaceId
          ? thread.workspaceId === props.workspaceId
          : thread.projectId === props.projectId,
      ),
    );
    const availableTabs = sortedProjectThreads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      provider: thread.session?.provider ?? thread.modelSelection.provider,
    }));
    return resolveVisibleConversationTabs({
      workspaceScoped: props.workspaceId !== null,
      availableTabs,
      openTabs: openChatTabs,
      activeTab: currentChatTab,
      activeSurface: props.activeSurface,
    });
  }, [
    currentChatTab,
    displayThreads,
    props.activeSurface,
    openChatTabs,
    props.projectId,
    props.workspaceId,
  ]);
  const terminalTabVisible = terminalTabOpen || props.terminalAvailable;
  const tabCount = chatTabs.length + (terminalTabVisible ? 1 : 0);
  const shouldShowTabs = props.workspaceId !== null || tabCount > 1;
  const activeTabKey =
    props.activeSurface === "terminal" ? "terminal" : `chat:${props.activeThreadId}`;
  const keepActiveTabVisible = useCallback((behavior: ScrollBehavior) => {
    const tabStrip = tabStripRef.current;
    const activeTab = activeTabRef.current;
    if (!tabStrip || !activeTab) {
      return;
    }
    const stripRect = tabStrip.getBoundingClientRect();
    const tabRect = activeTab.getBoundingClientRect();
    const nextScrollLeft = resolveTabStripScrollLeft({
      scrollLeft: tabStrip.scrollLeft,
      viewportStart: stripRect.left,
      viewportEnd: stripRect.right,
      tabStart: tabRect.left,
      tabEnd: tabRect.right,
    });
    if (nextScrollLeft === null || Math.abs(nextScrollLeft - tabStrip.scrollLeft) < 1) {
      return;
    }
    tabStrip.scrollTo({ left: nextScrollLeft, behavior });
  }, []);
  useLayoutEffect(() => {
    const switchedTabs =
      previousActiveTabKeyRef.current !== null && previousActiveTabKeyRef.current !== activeTabKey;
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    keepActiveTabVisible(switchedTabs && !prefersReducedMotion ? "smooth" : "auto");
    previousActiveTabKeyRef.current = activeTabKey;
  }, [activeTabKey, chatTabs, keepActiveTabVisible, terminalTabVisible]);
  useEffect(() => {
    const tabStrip = tabStripRef.current;
    if (!tabStrip || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => keepActiveTabVisible("auto"));
    observer.observe(tabStrip);
    return () => observer.disconnect();
  }, [keepActiveTabVisible]);
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
    storeEditorRailActiveChat(tabScopeKey, threadId);
    props.onOpenChat(threadId);
  };
  const closeChatTab = useCallback(
    async (threadId: ThreadId) => {
      const closingTab = chatTabs.find((thread) => thread.id === threadId);
      if (!closingTab) return;
      const closingActiveChat = props.activeSurface === "chat" && threadId === props.activeThreadId;
      const nextChatTab = chatTabs.find((thread) => thread.id !== threadId);
      if (props.workspaceId !== null) {
        const closed = await props.onCloseChat(
          threadId,
          closingActiveChat ? (nextChatTab?.id ?? null) : null,
        );
        if (closed) pushEditorRailClosedChatTab(tabScopeKey, closingTab);
        return;
      }
      pushEditorRailClosedChatTab(tabScopeKey, closingTab);
      setAndStoreOpenChatTabs((current) => current.filter((thread) => thread.id !== threadId));
      if (!closingActiveChat) return;
      if (nextChatTab) {
        props.onOpenChat(nextChatTab.id);
        return;
      }
      if (terminalTabVisible) openTerminalTab();
    },
    [chatTabs, props, setAndStoreOpenChatTabs, tabScopeKey, terminalTabVisible],
  );
  const reopenClosedChatTab = useCallback(async () => {
    const closedTabs = readEditorRailClosedChatTabs(tabScopeKey);
    const closedTab = closedTabs.at(-1);
    if (!closedTab) return;
    if (props.workspaceId !== null && !(await props.onReopenChat(closedTab.id))) return;

    storeEditorRailClosedChatTabs(tabScopeKey, closedTabs.slice(0, -1));
    if (props.workspaceId === null) {
      setAndStoreOpenChatTabs((current) =>
        current.some((tab) => tab.id === closedTab.id) ? current : [...current, closedTab],
      );
      storeEditorRailActiveChat(tabScopeKey, closedTab.id);
      props.onOpenChat(closedTab.id);
    }
  }, [props, setAndStoreOpenChatTabs, tabScopeKey]);
  useEffect(() => {
    if (!props.menuActionsEnabled) return;
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") return;
    return onMenuAction((action) => {
      if (action === "close-active-tab") {
        if (props.activeSurface === "terminal") {
          closeTerminalTab();
        } else {
          void closeChatTab(props.activeThreadId);
        }
      } else if (action === "reopen-closed-tab") {
        void reopenClosedChatTab();
      }
    });
  }, [closeChatTab, props, reopenClosedChatTab]);
  useEffect(() => {
    if (!props.menuActionsEnabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, props.keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: props.terminalAvailable,
          terminalWorkspaceOpen: props.workspaceId !== null && props.terminalAvailable,
          terminalWorkspaceChatTabActive: props.activeSurface === "chat",
          terminalWorkspaceTerminalTabActive: props.activeSurface === "terminal",
        },
      });
      if (command !== "chat.closeActiveTab" && command !== "chat.reopenClosedTab") return;
      event.preventDefault();
      event.stopPropagation();
      if (command === "chat.closeActiveTab") {
        void closeChatTab(props.activeThreadId);
      } else {
        void reopenClosedChatTab();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeChatTab, props, reopenClosedChatTab]);
  const openChatTabContextMenu = (
    event: React.MouseEvent<HTMLDivElement>,
    thread: EditorRailChatTab,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const api = readNativeApi();
    if (!api) return;

    void (async () => {
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename chat" },
          { id: "close", label: "Close chat", separatorBefore: true },
        ],
        { x: event.clientX, y: event.clientY },
      );
      if (clicked === "rename") {
        props.onRenameChat(thread.id, thread.title);
      } else if (clicked === "close") {
        void closeChatTab(thread.id);
      }
    })();
  };
  const newItemMenu = (
    <Menu modal={false}>
      <MenuTrigger
        render={
          <IconButton
            variant="ghost"
            size="icon-xs"
            label={props.workspaceId ? "New workspace item" : "New editor rail item"}
            title="New"
            className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <PlusIcon className="size-3.5" />
          </IconButton>
        }
      />
      <ComposerPickerMenuPopup align="start" side="bottom" sideOffset={6} className="w-44 min-w-44">
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
  );

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 [-webkit-app-region:no-drag]">
      {props.workspaceId === null ? (
        <div className="flex shrink-0 items-center gap-0.5">
          {newItemMenu}
          <EditorChatHistoryMenu
            projectId={props.projectId}
            workspaceId={props.workspaceId}
            activeThreadId={props.activeThreadId}
            onNavigateToThread={openChatTab}
          />
        </div>
      ) : null}
      {shouldShowTabs ? (
        // Same chip tabs as the right dock's pane strip so every tab row in the
        // app reads identically. Workspace tabs start at the worktree-title edge;
        // editor-rail tabs keep their legacy right alignment.
        <div
          className={cn(
            "relative min-w-0 flex-1 [container-type:inline-size]",
            props.workspaceId === null && "ml-auto",
          )}
        >
          <div
            ref={tabStripRef}
            className="overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            aria-label="Open workspace tabs"
          >
            <div
              className={cn(
                "flex w-max min-w-full items-center gap-1",
                props.workspaceId === null ? "justify-end" : "justify-start",
              )}
            >
              {chatTabs.map((thread) => {
                const active = props.activeSurface === "chat" && thread.id === props.activeThreadId;
                const threadStatus = conversationStatusByThreadId.get(thread.id) ?? null;
                return (
                  <SurfaceTabChip
                    key={thread.id}
                    ref={active ? activeTabRef : undefined}
                    active={active}
                    title={thread.title}
                    label={thread.title}
                    labelClassName="max-w-[clamp(3.75rem,18cqi,8.5rem)]"
                    icon={
                      <ProviderIcon
                        provider={thread.provider}
                        tone="header"
                        className="size-3 shrink-0"
                      />
                    }
                    trailing={
                      threadStatus ? (
                        <span
                          aria-label={threadStatus.label}
                          title={threadStatus.label}
                          className="flex size-3 shrink-0 items-center justify-center"
                        >
                          <ConversationTabStatus status={threadStatus} />
                        </span>
                      ) : null
                    }
                    closeLabel={`Close ${thread.title}`}
                    closePlacement="trailing"
                    renameLabel={`Rename ${thread.title}`}
                    onSelect={() => openChatTab(thread.id)}
                    onClose={() => void closeChatTab(thread.id)}
                    onRename={() => props.onRenameChat(thread.id, thread.title)}
                    onContextMenu={(event) => openChatTabContextMenu(event, thread)}
                  />
                );
              })}
              {terminalTabVisible ? (
                <SurfaceTabChip
                  ref={props.activeSurface === "terminal" ? activeTabRef : undefined}
                  active={props.activeSurface === "terminal"}
                  title="Terminal"
                  label="Terminal"
                  labelClassName="max-w-[clamp(3.75rem,18cqi,8.5rem)]"
                  icon={
                    <TerminalIcon className="size-3 shrink-0 text-[var(--color-text-accent)]" />
                  }
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
              {props.workspaceId !== null ? newItemMenu : null}
            </div>
          </div>
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

function WorkspaceTargetBranchControl(props: NonNullable<ChatHeaderProps["workspaceHeader"]>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = useMemo(
    () =>
      normalizedQuery.length === 0
        ? props.targetBranchOptions
        : props.targetBranchOptions.filter((branch) =>
            branch.toLowerCase().includes(normalizedQuery),
          ),
    [normalizedQuery, props.targetBranchOptions],
  );

  return (
    <Combobox
      items={props.targetBranchOptions}
      filteredItems={filteredOptions}
      open={open}
      value={props.targetRef}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <ComboboxTrigger
        aria-label={`Change target branch. Current target: ${props.targetRef}`}
        className="flex h-7 min-w-0 max-w-[min(16rem,30vw)] shrink items-center gap-1 rounded-lg px-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground outline-none transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [-webkit-app-region:no-drag]"
        disabled={
          props.targetRefUpdating ||
          (props.targetBranchesLoading && props.targetBranchOptions.length === 0)
        }
      >
        <span className="shrink-0">Target:</span>
        <span className="min-w-0 truncate font-medium text-foreground">{props.targetRef}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-55" aria-hidden />
      </ComboboxTrigger>
      <ComboboxPopup align="start" side="bottom" sideOffset={5} className="w-72">
        <div className="border-b p-1">
          <ComboboxInput
            autoFocus
            className="rounded-lg border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] shadow-none before:hidden has-focus-visible:border-[color:var(--color-border-focus)] has-focus-visible:ring-0"
            inputClassName="ring-0"
            placeholder="Search target branches…"
            showTrigger={false}
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>No target branches found.</ComboboxEmpty>
        <ComboboxList className="max-h-64">
          {filteredOptions.map((branch) => (
            <ComboboxItem
              key={branch}
              value={branch}
              onClick={() => {
                setOpen(false);
                setQuery("");
                if (branch !== props.targetRef) props.onTargetRefChange(branch);
              }}
            >
              <span className="block min-w-0 truncate">{branch}</span>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

export function ChatHeader({
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
  openInTarget,
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
  workspaceHeader = null,
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
  const {
    additions: diffAdditions,
    deletions: diffDeletions,
    hasChanges: showDiffTotals,
  } = diffTotals;

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

  const editorTabs = editorChatControls ? (
    <EditorRailTabs
      key={editorChatControls.workspaceId ?? editorChatControls.projectId}
      projectId={editorChatControls.projectId}
      workspaceId={editorChatControls.workspaceId}
      activeThreadId={activeThreadId}
      activeThreadTitle={activeThreadTitle}
      activeProvider={activeProvider}
      activeSurface={editorChatControls.activeSurface}
      terminalAvailable={editorChatControls.terminalAvailable}
      terminalHasRunningActivity={editorChatControls.terminalHasRunningActivity}
      menuActionsEnabled={editorChatControls.menuActionsEnabled}
      keybindings={keybindings}
      onNewChat={editorChatControls.onNewChat}
      onNewTerminal={editorChatControls.onNewTerminal}
      onOpenChat={editorChatControls.onOpenChat}
      onOpenTerminal={editorChatControls.onOpenTerminal}
      onCloseTerminal={editorChatControls.onCloseTerminal}
      onRenameChat={editorChatControls.onRenameChat}
      onCloseChat={editorChatControls.onCloseChat}
      onReopenChat={editorChatControls.onReopenChat}
      onNavigateToThread={onNavigateToThread}
    />
  ) : null;

  return (
    <div
      ref={headerRef}
      className={cn(
        "flex min-w-0 flex-1 gap-2",
        workspaceHeader ? "flex-col" : "items-center",
        className,
      )}
    >
      <div
        className={cn(
          "flex min-w-0 w-full items-center gap-2",
          workspaceHeader ? "h-10" : "h-full",
        )}
      >
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center",
            editorChatControls ? "h-full overflow-visible" : "overflow-hidden",
            !isMobile && state === "collapsed" ? "gap-4" : "gap-2 sm:gap-3",
          )}
        >
          {hideSidebarControls ? null : <SidebarHeaderNavigationControls />}
          {workspaceHeader ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <WorktreeIcon className="size-3.5 shrink-0 text-muted-foreground/80" aria-hidden />
              <h2
                className="min-w-0 max-w-[clamp(8rem,30vw,28rem)] truncate font-system-ui text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground"
                title={workspaceHeader.title}
              >
                {workspaceHeader.title}
              </h2>
              <WorkspaceTargetBranchControl {...workspaceHeader} />
            </div>
          ) : (
            <div
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2",
                editorChatControls && "h-full",
              )}
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
                      className="max-w-[clamp(12rem,42vw,36rem)] truncate font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-foreground"
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
                  {editorTabs}
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
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
          {!hideHandoffControls && !environment ? (
            <ProviderUsageMenuControl provider={activeProvider} />
          ) : null}
          {!hideHandoffControls ? (
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
          {activeProjectScripts ? (
            <ProjectScriptsControl
              scripts={activeProjectScripts}
              keybindings={keybindings}
              preferredScriptId={preferredScriptId}
              hideInlineLabel={compact}
              onRunScript={onRunProjectScript}
              onAddScript={onAddProjectScript}
              onUpdateScript={onUpdateProjectScript}
              onDeleteScript={onDeleteProjectScript}
            />
          ) : null}

          {inlineChatLayoutAction ? (
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
          {changeThreadAction ? (
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
            controls when no environment is resolved. */}
          {environment ? (
            <>
              <EnvironmentToggle environment={environment} />
              {diffToggleControl}
            </>
          ) : (
            <>
              {/* Open in editor: dedicated split-button with an editor switcher; the project
                action control now lives beside Hand off as its own project command surface. */}
              {activeProjectName ? (
                <OpenInPicker
                  keybindings={keybindings}
                  availableEditors={availableEditors}
                  openInTarget={openInTarget}
                />
              ) : null}

              {activeProjectName && showGitActions ? (
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
      {workspaceHeader && editorTabs ? (
        <div className="flex min-h-0 min-w-0 flex-1 items-center">{editorTabs}</div>
      ) : null}
    </div>
  );
}
