import {
  ProjectId,
  ThreadId,
  type NativeApi,
  type OrchestrationThreadPullRequest,
  type OrchestrationWorkspaceShellSnapshot,
  type OrchestrationWorktreeWorkspace,
  WorktreeWorkspaceId,
} from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import type { Project } from "../types";
import { openPullRequestWorkspace } from "./pullRequestWorkspace";

const projectId = ProjectId.makeUnsafe("project-1");
const pr: OrchestrationThreadPullRequest = {
  number: 42,
  title: "Durable PR workspace",
  url: "https://github.com/owner/repo/pull/42",
  baseBranch: "release",
  headBranch: "feature/durable-pr",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 12,
  deletions: 3,
  changedFiles: 2,
};
const project: Project = {
  id: projectId,
  kind: "project",
  name: "Repo",
  remoteName: "Repo",
  folderName: "repo",
  localName: null,
  cwd: "/repo",
  repositoryIdentity: "github.com/owner/repo",
  defaultTargetRef: "main",
  githubAccount: { host: "github.com", login: "reviewer" },
  defaultModelSelection: { provider: "codex", model: "gpt-5.5" },
  expanded: true,
  scripts: [],
};

function workspace(
  patch: Partial<OrchestrationWorktreeWorkspace> = {},
): OrchestrationWorktreeWorkspace {
  return {
    id: WorktreeWorkspaceId.makeUnsafe("workspace-1"),
    projectId,
    repositoryIdentity: "github.com/owner/repo",
    kind: "managed",
    state: "ready",
    title: pr.title,
    path: "/worktrees/pr-42",
    branch: "feature/durable-pr",
    headRef: null,
    targetRef: "release",
    targetResolvedCommit: "abc",
    createdFromCommit: "abc",
    sourceKind: "pull-request",
    sourceRef: pr.url,
    setupStatus: "succeeded",
    setupError: null,
    setupLogId: null,
    lastKnownPr: pr,
    isPinned: false,
    lifecycleGeneration: 1,
    activeOperation: null,
    lastFailure: null,
    mutationRevision: 0,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    ...patch,
  };
}

function thread(workspaceId = workspace().id, id = "thread-1") {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId,
    workspaceId,
    title: "Review PR #42",
    modelSelection: { provider: "codex" as const, model: "gpt-5.5" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    envMode: "worktree" as const,
    branch: "feature/durable-pr",
    worktreePath: "/worktrees/pr-42",
    latestTurn: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    handoff: null,
    session: null,
  };
}

function snapshot(
  workspaces: OrchestrationWorktreeWorkspace[],
  threads: OrchestrationWorkspaceShellSnapshot["threads"] = [],
): OrchestrationWorkspaceShellSnapshot {
  return {
    protocolVersion: 2,
    snapshotSequence: 1,
    projects: [],
    workspaces,
    threads,
    updatedAt: "2026-07-16T00:00:00.000Z",
  };
}

describe("openPullRequestWorkspace", () => {
  it("resolves with the project account before reserving a managed workspace", async () => {
    const calls: string[] = [];
    let current = snapshot([]);
    const resolvePullRequest = vi.fn(async () => {
      calls.push("resolve");
      return { pullRequest: pr };
    });
    const dispatchCommand = vi.fn(
      async (command: { type: string; workspaceId: string; threadId: string }) => {
        calls.push(command.type);
        if (command.type === "workspace.create") {
          current = snapshot(
            [workspace({ id: WorktreeWorkspaceId.makeUnsafe(command.workspaceId) })],
            [thread(WorktreeWorkspaceId.makeUnsafe(command.workspaceId), command.threadId)],
          );
        }
        return { sequence: 1 };
      },
    );
    const api = {
      git: { resolvePullRequest },
      orchestration: {
        getWorkspaceShellSnapshot: vi.fn(async () => current),
        dispatchCommand,
      },
    } as unknown as NativeApi;

    const result = await openPullRequestWorkspace({
      api,
      project,
      defaultProvider: "codex",
      intent: "open",
      reference: "owner/repo#42",
    });

    expect(calls.slice(0, 2)).toEqual(["resolve", "workspace.create"]);
    expect(resolvePullRequest).toHaveBeenCalledWith({
      cwd: "/repo",
      reference: "owner/repo#42",
      account: { host: "github.com", login: "reviewer" },
    });
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "workspace.create",
        sourceKind: "pull-request",
        sourceRef: pr.url,
        targetRef: "release",
        branch: "feature/durable-pr",
        lastKnownPr: pr,
      }),
    );
    expect(result.association).toBe("created");
  });

  it("opens an active associated workspace without any Git or create mutation", async () => {
    const dispatchCommand = vi.fn();
    const api = {
      git: { resolvePullRequest: vi.fn() },
      orchestration: {
        getWorkspaceShellSnapshot: vi.fn(async () => snapshot([workspace()], [thread()])),
        dispatchCommand,
      },
    } as unknown as NativeApi;

    const result = await openPullRequestWorkspace({
      api,
      project,
      defaultProvider: "codex",
      intent: "open",
      pullRequest: pr,
    });

    expect(result.association).toBe("active");
    expect(result.threadId).toBe("thread-1");
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it.each(["error", "setup-failed"] as const)(
    "retries a durable PR reservation from %s without creating another workspace",
    async (state) => {
      const failed = workspace({
        state,
        path: "/worktrees/pr-42",
        lifecycleGeneration: 1,
        lastFailure: {
          generation: 1,
          kind: state === "setup-failed" ? "setup" : "provision",
          stage: state === "setup-failed" ? "setup" : "resolve-target",
          summary: state === "setup-failed" ? "setup script failed" : "base was not available",
          logId: null,
        },
      });
      let current = snapshot([failed], [thread()]);
      const dispatchCommand = vi.fn(
        async (command: { type: string; expectedGeneration?: number }) => {
          if (command.type === "workspace.provision.request") {
            expect(command.expectedGeneration).toBe(1);
            current = snapshot([workspace({ lifecycleGeneration: 2 })], [thread()]);
          }
          return { sequence: 1 };
        },
      );
      const api = {
        orchestration: {
          getWorkspaceShellSnapshot: vi.fn(async () => current),
          dispatchCommand,
        },
      } as unknown as NativeApi;

      const result = await openPullRequestWorkspace({
        api,
        project,
        defaultProvider: "codex",
        intent: "open",
        pullRequest: pr,
      });

      expect(result.association).toBe("active");
      expect(result.workspace.state).toBe("ready");
      expect(dispatchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "workspace.provision.request",
          workspaceId: failed.id,
          expectedGeneration: 1,
        }),
      );
      expect(dispatchCommand).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "workspace.create" }),
      );
    },
  );

  it("restores an archived association before opening its existing conversation", async () => {
    const archived = workspace({
      state: "archived",
      path: null,
      archivedAt: "2026-07-16T01:00:00.000Z",
      lifecycleGeneration: 2,
    });
    let current = snapshot([archived], [thread()]);
    const dispatchCommand = vi.fn(async (command: { type: string }) => {
      if (command.type === "workspace.restore.request") {
        current = snapshot([workspace({ lifecycleGeneration: 3 })], [thread()]);
      }
      return { sequence: 1 };
    });
    const api = {
      orchestration: {
        getWorkspaceShellSnapshot: vi.fn(async () => current),
        getWorkspaceLifecyclePreflight: vi.fn(async () => ({
          workspaceId: archived.id,
          action: "restore",
          lifecycleGeneration: 2,
          canStart: true,
          requiresConfirmation: false,
          blockers: [],
          warnings: [],
        })),
        dispatchCommand,
      },
    } as unknown as NativeApi;

    const result = await openPullRequestWorkspace({
      api,
      project,
      defaultProvider: "codex",
      intent: "open",
      pullRequest: pr,
    });

    expect(result.association).toBe("restored");
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "workspace.restore.request", workspaceId: archived.id }),
    );
    expect(dispatchCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "workspace.create" }),
    );
  });

  it("adds a fresh review conversation to an active association", async () => {
    let current = snapshot([workspace()], [thread()]);
    const dispatchCommand = vi.fn(async (command: { type: string; threadId: string }) => {
      if (command.type === "workspace.conversation.create") {
        current = snapshot(
          [workspace()],
          [...current.threads, thread(workspace().id, command.threadId)],
        );
      }
      return { sequence: 1 };
    });
    const api = {
      orchestration: {
        getWorkspaceShellSnapshot: vi.fn(async () => current),
        dispatchCommand,
      },
    } as unknown as NativeApi;

    const result = await openPullRequestWorkspace({
      api,
      project,
      defaultProvider: "codex",
      intent: "new-conversation",
      pullRequest: pr,
    });

    expect(result.threadId).not.toBe("thread-1");
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "workspace.conversation.create",
        workspaceId: workspace().id,
        title: "Review PR #42",
      }),
    );
  });

  it("recovers the server reservation when another caller wins the create race", async () => {
    let snapshotReads = 0;
    const dispatchCommand = vi.fn(async () => {
      throw new Error("PR #42 is already reserved");
    });
    const api = {
      orchestration: {
        getWorkspaceShellSnapshot: vi.fn(async () => {
          snapshotReads += 1;
          return snapshotReads === 1 ? snapshot([]) : snapshot([workspace()], [thread()]);
        }),
        dispatchCommand,
      },
    } as unknown as NativeApi;

    const result = await openPullRequestWorkspace({
      api,
      project,
      defaultProvider: "codex",
      intent: "open",
      pullRequest: pr,
    });

    expect(result.association).toBe("active");
    expect(result.threadId).toBe("thread-1");
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
  });
});
