// FILE: -rootEventInvalidation.ts
// Purpose: Classifies streamed orchestration events that should invalidate shared query caches.
// Layer: Root route utility
// Exports: Event invalidation predicates for provider/project and git query caches.

import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { resolveThreadWorkspaceCwd } from "@t3tools/shared/threadEnvironment";

import type { AppState } from "../store";
import { getThreadFromState } from "../threadDerivation";

const FILE_CHANGE_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.turn-diff-completed",
  "thread.reverted",
  "thread.conversation-rolled-back",
]);

export function shouldInvalidateProviderQueriesForEvent(event: OrchestrationEvent): boolean {
  return FILE_CHANGE_EVENT_TYPES.has(event.type);
}

export function shouldInvalidateGitQueriesForEvent(event: OrchestrationEvent): boolean {
  if (FILE_CHANGE_EVENT_TYPES.has(event.type)) {
    return true;
  }

  if (event.type !== "thread.meta-updated") {
    return false;
  }

  return (
    event.payload.branch !== undefined ||
    event.payload.envMode !== undefined ||
    event.payload.worktreePath !== undefined ||
    event.payload.associatedWorktreePath !== undefined ||
    event.payload.associatedWorktreeBranch !== undefined ||
    event.payload.associatedWorktreeRef !== undefined
  );
}

export function getGitInvalidationThreadIdForEvent(event: OrchestrationEvent): ThreadId | null {
  if (!shouldInvalidateGitQueriesForEvent(event)) {
    return null;
  }
  return "threadId" in event.payload ? (event.payload.threadId as ThreadId) : null;
}

// Resolve after domain events apply, so worktree metadata changes target the new cwd.
export function resolveGitInvalidationCwdForThreadId(
  state: AppState,
  threadId: ThreadId,
): string | null {
  const thread =
    getThreadFromState(state, threadId) ??
    state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    return null;
  }
  const projectCwd = state.projects.find((project) => project.id === thread.projectId)?.cwd ?? null;
  return resolveThreadWorkspaceCwd({
    projectCwd,
    envMode: thread.envMode,
    worktreePath: thread.worktreePath,
  });
}
