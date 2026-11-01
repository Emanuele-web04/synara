// FILE: -rootEventInvalidation.test.ts
// Purpose: Covers root event cache invalidation decisions for streamed orchestration updates.
// Layer: Route utility unit tests
// Depends on: rootEventInvalidation predicates and Vitest assertions.

import { ProjectId, ThreadId, type OrchestrationEvent } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  getGitInvalidationThreadIdForEvent,
  getProjectFileInvalidationThreadIdForEvent,
  getStudioOutputInvalidationThreadIdForEvent,
  getTurnDiffInvalidationThreadIdForEvent,
  invalidateFinalizedTurnDiffQueries,
  isLocalGitActivityInvalidationEvent,
  resolveGitInvalidationCwdForThreadId,
  shouldInvalidateGitQueriesForEvent,
  shouldInvalidateProviderQueriesForEvent,
} from "./-rootEventInvalidation";
import type { AppState } from "../store";
import type { Thread } from "../types";

function event(type: OrchestrationEvent["type"], payload: object = {}): OrchestrationEvent {
  return {
    type,
    payload,
  } as OrchestrationEvent;
}

describe("root event invalidation", () => {
  it("scopes a finalized turn diff to its own thread", () => {
    const threadId = ThreadId.makeUnsafe("thread-turn-diff");
    const turnDiffEvent = event("thread.turn-diff-completed", { threadId });

    expect(shouldInvalidateGitQueriesForEvent(turnDiffEvent)).toBe(true);
    // Full Git refresh (pull requests included), not the local tool-activity one.
    expect(isLocalGitActivityInvalidationEvent(turnDiffEvent)).toBe(false);
    // No longer drops every provider and project cache.
    expect(shouldInvalidateProviderQueriesForEvent(turnDiffEvent)).toBe(false);
    expect(getTurnDiffInvalidationThreadIdForEvent(turnDiffEvent)).toBe(threadId);
    expect(getProjectFileInvalidationThreadIdForEvent(turnDiffEvent)).toBe(threadId);
    expect(getTurnDiffInvalidationThreadIdForEvent(event("thread.reverted", { threadId }))).toBe(
      null,
    );
  });

  it("invalidates git queries when checkpoint changes can rewrite files", () => {
    for (const type of ["thread.reverted", "thread.conversation-rolled-back"] as const) {
      expect(shouldInvalidateGitQueriesForEvent(event(type))).toBe(true);
      expect(shouldInvalidateProviderQueriesForEvent(event(type))).toBe(true);
    }
  });

  it("invalidates git queries when thread workspace metadata changes", () => {
    expect(
      shouldInvalidateGitQueriesForEvent(event("thread.meta-updated", { branch: "feature/diff" })),
    ).toBe(true);
  });

  it("leaves unrelated events alone", () => {
    expect(shouldInvalidateGitQueriesForEvent(event("thread.message-sent"))).toBe(false);
    expect(shouldInvalidateProviderQueriesForEvent(event("thread.message-sent"))).toBe(false);
  });

  it("extracts thread ids from mid-turn file-change activities", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const fileChangeActivity = (payload: unknown) =>
      event("thread.activity-appended", {
        threadId,
        activity: { payload },
      });

    expect(
      getProjectFileInvalidationThreadIdForEvent(
        fileChangeActivity({ requestKind: "file-change" }),
      ),
    ).toBe(threadId);
    expect(
      getProjectFileInvalidationThreadIdForEvent(fileChangeActivity({ itemType: "file_change" })),
    ).toBe(threadId);
    expect(
      getProjectFileInvalidationThreadIdForEvent(
        fileChangeActivity({ data: { item: { type: "file_change" } } }),
      ),
    ).toBe(threadId);
    expect(
      getProjectFileInvalidationThreadIdForEvent(fileChangeActivity({ requestKind: "command" })),
    ).toBe(null);
    expect(
      getProjectFileInvalidationThreadIdForEvent(event("thread.message-sent", { threadId })),
    ).toBe(null);
  });

  it("invalidates project files and git diffs after tools that may mutate the workspace", () => {
    const threadId = ThreadId.makeUnsafe("thread-tools");
    const completedTool = (itemType?: string) =>
      event("thread.activity-appended", {
        threadId,
        activity: {
          kind: "tool.completed",
          payload: itemType ? { itemType } : {},
        },
      });

    for (const itemType of [
      "command_execution",
      "file_change",
      "mcp_tool_call",
      "dynamic_tool_call",
      "collab_agent_tool_call",
      "image_generation",
    ]) {
      const toolEvent = completedTool(itemType);
      expect(getProjectFileInvalidationThreadIdForEvent(toolEvent)).toBe(threadId);
      expect(shouldInvalidateGitQueriesForEvent(toolEvent)).toBe(true);
    }

    expect(getProjectFileInvalidationThreadIdForEvent(completedTool())).toBe(threadId);
    expect(getProjectFileInvalidationThreadIdForEvent(completedTool("web_search"))).toBe(null);
    expect(shouldInvalidateGitQueriesForEvent(completedTool("image_view"))).toBe(false);
  });

  it("skips refreshes after known read-only tools and keeps them for everything else", () => {
    const threadId = ThreadId.makeUnsafe("thread-read-only");
    const completed = (payload: Record<string, unknown>) =>
      event("thread.activity-appended", {
        threadId,
        activity: { kind: "tool.completed", payload },
      });
    const claudeTool = (toolName: string, itemType = "dynamic_tool_call") =>
      completed({ itemType, data: { toolCallId: toolName, toolName } });
    const acpTool = (kind: string) =>
      completed({ itemType: "dynamic_tool_call", data: { toolCallId: kind, kind } });

    for (const readOnly of [
      claudeTool("Read"),
      claudeTool("Grep"),
      claudeTool("Glob"),
      claudeTool("LS"),
      claudeTool("WebFetch"),
      acpTool("read"),
      acpTool("search"),
      acpTool("fetch"),
    ]) {
      expect(shouldInvalidateGitQueriesForEvent(readOnly)).toBe(false);
      expect(getProjectFileInvalidationThreadIdForEvent(readOnly)).toBe(null);
      expect(getStudioOutputInvalidationThreadIdForEvent(readOnly)).toBe(null);
    }

    for (const mutating of [
      claudeTool("Bash", "command_execution"),
      claudeTool("Edit", "file_change"),
      claudeTool("mcp__files__read_file", "mcp_tool_call"),
      claudeTool("SomeNewTool"),
      acpTool("execute"),
      acpTool("edit"),
      completed({ itemType: "command_execution", data: { command: "cat README.md" } }),
    ]) {
      expect(shouldInvalidateGitQueriesForEvent(mutating)).toBe(true);
      expect(isLocalGitActivityInvalidationEvent(mutating)).toBe(true);
      expect(getProjectFileInvalidationThreadIdForEvent(mutating)).toBe(threadId);
    }
  });

  it("refreshes pull requests only for turn-level and workspace metadata events", () => {
    expect(
      isLocalGitActivityInvalidationEvent(event("thread.meta-updated", { branch: "feature/diff" })),
    ).toBe(false);
    expect(isLocalGitActivityInvalidationEvent(event("thread.reverted"))).toBe(false);
  });

  it("invalidates project files when a turn diff or rollback settles", () => {
    const threadId = ThreadId.makeUnsafe("thread-checkpoint");

    expect(
      getProjectFileInvalidationThreadIdForEvent(event("thread.turn-diff-completed", { threadId })),
    ).toBe(threadId);
    expect(getProjectFileInvalidationThreadIdForEvent(event("thread.reverted", { threadId }))).toBe(
      threadId,
    );
  });

  it("extracts affected thread ids for scoped git invalidation", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");

    expect(
      getGitInvalidationThreadIdForEvent(event("thread.turn-diff-completed", { threadId })),
    ).toBe(threadId);
    expect(getGitInvalidationThreadIdForEvent(event("thread.message-sent", { threadId }))).toBe(
      null,
    );
  });

  it("invalidates Studio outputs for file-change activities and finalized checkpoints", () => {
    const threadId = ThreadId.makeUnsafe("thread-studio");
    const fileChangeActivity = event("thread.activity-appended", {
      threadId,
      activity: { kind: "tool.completed", payload: { itemType: "file_change" } },
    });

    expect(getStudioOutputInvalidationThreadIdForEvent(fileChangeActivity)).toBe(threadId);
    expect(
      getStudioOutputInvalidationThreadIdForEvent(
        event("thread.activity-appended", {
          threadId,
          activity: { kind: "studio.outputs.captured", payload: { itemType: "studio_outputs" } },
        }),
      ),
    ).toBe(threadId);
    expect(
      getStudioOutputInvalidationThreadIdForEvent(
        event("thread.turn-diff-completed", { threadId }),
      ),
    ).toBe(threadId);
    expect(
      getStudioOutputInvalidationThreadIdForEvent(event("thread.message-sent", { threadId })),
    ).toBe(null);
    expect(
      getStudioOutputInvalidationThreadIdForEvent(
        event("thread.activity-appended", {
          threadId,
          activity: { kind: "tool.updated", payload: { itemType: "file_change" } },
        }),
      ),
    ).toBe(null);
  });

  it("invalidates only the finalized thread's diffs and workspace caches", () => {
    const projectId = ProjectId.makeUnsafe("project-scoped");
    const finishedId = ThreadId.makeUnsafe("thread-finished");
    const otherId = ThreadId.makeUnsafe("thread-other");
    const state: AppState = {
      spaces: [],
      projects: [{ id: projectId, cwd: "/repo/main" }] as AppState["projects"],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
      threadIds: [finishedId, otherId],
      threadShellById: {
        [finishedId]: makeThread({ id: finishedId, projectId }),
        [otherId]: makeThread({
          id: otherId,
          projectId,
          envMode: "worktree",
          worktreePath: "/repo/other",
        }),
      },
    };
    const queryClient = new QueryClient();
    const keys = {
      finishedDiff: ["providers", "checkpointDiff", finishedId, 0, 1, false, null],
      otherDiff: ["providers", "checkpointDiff", otherId, 0, 1, false, null],
      finishedScripts: ["projects", "discover-scripts", "/repo/main", 2],
      otherScripts: ["projects", "discover-scripts", "/repo/other", 2],
      // Left to the throttled file-change pass that the same event feeds.
      finishedFile: ["projects", "read-file", "/repo/main", "README.md"],
    };
    for (const key of Object.values(keys)) queryClient.setQueryData(key, {});

    expect(invalidateFinalizedTurnDiffQueries(queryClient, state, [finishedId])).toBe(true);

    const invalidated = Object.entries(keys)
      .filter(([, key]) => queryClient.getQueryState(key)?.isInvalidated)
      .map(([name]) => name);
    expect(invalidated).toEqual(["finishedDiff", "finishedScripts"]);
    expect(
      invalidateFinalizedTurnDiffQueries(queryClient, state, [ThreadId.makeUnsafe("missing")]),
    ).toBe(false);
    expect(queryClient.getQueryState(keys.otherScripts)?.isInvalidated).toBe(true);
  });

  it("resolves local and worktree cwd from the current thread projection", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const localThreadId = ThreadId.makeUnsafe("thread-local");
    const worktreeThreadId = ThreadId.makeUnsafe("thread-worktree");
    const localThread = makeThread({
      id: localThreadId,
      projectId,
      envMode: "local",
      worktreePath: null,
    });
    const worktreeThread = makeThread({
      id: worktreeThreadId,
      projectId,
      envMode: "worktree",
      worktreePath: "/repo/worktree",
    });
    const state: AppState = {
      spaces: [],
      projects: [{ id: projectId, cwd: "/repo/main" }] as AppState["projects"],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
      threadIds: [localThreadId, worktreeThreadId],
      threadShellById: {
        [localThreadId]: localThread,
        [worktreeThreadId]: worktreeThread,
      },
    };

    expect(resolveGitInvalidationCwdForThreadId(state, localThreadId)).toBe("/repo/main");
    expect(resolveGitInvalidationCwdForThreadId(state, worktreeThreadId)).toBe("/repo/worktree");
  });
});

function makeThread(overrides: Partial<Thread>): Thread {
  return {
    id: ThreadId.makeUnsafe("thread"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project"),
    title: "Thread",
    modelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}
