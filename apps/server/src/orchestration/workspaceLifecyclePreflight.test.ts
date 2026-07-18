import {
  ProjectId,
  ThreadId,
  WorktreeWorkspaceId,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { DevServerManagerShape } from "../devServerManager";
import type { GitCoreShape } from "../git/Services/GitCore";
import type { TerminalManagerShape } from "../terminal/Services/Manager";
import { getWorkspaceLifecyclePreflight } from "./workspaceLifecyclePreflight";

const now = "2026-07-16T00:00:00.000Z";
const projectId = ProjectId.makeUnsafe("preflight-project");
const workspaceId = WorktreeWorkspaceId.makeUnsafe("preflight-workspace");
const threadId = ThreadId.makeUnsafe("preflight-thread");

function readModel(overrides: Record<string, unknown> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: projectId,
        kind: "project",
        title: "Preflight",
        workspaceRoot: "/repo",
        defaultModelSelection: null,
        scripts: [],
        isPinned: false,
        repositoryIdentity: "repo:preflight",
        defaultTargetRef: "main",
        githubAccount: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    workspaces: [
      {
        id: workspaceId,
        projectId,
        repositoryIdentity: "repo:preflight",
        kind: "managed",
        state: "ready",
        title: "Feature",
        path: "/repo-worktree",
        branch: "feature/preflight",
        headRef: "abc123",
        targetRef: "main",
        targetResolvedCommit: "abc123",
        createdFromCommit: "abc123",
        sourceKind: "new-branch",
        sourceRef: "main",
        setupStatus: "skipped",
        setupError: null,
        setupLogId: null,
        lastKnownPr: null,
        isPinned: false,
        lifecycleGeneration: 1,
        activeOperation: null,
        lastFailure: null,
        mutationRevision: 0,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        ...overrides,
      },
    ],
    threads: [
      {
        id: threadId,
        projectId,
        workspaceId,
        title: "Feature",
        modelSelection: { provider: "codex", model: "gpt-5.5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "worktree",
        branch: "feature/preflight",
        worktreePath: "/repo-worktree",
        associatedWorktreePath: "/repo-worktree",
        associatedWorktreeBranch: "feature/preflight",
        associatedWorktreeRef: "abc123",
        createBranchFlowCompleted: true,
        isPinned: false,
        parentThreadId: null,
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        forkSourceThreadId: null,
        sidechatSourceThreadId: null,
        lastKnownPr: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        handoff: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: now,
  } as OrchestrationReadModel;
}

const fileSystem = {
  exists: () => Effect.succeed(true),
  realPath: (value: string) => Effect.succeed(value),
} as never;

function gitStatus(overrides: Record<string, unknown> = {}): GitCoreShape {
  return {
    statusDetails: () =>
      Effect.succeed({
        branch: "feature/preflight",
        isRepo: true,
        hasOriginRemote: true,
        isDefaultBranch: false,
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: true,
        upstreamBranch: "origin/feature/preflight",
        upstreamRef: "origin/feature/preflight",
        aheadCount: 0,
        behindCount: 0,
        publication: { state: "published", remoteBranch: "feature/preflight", url: "https://x" },
        prUnavailable: false,
        ...overrides,
      }),
    execute: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
  } as unknown as GitCoreShape;
}

const terminalManager = {
  hasRunningSessionForThreadIds: () => Effect.succeed(false),
} as unknown as TerminalManagerShape;

const devServerManager = {
  list: Effect.succeed({ servers: [] }),
} as unknown as DevServerManagerShape;

describe("workspace lifecycle preflight", () => {
  it("blocks dirty and conflicted managed workspaces without mutating them", async () => {
    const result = await Effect.runPromise(
      getWorkspaceLifecyclePreflight({
        readModel: readModel(),
        input: { workspaceId, action: "archive" },
        git: {
          ...gitStatus({ hasWorkingTreeChanges: true }),
          execute: () => Effect.succeed({ code: 0, stdout: "conflicted.ts\0", stderr: "" }),
        } as GitCoreShape,
        fileSystem,
        terminalManager,
        devServerManager,
      }),
    );
    expect(result.canStart).toBe(false);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "merge-conflicts",
      "working-tree-dirty",
    ]);
  });

  it("requires confirmation for a clean local-only branch", async () => {
    const result = await Effect.runPromise(
      getWorkspaceLifecyclePreflight({
        readModel: readModel(),
        input: { workspaceId, action: "archive" },
        git: gitStatus({ hasUpstream: false, upstreamBranch: null, upstreamRef: null }),
        fileSystem,
        terminalManager,
        devServerManager,
      }),
    );
    expect(result).toMatchObject({
      canStart: true,
      requiresConfirmation: true,
      warnings: [{ code: "local-only-commits" }],
    });
  });

  it("requires confirmation when the configured upstream branch was deleted remotely", async () => {
    const result = await Effect.runPromise(
      getWorkspaceLifecyclePreflight({
        readModel: readModel(),
        input: { workspaceId, action: "archive" },
        git: {
          ...gitStatus({
            upstreamBranch: "feature/preflight",
            publication: undefined,
          }),
          execute: ({ args }) => {
            if (args[0] === "diff") {
              return Effect.succeed({ code: 0, stdout: "", stderr: "" });
            }
            if (args[0] === "config") {
              return Effect.succeed({ code: 0, stdout: "origin\n", stderr: "" });
            }
            if (args[0] === "ls-remote") {
              return Effect.succeed({ code: 2, stdout: "", stderr: "" });
            }
            throw new Error(`Unexpected Git command: ${args.join(" ")}`);
          },
        } as GitCoreShape,
        fileSystem,
        terminalManager,
        devServerManager,
      }),
    );

    expect(result).toMatchObject({
      canStart: true,
      requiresConfirmation: true,
      warnings: [{ code: "local-only-commits" }],
    });
  });

  it("blocks active turns, terminals, and the exact workspace dev server", async () => {
    const model = readModel();
    const thread = model.threads[0]!;
    const modelWithActiveTurn: OrchestrationReadModel = {
      ...model,
      threads: [
        {
          ...thread,
          latestTurn: {
            turnId: "turn-active" as never,
            state: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            assistantMessageId: null,
          },
        },
        ...model.threads.slice(1),
      ],
    };
    const result = await Effect.runPromise(
      getWorkspaceLifecyclePreflight({
        readModel: modelWithActiveTurn,
        input: { workspaceId, action: "archive" },
        git: gitStatus(),
        fileSystem,
        terminalManager: {
          ...terminalManager,
          hasRunningSessionForThreadIds: () => Effect.succeed(true),
        } as TerminalManagerShape,
        devServerManager: {
          list: Effect.succeed({
            servers: [
              {
                projectId,
                workspaceId,
                command: "bun dev",
                cwd: "/repo-worktree",
                pid: 42,
                startedAt: now,
                status: "running",
              },
            ],
          }),
        } as unknown as DevServerManagerShape,
      }),
    );
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "agent-active",
      "terminal-active",
      "dev-server-active",
    ]);
  });

  it("blocks runtime activity owned by an archived conversation in the workspace", async () => {
    const model = readModel();
    const thread = model.threads[0]!;
    const modelWithArchivedRuntime: OrchestrationReadModel = {
      ...model,
      threads: [
        {
          ...thread,
          archivedAt: now,
          latestTurn: {
            turnId: "turn-archived-active" as never,
            state: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            assistantMessageId: null,
          },
        },
        ...model.threads.slice(1),
      ],
    };
    const inspectedThreadIds: string[][] = [];
    const result = await Effect.runPromise(
      getWorkspaceLifecyclePreflight({
        readModel: modelWithArchivedRuntime,
        input: { workspaceId, action: "archive" },
        git: gitStatus(),
        fileSystem,
        terminalManager: {
          ...terminalManager,
          hasRunningSessionForThreadIds: (threadIds) =>
            Effect.sync(() => {
              inspectedThreadIds.push([...threadIds]);
              return true;
            }),
        } as TerminalManagerShape,
        devServerManager,
      }),
    );

    expect(inspectedThreadIds).toEqual([[threadId]]);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "agent-active",
      "terminal-active",
    ]);
  });

  it("rejects repository-root lifecycle operations", async () => {
    const result = await Effect.runPromise(
      getWorkspaceLifecyclePreflight({
        readModel: readModel({ kind: "repository-root" }),
        input: { workspaceId, action: "archive" },
        git: gitStatus(),
        fileSystem,
        terminalManager,
        devServerManager,
      }),
    );
    expect(result.canStart).toBe(false);
    expect(result.blockers[0]?.code).toBe("repository-root");
  });

  it("does not let stale runtime metadata block restoring an archived external workspace", async () => {
    const model = readModel({ kind: "external", state: "archived", archivedAt: now });
    const thread = model.threads[0]!;
    const modelWithStaleTurn: OrchestrationReadModel = {
      ...model,
      threads: [
        {
          ...thread,
          latestTurn: {
            turnId: "turn-stale" as never,
            state: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            assistantMessageId: null,
          },
        },
        ...model.threads.slice(1),
      ],
    };
    const result = await Effect.runPromise(
      getWorkspaceLifecyclePreflight({
        readModel: modelWithStaleTurn,
        input: { workspaceId, action: "restore" },
        git: {
          ...gitStatus(),
          execute: () => Effect.succeed({ code: 0, stdout: "/repo/.git\n", stderr: "" }),
        } as GitCoreShape,
        fileSystem,
        terminalManager: {
          ...terminalManager,
          hasRunningSessionForThreadIds: () => Effect.succeed(true),
        } as TerminalManagerShape,
        devServerManager: {
          list: Effect.succeed({
            servers: [
              {
                projectId,
                workspaceId,
                command: "bun dev",
                cwd: "/repo-worktree",
                pid: 42,
                startedAt: now,
                status: "running",
              },
            ],
          }),
        } as unknown as DevServerManagerShape,
      }),
    );
    expect(result).toMatchObject({ canStart: true, blockers: [] });
  });
});
