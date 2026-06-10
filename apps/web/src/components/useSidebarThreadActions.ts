// Purpose: Thread/project delete + archive + handoff action callbacks extracted from Sidebar.tsx.
// Layer: web hook (client-side orchestration). Owns no rendering; returns memoized callbacks.
// Exports: useSidebarThreadActions, SidebarThreadActionsDeps, SidebarThreadActions.

import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ProjectId, ProviderKind, ThreadId } from "@t3tools/contracts";
import type { useNavigate } from "@tanstack/react-router";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState, getThreadsFromState } from "../threadDerivation";
import { showConfirmDialogFallback } from "../confirmDialogFallback";
import { newCommandId } from "../lib/utils";
import { terminalRuntimeRegistry } from "./terminal/terminalRuntimeRegistry";
import { toastManager } from "./ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  formatWorktreePathForDisplay,
  getOrphanedWorktreePathForThread,
} from "../worktreeCleanup";
import { getFallbackThreadIdAfterDelete } from "./Sidebar.logic";
import {
  resolveSplitViewFocusedThreadId,
  resolveSplitViewPaneIdForThread,
  useSplitViewStore,
  type SplitView,
} from "../splitViewStore";
import type { AppSettings } from "../appSettings";
import type { Project, SidebarThreadSummary, Thread } from "../types";
import type { useDiffRouteSearch } from "../hooks/useDiffRouteSearch";

type RemoveWorktreeMutation = {
  mutateAsync: (input: { cwd: string; path: string; force: boolean }) => Promise<unknown>;
};

export interface SidebarThreadActionsDeps {
  appSettings: Pick<
    AppSettings,
    "sidebarThreadSortOrder" | "confirmThreadDelete" | "confirmThreadArchive"
  >;
  sidebarThreads: readonly SidebarThreadSummary[];
  sidebarThreadSummaryById: Readonly<Record<ThreadId, SidebarThreadSummary | undefined>>;
  projectById: ReadonlyMap<ProjectId, Project>;
  routeThreadId: ThreadId | null;
  routeSearch: ReturnType<typeof useDiffRouteSearch>;
  activeSplitView: SplitView | null;
  navigate: ReturnType<typeof useNavigate>;
  removeWorktreeMutation: RemoveWorktreeMutation;
  handleNewChat: (options?: { fresh?: boolean }) => Promise<{ ok: true } | { ok: false; error: string }>;
  createThreadHandoff: (thread: Thread, targetProvider: ProviderKind) => Promise<Thread["id"]>;
  clearComposerDraftForThread: (threadId: ThreadId) => void;
  clearProjectDraftThreadById: (projectId: ProjectId, threadId: ThreadId) => void;
  clearTerminalState: (threadId: ThreadId) => void;
  clearTemporaryThread: (threadId: ThreadId) => void;
  removeThreadFromSplitViews: (threadId: ThreadId) => void;
  unpinThread: (threadId: ThreadId) => void;
  removeFromSelection: (threadIds: readonly ThreadId[]) => void;
  setPendingArchiveConfirmationThreadId: Dispatch<SetStateAction<ThreadId | null>>;
}

export interface SidebarThreadActions {
  deleteThread: (
    threadId: ThreadId,
    opts?: {
      deletedThreadIds?: ReadonlySet<ThreadId>;
      worktreeCleanupMode?: "prompt" | "skip";
    },
  ) => Promise<void>;
  copyThreadIdToClipboard: (text: string, context: { threadId: ThreadId }) => void;
  copyPathToClipboard: (text: string, context: { path: string }) => void;
  handoffThread: (thread: Thread, targetProvider: ProviderKind) => Promise<void>;
  confirmAndDeleteThread: (threadId: ThreadId) => Promise<void>;
  archiveThread: (threadId: ThreadId) => Promise<void>;
  confirmAndArchiveThread: (threadId: ThreadId) => Promise<void>;
  inlineConfirmArchiveThread: (threadId: ThreadId) => Promise<void>;
  archiveAllThreadsInProject: (projectId: ProjectId) => Promise<void>;
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
  deleteAllThreadsInProject: (projectId: ProjectId) => Promise<void>;
}

export function useSidebarThreadActions(deps: SidebarThreadActionsDeps): SidebarThreadActions {
  const {
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
  } = deps;

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

  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
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
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
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

  return {
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
  };
}
