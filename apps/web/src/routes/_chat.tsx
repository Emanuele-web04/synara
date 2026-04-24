import { type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  goBackInAppHistory,
  goForwardInAppHistory,
  resolveAppNavigationState,
} from "../appNavigation";
import ShortcutsDialog from "../components/ShortcutsDialog";
import { shouldRenderTerminalWorkspace } from "../components/ChatView.logic";
import ThreadSidebar from "../components/Sidebar";
import { isElectron } from "../env";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { useDisposableThreadLifecycle } from "../hooks/useDisposableThreadLifecycle";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useLatestProjectStore } from "../latestProjectStore";
import {
  resolveCurrentProjectTargetId,
  resolveLatestProjectTargetId,
} from "../lib/projectShortcutTargets";
import { resolveThreadEnvironmentMode } from "../lib/threadEnvironment";
import { isTerminalFocused } from "../lib/terminalFocus";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { resolveShortcutCommand } from "../keybindings";
import { useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useAppSettings } from "~/appSettings";
import {
  isProviderUsable,
  normalizeProviderStatusForLocalConfig,
  providerUnavailableReason,
} from "~/lib/providerAvailability";
import { toastManager } from "~/components/ui/toast";
import { Sidebar, SidebarProvider, SidebarRail, useSidebar } from "~/components/ui/sidebar";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

function resolveBrowserNavigationShortcut(
  event: KeyboardEvent,
  platform: string,
): "back" | "forward" | null {
  const isMac = /Mac|iPhone|iPad|iPod/i.test(platform);
  const key = event.key.toLowerCase();

  if (
    isMac &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    (key === "[" || key === "]")
  ) {
    return key === "[" ? "back" : "forward";
  }

  if (
    !isMac &&
    event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    (event.key === "ArrowLeft" || event.key === "ArrowRight")
  ) {
    return event.key === "ArrowLeft" ? "back" : "forward";
  }

  return null;
}

function ChatRouteGlobalShortcuts() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { settings: appSettings } = useAppSettings();
  const { toggleSidebar } = useSidebar();
  const [shortcutsDialogOpen, setShortcutsDialogOpen] = useState(false);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadIdsSize = useThreadSelectionStore((state) => state.selectedThreadIds.size);
  const {
    activeContextThreadId,
    activeDraftThread,
    activeProjectId,
    activeThread,
    handleNewThread,
    projects,
  } = useHandleNewThread();
  const { handleNewChat } = useHandleNewChat();
  const latestProjectId = useLatestProjectStore((state) => state.latestProjectId);
  const setLatestProjectId = useLatestProjectStore((state) => state.setLatestProjectId);
  const clearLatestProjectId = useLatestProjectStore((state) => state.clearLatestProjectId);
  const threadsHydrated = useStore((state) => state.threadsHydrated);
  useDisposableThreadLifecycle(activeContextThreadId);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const providerStatuses = serverConfigQuery.data?.providers ?? [];
  const activeThreadTerminalState = useTerminalStateStore((state) =>
    activeContextThreadId
      ? selectThreadTerminalState(state.terminalStateByThreadId, activeContextThreadId)
      : null,
  );
  const terminalOpen = activeThreadTerminalState?.terminalOpen ?? false;
  const allowProjectFallback = pathname !== "/";
  const activeProject =
    activeProjectId !== null
      ? (projects.find((project) => project.id === activeProjectId) ?? null)
      : null;
  const activeProjectScripts = activeProject?.kind === "project" ? activeProject.scripts : [];
  const terminalWorkspaceOpen = shouldRenderTerminalWorkspace({
    activeProjectExists: activeProject !== null,
    presentationMode: activeThreadTerminalState?.presentationMode ?? "drawer",
    terminalOpen,
  });
  const currentProjectId = resolveCurrentProjectTargetId(projects, activeProject?.id ?? null);
  const latestUsableProjectId = resolveLatestProjectTargetId(projects, latestProjectId);

  useEffect(() => {
    if (!currentProjectId) {
      return;
    }
    setLatestProjectId(currentProjectId);
  }, [currentProjectId, setLatestProjectId]);

  useEffect(() => {
    if (threadsHydrated && latestProjectId && latestUsableProjectId === null) {
      clearLatestProjectId(latestProjectId);
    }
  }, [clearLatestProjectId, latestProjectId, latestUsableProjectId, threadsHydrated]);

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen,
        terminalWorkspaceOpen,
      };

      const isShortcutsHelpShortcut =
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        !event.repeat &&
        (event.key === "/" || event.code === "Slash");
      if (isShortcutsHelpShortcut) {
        event.preventDefault();
        event.stopPropagation();
        setShortcutsDialogOpen(true);
        return;
      }

      const appNavigationShortcut = isElectron
        ? resolveBrowserNavigationShortcut(event, platform)
        : null;
      if (appNavigationShortcut) {
        event.preventDefault();
        event.stopPropagation();
        const navigationState = resolveAppNavigationState();
        if (appNavigationShortcut === "back" && navigationState.canGoBack) {
          goBackInAppHistory();
        }
        if (appNavigationShortcut === "forward" && navigationState.canGoForward) {
          goForwardInAppHistory();
        }
        return;
      }

      if (event.key === "Escape" && selectedThreadIdsSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, { context: shortcutContext });
      if (command === "sidebar.toggle") {
        if (!isElectron) return;
        event.preventDefault();
        event.stopPropagation();
        toggleSidebar();
        return;
      }

      if (!command) return;

      if (command === "chat.newChat" || command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void handleNewChat({ fresh: true });
        return;
      }

      if (command === "chat.newLatestProject") {
        if (!latestUsableProjectId) return;
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(latestUsableProjectId);
        return;
      }

      if (command === "chat.newTerminal") {
        const projectId = activeProjectId ?? (allowProjectFallback ? projects[0]?.id : null);
        if (!projectId) return;
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(projectId, {
          branch: activeThread?.branch ?? activeDraftThread?.branch ?? null,
          worktreePath: activeThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null,
          envMode:
            activeDraftThread?.envMode ??
            resolveThreadEnvironmentMode({
              envMode: activeThread?.envMode,
              worktreePath: activeThread?.worktreePath ?? null,
            }),
          entryPoint: "terminal",
        });
        return;
      }

      if (
        command === "chat.newClaude" ||
        command === "chat.newCodex" ||
        command === "chat.newGemini"
      ) {
        const provider =
          command === "chat.newClaude"
            ? "claudeAgent"
            : command === "chat.newCodex"
              ? "codex"
              : "gemini";
        const normalizedStatus = normalizeProviderStatusForLocalConfig({
          provider,
          status: providerStatuses.find((entry) => entry.provider === provider) ?? null,
          customBinaryPath:
            provider === "codex"
              ? appSettings.codexBinaryPath
              : provider === "claudeAgent"
                ? appSettings.claudeBinaryPath
                : appSettings.geminiBinaryPath,
        });
        if (!isProviderUsable(normalizedStatus)) {
          event.preventDefault();
          event.stopPropagation();
          toastManager.add({
            type: "error",
            title: providerUnavailableReason(normalizedStatus),
          });
          return;
        }
        const projectId = activeProjectId ?? (allowProjectFallback ? projects[0]?.id : null);
        if (!projectId) return;
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(projectId, {
          provider,
          branch: activeThread?.branch ?? activeDraftThread?.branch ?? null,
          worktreePath: activeThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null,
          envMode:
            activeDraftThread?.envMode ??
            resolveThreadEnvironmentMode({
              envMode: activeThread?.envMode,
              worktreePath: activeThread?.worktreePath ?? null,
            }),
        });
        return;
      }

      if (command !== "chat.new") return;
      if (!currentProjectId) return;
      event.preventDefault();
      event.stopPropagation();
      void handleNewThread(currentProjectId, {
        branch: activeThread?.branch ?? activeDraftThread?.branch ?? null,
        worktreePath: activeThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null,
        envMode:
          activeDraftThread?.envMode ??
          resolveThreadEnvironmentMode({
            envMode: activeThread?.envMode,
            worktreePath: activeThread?.worktreePath ?? null,
          }),
      });
    };

    window.addEventListener("keydown", onWindowKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, { capture: true });
    };
  }, [
    activeDraftThread,
    activeProjectId,
    activeThread,
    allowProjectFallback,
    clearSelection,
    currentProjectId,
    handleNewChat,
    handleNewThread,
    keybindings,
    latestUsableProjectId,
    appSettings.claudeBinaryPath,
    appSettings.codexBinaryPath,
    appSettings.geminiBinaryPath,
    providerStatuses,
    projects,
    selectedThreadIdsSize,
    terminalOpen,
    terminalWorkspaceOpen,
    toggleSidebar,
  ]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "toggle-sidebar") {
        toggleSidebar();
        return;
      }
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, toggleSidebar]);

  return (
    <ShortcutsDialog
      open={shortcutsDialogOpen}
      onOpenChange={setShortcutsDialogOpen}
      keybindings={keybindings}
      projectScripts={activeProjectScripts}
      platform={platform}
      context={{
        terminalFocus: isTerminalFocused(),
        terminalOpen,
        terminalWorkspaceOpen,
      }}
      isElectron={isElectron}
    />
  );
}

const SIDEBAR_GAP_CLASS = {
  left: "overflow-hidden after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-[color:var(--color-border-light)]",
  right:
    "overflow-hidden after:absolute after:inset-y-0 after:left-0 after:w-px after:bg-[color:var(--color-border-light)]",
} as const;

const SIDEBAR_INNER_CLASS = {
  left: "app-sidebar-surface border-r border-[color:var(--color-border-light)]",
  right: "app-sidebar-surface border-l border-[color:var(--color-border-light)]",
} as const;

function ChatRouteLayout() {
  const { settings } = useAppSettings();
  const side = settings.sidebarSide;

  const sidebarElement = (
    <Sidebar
      side={side}
      collapsible="offcanvas"
      className="text-foreground"
      gapClassName={SIDEBAR_GAP_CLASS[side]}
      innerClassName={SIDEBAR_INNER_CLASS[side]}
      transparentSurface
      resizable={{
        minWidth: THREAD_SIDEBAR_MIN_WIDTH,
        shouldAcceptWidth: ({ nextWidth, wrapper }) =>
          wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
        storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
      }}
    >
      <ThreadSidebar />
      <SidebarRail />
    </Sidebar>
  );

  return (
    <SidebarProvider defaultOpen>
      <ChatRouteGlobalShortcuts />
      {side === "left" ? sidebarElement : null}
      <Outlet />
      {side === "right" ? sidebarElement : null}
    </SidebarProvider>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
