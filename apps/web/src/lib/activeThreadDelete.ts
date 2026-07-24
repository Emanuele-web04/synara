// FILE: activeThreadDelete.ts
// Purpose: Owns the shared server-delete and worktree-cleanup sequence for active threads.
// Layer: Web orchestration helper
// Exports: deleteActiveThreadFromClient

import type { ThreadId } from "@synara/contracts";

import { terminalRuntimeRegistry } from "../components/terminal/terminalRuntimeRegistry";
import { toastManager } from "../components/ui/toast";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState, getThreadsFromState } from "../threadDerivation";
import type { Thread } from "../types";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { reconcileDeletedThreadFromClient } from "./deletedThreadClientReconciliation";
import { newCommandId } from "./utils";

export async function deleteActiveThreadFromClient<TPrepared = undefined>(input: {
  readonly threadId: ThreadId;
  readonly deletedThreadIds?: ReadonlySet<ThreadId>;
  readonly reconcileDeletedThread?: boolean;
  readonly worktreeCleanupMode?: "prompt" | "skip";
  readonly prepareForDelete?: (thread: Thread) => TPrepared;
  readonly onDeleted: (input: {
    thread: Thread;
    prepared: TPrepared | undefined;
  }) => void | Promise<void>;
  readonly removeWorktree: (input: {
    cwd: string;
    path: string;
    force: boolean;
  }) => Promise<unknown>;
  readonly unknownWorktreeErrorMessage?: string;
}): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  const state = useStore.getState();
  const thread = getThreadFromState(state, input.threadId);
  if (!thread) return;
  const project = state.projects.find((candidate) => candidate.id === thread.projectId) ?? null;
  const allThreads = getThreadsFromState(state);
  const survivingThreads =
    input.deletedThreadIds && input.deletedThreadIds.size > 0
      ? allThreads.filter(
          (candidate) =>
            candidate.id === input.threadId || !input.deletedThreadIds?.has(candidate.id),
        )
      : allThreads;
  const orphanedWorktreePath = getOrphanedWorktreePathForThread(survivingThreads, input.threadId);
  const displayWorktreePath = orphanedWorktreePath
    ? formatWorktreePathForDisplay(orphanedWorktreePath)
    : null;
  const shouldDeleteWorktree =
    (input.worktreeCleanupMode ?? "prompt") === "prompt" &&
    orphanedWorktreePath !== null &&
    project !== null &&
    (await api.dialogs.confirm(
      [
        "This thread is the only one linked to this worktree:",
        displayWorktreePath ?? orphanedWorktreePath,
        "",
        "Delete the worktree too?",
      ].join("\n"),
    ));

  const prepared = input.prepareForDelete?.(thread);
  await api.orchestration.dispatchCommand({
    type: "thread.delete",
    commandId: newCommandId(),
    threadId: input.threadId,
  });
  // Provider and terminal cleanup are owned by the server-side lifecycle
  // reactor. Dispose only the local renderer after the durable delete intent
  // was accepted, so a rejected delete never tears down a live client session.
  terminalRuntimeRegistry.disposeThread(input.threadId);
  if (input.reconcileDeletedThread ?? true) {
    void reconcileDeletedThreadFromClient({
      threadId: input.threadId,
      removeDeletedThreadFromClientState: useStore.getState().removeDeletedThreadFromClientState,
    });
  }
  await input.onDeleted({ thread, prepared });

  if (!shouldDeleteWorktree || !orphanedWorktreePath || !project) return;
  try {
    await input.removeWorktree({
      cwd: project.cwd,
      path: orphanedWorktreePath,
      force: true,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : (input.unknownWorktreeErrorMessage ?? "Unknown error removing worktree.");
    console.error("Failed to remove orphaned worktree after thread deletion", {
      threadId: input.threadId,
      projectCwd: project.cwd,
      worktreePath: orphanedWorktreePath,
      error,
    });
    toastManager.add({
      type: "error",
      title: "Thread deleted, but worktree removal failed",
      description: `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`,
    });
  }
}
