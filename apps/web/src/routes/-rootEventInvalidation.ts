// FILE: -rootEventInvalidation.ts
// Purpose: Classifies streamed orchestration events that invalidate shared query caches.
// Layer: Root route utility
// Exports: Event invalidation predicates for provider, project, Git, and Studio output caches.

import {
  STUDIO_OUTPUTS_ACTIVITY_KIND,
  type OrchestrationEvent,
  type ThreadId,
} from "@synara/contracts";
import { resolveThreadWorkspaceCwd } from "@synara/shared/threadEnvironment";
import type { QueryClient } from "@tanstack/react-query";

import { providerQueryKeys } from "../lib/providerReactQuery";
import {
  invalidateSettledTurnProjectQueriesForCwds,
  projectQueryKeys,
} from "../lib/projectReactQuery";
import type { AppState } from "../storeState";
import { getThreadFromState } from "../threadDerivation";

const FILE_CHANGE_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.turn-diff-completed",
  "thread.reverted",
  "thread.conversation-rolled-back",
]);

// Reverts and rollbacks rewrite checkpoints the thread's diffs were read from, so
// they still drop every provider and project cache. A finalized turn diff only adds
// one checkpoint: see getTurnDiffInvalidationThreadIdForEvent.
export function shouldInvalidateProviderQueriesForEvent(event: OrchestrationEvent): boolean {
  return event.type === "thread.reverted" || event.type === "thread.conversation-rolled-back";
}

/** The thread whose checkpoint diffs and workspace caches a finalized turn diff refreshes. */
export function getTurnDiffInvalidationThreadIdForEvent(
  event: OrchestrationEvent,
): ThreadId | null {
  return event.type === "thread.turn-diff-completed" ? event.payload.threadId : null;
}

export function shouldInvalidateGitQueriesForEvent(event: OrchestrationEvent): boolean {
  if (FILE_CHANGE_EVENT_TYPES.has(event.type) || isPotentiallyFileMutatingToolCompletion(event)) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activityItemType(event: OrchestrationEvent): unknown {
  if (event.type !== "thread.activity-appended") {
    return null;
  }
  const payload = isRecord(event.payload.activity.payload) ? event.payload.activity.payload : null;
  const data = payload && isRecord(payload.data) ? payload.data : null;
  const item = data && isRecord(data.item) ? data.item : null;
  return payload?.itemType ?? data?.itemType ?? item?.type ?? item?.kind;
}

// Native read/search tools by name, normalized like the transcript's tool-row
// classification (toolCallGroup.logic.ts): Claude's Read/Grep/Glob/LS/WebFetch and
// the equivalents other agents report. Shell commands are never listed here: a
// "read-looking" command can still write, so commands keep refreshing.
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "readfile",
  "viewfile",
  "grep",
  "glob",
  "ls",
  "findfiles",
  "searchfiles",
  "websearch",
  "webfetch",
  "todoread",
  "notebookread",
]);
// ACP tool kinds (Grok, Droid, OMP, Pi) that only read or fetch.
const READ_ONLY_ACP_TOOL_KINDS: ReadonlySet<string> = new Set(["read", "search", "fetch", "think"]);

function isKnownReadOnlyToolCompletion(event: OrchestrationEvent): boolean {
  if (event.type !== "thread.activity-appended") {
    return false;
  }
  const itemType = activityItemType(event);
  if (itemType === "web_search" || itemType === "image_view") {
    return true;
  }
  const payload = isRecord(event.payload.activity.payload) ? event.payload.activity.payload : null;
  const data = payload && isRecord(payload.data) ? payload.data : null;
  if (typeof data?.kind === "string" && READ_ONLY_ACP_TOOL_KINDS.has(data.kind)) {
    return true;
  }
  // Exact names only: an MCP tool (`mcp__server__read`) or anything unrecognized
  // may write, and stays a refresh trigger.
  const toolName = data?.toolName ?? payload?.toolName;
  return (
    typeof toolName === "string" &&
    READ_ONLY_TOOL_NAMES.has(toolName.toLowerCase().replace(/[^a-z]/g, ""))
  );
}

function isPotentiallyFileMutatingToolCompletion(event: OrchestrationEvent): boolean {
  if (
    event.type !== "thread.activity-appended" ||
    event.payload.activity.kind !== "tool.completed"
  ) {
    return false;
  }
  // Known read-only tools should not trigger expensive file/diff reads. Every
  // other completed tool can write through a shell, MCP, subagent, script, or
  // provider-specific payload, including older payloads with no itemType.
  return !isKnownReadOnlyToolCompletion(event);
}

/**
 * Tool completions only move the local working copy, so they refresh local Git state
 * (status, branches, commits, diffs) but not the GitHub repository or pull requests;
 * those follow finalized turn diffs, workspace metadata changes, focus and polling.
 */
export function isLocalGitActivityInvalidationEvent(event: OrchestrationEvent): boolean {
  return isPotentiallyFileMutatingToolCompletion(event);
}

// Activities stream while a turn is still running; file-change tool calls are the
// earliest signal that workspace files were touched. Invalidating the project
// file queries on them lets the editor file tree and open file preview refresh
// mid-turn instead of waiting for the turn diff to complete.
export function getProjectFileInvalidationThreadIdForEvent(
  event: OrchestrationEvent,
): ThreadId | null {
  if (FILE_CHANGE_EVENT_TYPES.has(event.type)) {
    return "threadId" in event.payload ? (event.payload.threadId as ThreadId) : null;
  }
  if (event.type !== "thread.activity-appended") {
    return null;
  }
  const payload = isRecord(event.payload.activity.payload) ? event.payload.activity.payload : null;
  if (!payload) {
    return null;
  }
  if (
    payload.requestKind === "file-change" ||
    activityItemType(event) === "file_change" ||
    isPotentiallyFileMutatingToolCompletion(event)
  ) {
    return event.payload.threadId;
  }
  return null;
}

/** Invalidates one Studio output list after attribution or filesystem state changes. */
export function getStudioOutputInvalidationThreadIdForEvent(
  event: OrchestrationEvent,
): ThreadId | null {
  if (event.type === "thread.activity-appended") {
    // Server-side per-turn output capture is the authoritative attribution signal.
    if (event.payload.activity.kind === STUDIO_OUTPUTS_ACTIVITY_KIND) {
      return event.payload.threadId;
    }
    return event.payload.activity.kind === "tool.completed"
      ? getProjectFileInvalidationThreadIdForEvent(event)
      : null;
  }
  if (!FILE_CHANGE_EVENT_TYPES.has(event.type)) {
    return null;
  }
  return "threadId" in event.payload ? (event.payload.threadId as ThreadId) : null;
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
  const thread = getThreadFromState(state, threadId);
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

/**
 * A finalized turn diff adds one checkpoint to its own thread: refresh that thread's
 * checkpoint diffs and its workspace's settled-turn project caches. File queries are
 * left to the scoped file-change pass the same event feeds. Returns false when a
 * thread's workspace could not be resolved and every project cache was dropped instead.
 */
export function invalidateFinalizedTurnDiffQueries(
  queryClient: QueryClient,
  state: AppState,
  threadIds: Iterable<ThreadId>,
): boolean {
  const cwds = new Set<string>();
  let resolvedEveryThread = true;
  for (const threadId of threadIds) {
    // Prefix of providerQueryKeys.checkpointDiff for this thread.
    void queryClient.invalidateQueries({
      queryKey: [...providerQueryKeys.all, "checkpointDiff", threadId],
    });
    const cwd = resolveGitInvalidationCwdForThreadId(state, threadId);
    if (cwd) {
      cwds.add(cwd);
    } else {
      resolvedEveryThread = false;
    }
  }
  if (!resolvedEveryThread) {
    void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
    return false;
  }
  void invalidateSettledTurnProjectQueriesForCwds(queryClient, cwds);
  return true;
}
