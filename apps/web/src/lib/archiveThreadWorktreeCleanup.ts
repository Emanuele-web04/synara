// FILE: archiveThreadWorktreeCleanup.ts
// Purpose: Releases a finished task's worktree after it was archived, when the user opted in.
// Layer: Web orchestration helper
// Exports: releaseOrphanedWorktreeAfterArchive

import type { GitRemoveWorktreeInput, ThreadId } from "@synara/contracts";

import { toastManager } from "../components/ui/toast";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";

export type ArchiveWorktreeCleanupOutcome = "removed" | "kept" | "skipped";

/**
 * Call only after the archive command was accepted. Removes the archived thread's worktree
 * when the "Delete worktree on archive" setting is on and no other thread uses it. The
 * removal is never forced, so a worktree with uncommitted changes survives, and nothing
 * here throws: the archive already succeeded and must not be reported as failed.
 */
export async function releaseOrphanedWorktreeAfterArchive(input: {
  readonly threadId: ThreadId;
  /** Receipt sequence of the archive event that scheduled this cleanup. */
  readonly archiveSequence: number;
  /** The `archiveDeletesOrphanedWorktree` app setting. */
  readonly enabled: boolean;
  readonly removeWorktree: (input: GitRemoveWorktreeInput) => Promise<unknown>;
}): Promise<ArchiveWorktreeCleanupOutcome> {
  if (!input.enabled) return "skipped";
  const state = useStore.getState();
  const thread = getThreadFromState(state, input.threadId);
  if (!thread || thread.archivedAt == null) return "skipped";
  const project = state.projects.find((candidate) => candidate.id === thread.projectId) ?? null;
  if (!project) return "skipped";
  const worktreePath = thread.worktreePath ?? thread.associatedWorktreePath;
  if (!worktreePath) return "skipped";
  const displayName = formatWorktreePathForDisplay(worktreePath);
  try {
    // The server checks this exact archive event, session stop, and every
    // canonical worktree association under the Git mutation lock.
    await input.removeWorktree({
      cwd: project.cwd,
      path: worktreePath,
      force: false,
      reclaimTemporaryBranch: false,
      archiveCleanup: { threadId: input.threadId, archiveSequence: input.archiveSequence },
    });
  } catch (error) {
    console.info("Kept worktree after archiving its thread", {
      threadId: input.threadId,
      worktreePath,
      error,
    });
    toastManager.add({
      type: "info",
      title: "Worktree kept",
      description: `${displayName} could not be removed safely. Check its task, Git status, or connection.`,
    });
    return "kept";
  }
  toastManager.add({
    type: "success",
    title: "Worktree removed",
    description: `${displayName} was deleted. Its branch remains available for recovery.`,
  });
  return "removed";
}
