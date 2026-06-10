// Purpose: Thread, multi-select, and project right-click context-menu handlers extracted from Sidebar.tsx.
// Layer: web hook (event handlers). Owns no state; consumes action callbacks + rename setters via deps.
// Exports: useSidebarContextMenus, SidebarContextMenusDeps, SidebarContextMenus.

import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HiOutlineArchiveBox, HiOutlineFolderOpen } from "react-icons/hi2";
import { Trash2 } from "~/lib/icons";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProjectId,
  type ProviderKind,
  type ThreadId,
} from "@t3tools/contracts";
import type { useNavigate } from "@tanstack/react-router";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import { newCommandId, randomUUID } from "../lib/utils";
import { quotePosixShellArgument } from "../lib/shellQuote";
import { resolveThreadWorkspaceCwd } from "@t3tools/shared/threadEnvironment";
import { canCreateThreadHandoff, resolveAvailableHandoffTargetProviders } from "../lib/threadHandoff";
import {
  selectThreadTerminalState,
  useTerminalStateStore,
} from "../terminalStateStore";
import { toastManager } from "./ui/toast";
import { showContextMenuFallback } from "../contextMenuFallback";
import { DEFAULT_THREAD_TERMINAL_ID } from "../types";
import type { Project, SidebarThreadSummary } from "../types";
import type { AppSettings } from "../appSettings";
import type { ThreadStatusPill } from "./Sidebar.logic";
import type { Thread } from "../types";

const PROJECT_CONTEXT_MENU_FOLDER_ICON = renderToStaticMarkup(<HiOutlineFolderOpen />);
const PROJECT_CONTEXT_MENU_EDIT_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const PROJECT_CONTEXT_MENU_REMOVE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const PROJECT_CONTEXT_MENU_COPY_PATH_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const PROJECT_CONTEXT_MENU_ARCHIVE_ICON = renderToStaticMarkup(<HiOutlineArchiveBox />);
const PROJECT_CONTEXT_MENU_DELETE_THREADS_ICON = renderToStaticMarkup(<Trash2 />);

export interface SidebarContextMenusDeps {
  appSettings: Pick<AppSettings, "confirmThreadArchive" | "confirmThreadDelete">;
  sidebarThreads: readonly SidebarThreadSummary[];
  sidebarThreadSummaryById: Readonly<Record<ThreadId, SidebarThreadSummary | undefined>>;
  projects: readonly Project[];
  pinnedThreadIdSet: ReadonlySet<ThreadId>;
  projectCwdById: ReadonlyMap<ProjectId, string>;
  selectedThreadIds: ReadonlySet<ThreadId>;
  navigate: ReturnType<typeof useNavigate>;
  resolveThreadStatusForSidebar: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
  markThreadUnread: (threadId: ThreadId) => void;
  clearDismissedThreadStatus: (threadId: ThreadId) => void;
  clearThreadNotification: (threadId: ThreadId) => void;
  toggleThreadPinned: (threadId: ThreadId) => void;
  clearSelection: () => void;
  removeFromSelection: (threadIds: readonly ThreadId[]) => void;
  clearProjectDraftThreads: (projectId: ProjectId) => void;
  handoffThread: (thread: Thread, targetProvider: ProviderKind) => Promise<void>;
  copyPathToClipboard: (text: string, context: { path: string }) => void;
  copyThreadIdToClipboard: (text: string, context: { threadId: ThreadId }) => void;
  confirmAndArchiveThread: (threadId: ThreadId) => Promise<void>;
  confirmAndDeleteThread: (threadId: ThreadId) => Promise<void>;
  archiveThread: (threadId: ThreadId) => Promise<void>;
  deleteThread: (
    threadId: ThreadId,
    opts?: { deletedThreadIds?: ReadonlySet<ThreadId>; worktreeCleanupMode?: "prompt" | "skip" },
  ) => Promise<void>;
  archiveAllThreadsInProject: (projectId: ProjectId) => Promise<void>;
  deleteAllThreadsInProject: (projectId: ProjectId) => Promise<void>;
  deleteProjectThreads: (
    projectId: ProjectId,
    options?: {
      confirmMessage?: string | null;
      showEmptyToast?: boolean;
      showResultToast?: boolean;
      worktreeCleanupMode?: "prompt" | "skip";
    },
  ) => Promise<{
    deletedCount: number;
    failureCount: number;
    totalCount: number;
    projectName: string;
  } | null>;
  setRenamingThreadId: Dispatch<SetStateAction<ThreadId | null>>;
  setRenamingTitle: Dispatch<SetStateAction<string>>;
  renamingCommittedRef: MutableRefObject<boolean>;
  setRenamingProjectId: Dispatch<SetStateAction<ProjectId | null>>;
  setRenamingProjectName: Dispatch<SetStateAction<string>>;
  renamingProjectCommittedRef: MutableRefObject<boolean>;
}

export interface SidebarContextMenus {
  handleThreadContextMenu: (
    threadId: ThreadId,
    position: { x: number; y: number },
    options?: {
      extraItems?: Array<{ id: "return-to-single-chat"; label: string }>;
      onExtraAction?: (itemId: "return-to-single-chat") => Promise<void> | void;
    },
  ) => Promise<void>;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleProjectContextMenu: (
    projectId: ProjectId,
    position: { x: number; y: number },
  ) => Promise<void>;
}

export function useSidebarContextMenus(deps: SidebarContextMenusDeps): SidebarContextMenus {
  const {
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
  } = deps;

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
        setRenamingThreadId(threadId);
        setRenamingTitle(thread.title);
        renamingCommittedRef.current = false;
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
      toggleThreadPinned,
      setRenamingThreadId,
      setRenamingTitle,
      renamingCommittedRef,
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
      renamingProjectCommittedRef,
      setRenamingProjectId,
      setRenamingProjectName,
    ],
  );

  return {
    handleThreadContextMenu,
    handleMultiSelectContextMenu,
    handleProjectContextMenu,
  };
}
