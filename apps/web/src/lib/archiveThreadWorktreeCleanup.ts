// FILE: archiveThreadWorktreeCleanup.ts
// Purpose: Releases a finished task's worktree after it was archived, when the user opted in.
// Layer: Web orchestration helper
// Exports: releaseOrphanedWorktreeAfterArchive

import type { ThreadId } from "@synara/contracts";

import { isThreadRunningForActivity } from "../components/SidebarActivityView.logic";
import { toastManager } from "../components/ui/toast";
import { useStore } from "../store";
import { getThreadFromState, getThreadsFromState } from "../threadDerivation";
import {
  formatWorktreePathForDisplay,
  getOrphanedWorktreePathForThread,
  isThreadAssociatedWithWorktree,
} from "../worktreeCleanup";

export type ArchiveWorktreeCleanupOutcome = "removed" | "kept" | "skipped";

/**
 * Call only after the archive command was accepted. Removes the archived thread's worktree
 * when the "Delete worktree on archive" setting is on and no other thread uses it. The
 * removal is never forced, so a worktree with uncommitted changes survives, and nothing
 * here throws: the archive already succeeded and must not be reported as failed.
 */
export async function releaseOrphanedWorktreeAfterArchive(input: {
  readonly threadId: ThreadId;
  /** The `archiveDeletesOrphanedWorktree` app setting. */
  readonly enabled: boolean;
  readonly removeWorktree: (input: {
    cwd: string;
    path: string;
    force: boolean;
  }) => Promise<unknown>;
}): Promise<ArchiveWorktreeCleanupOutcome> {
  if (!input.enabled) return "skipped";
  const state = useStore.getState();
  const thread = getThreadFromState(state, input.threadId);
  if (!thread) return "skipped";
  const project = state.projects.find((candidate) => candidate.id === thread.projectId) ?? null;
  if (!project) return "skipped";
  // A turn that is still running (or starting) may be writing into the worktree.
  const summary = state.sidebarThreadSummaryById[input.threadId];
  const isBusy = isThreadRunningForActivity(
    summary ?? { hasLiveTailWork: false, session: thread.session, latestTurn: thread.latestTurn },
  );
  if (isBusy) return "skipped";

  const threads = getThreadsFromState(state);
  const worktreePath = getOrphanedWorktreePathForThread(threads, input.threadId);
  if (!worktreePath) return "skipped";
  // A thread that moved back to local still points at the worktree it came from.
  const isStillAssociated = threads.some(
    (candidate) =>
      candidate.id !== input.threadId && isThreadAssociatedWithWorktree(candidate, worktreePath),
  );
  if (isStillAssociated) return "skipped";

  const displayName = formatWorktreePathForDisplay(worktreePath);
  try {
    await input.removeWorktree({ cwd: project.cwd, path: worktreePath, force: false });
  } catch (error) {
    console.info("Kept worktree after archiving its thread", {
      threadId: input.threadId,
      worktreePath,
      error,
    });
    toastManager.add({
      type: "info",
      title: "Worktree kept",
      description: `${displayName} has uncommitted changes or is still in use.`,
    });
    return "kept";
  }
  toastManager.add({
    type: "success",
    title: "Worktree removed",
    description: `${displayName} was deleted because no other task uses it.`,
  });
  return "removed";
}
