import type { ThreadId } from "@synara/contracts";
import { terminalScopeIdsForThread } from "@synara/shared/terminalThreads";

import { toastManager } from "../components/ui/toast";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState, getThreadsFromState } from "../threadDerivation";
import type { Thread } from "../types";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { reconcileDeletedThreadFromClient } from "./deletedThreadClientReconciliation";
import { newCommandId } from "./utils";

// the terminal runtime pulls in xterm+addons (~223KB gzip) — a static import anchored it into the eager graph; deleting a thread is rare+async so the chunk is fetched on demand and awaited (never fire-and-forget) so disposal can't race the delete sequence
async function disposeThreadTerminalRuntimes(threadId: ThreadId): Promise<void> {
  try {
    const { terminalRuntimeRegistry } =
      await import("../components/terminal/terminalRuntimeRegistry");
    for (const scopeId of terminalScopeIdsForThread(threadId)) {
      terminalRuntimeRegistry.disposeThread(scopeId);
    }
  } catch (error) {
    // a failed chunk fetch must not abort the delete — the durable delete already landed server-side and the server owns provider/terminal teardown
    console.error("Failed to dispose terminal runtimes for deleted thread", { threadId, error });
  }
}

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
  // provider/terminal cleanup is server-owned; dispose only the local renderer after the durable delete intent was accepted, so a rejected delete never tears down a live session
  await disposeThreadTerminalRuntimes(input.threadId);
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
