// FILE: managedWorkspace.test.ts
// Purpose: Locks readiness, failure, and timeout handling for managed workspace creation.

import {
  ProjectId,
  ThreadId,
  WorktreeWorkspaceId,
  type OrchestrationWorkspaceShellSnapshot,
  type OrchestrationWorktreeWorkspace,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  waitForManagedWorkspaceReady,
  waitForWorkspaceConversationSnapshot,
} from "./managedWorkspace";

const workspaceId = WorktreeWorkspaceId.makeUnsafe("workspace-1");
const threadId = ThreadId.makeUnsafe("thread-1");

function workspace(
  patch: Partial<OrchestrationWorktreeWorkspace> = {},
): OrchestrationWorktreeWorkspace {
  return {
    id: workspaceId,
    projectId: ProjectId.makeUnsafe("project-1"),
    repositoryIdentity: "/tmp/repo",
    kind: "managed",
    state: "provisioning",
    title: "Workspace",
    path: null,
    branch: null,
    headRef: null,
    targetRef: "main",
    targetResolvedCommit: null,
    createdFromCommit: null,
    sourceKind: "new-branch",
    sourceRef: null,
    setupStatus: "pending",
    setupError: null,
    setupLogId: null,
    lastKnownPr: null,
    isPinned: false,
    lifecycleGeneration: 1,
    activeOperation: null,
    lastFailure: null,
    mutationRevision: 0,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    ...patch,
  };
}

function snapshot(
  workspaces: OrchestrationWorktreeWorkspace[],
): OrchestrationWorkspaceShellSnapshot {
  return {
    protocolVersion: 2,
    snapshotSequence: 1,
    projects: [],
    workspaces,
    threads: [],
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

describe("waitForManagedWorkspaceReady", () => {
  it("waits through projection lag and provisioning", async () => {
    const snapshots = [
      snapshot([]),
      snapshot([workspace()]),
      snapshot([
        workspace({
          state: "ready",
          path: "/tmp/worktree",
          branch: "synara/workspace-1",
          setupStatus: "succeeded",
        }),
      ]),
    ];

    const ready = await waitForManagedWorkspaceReady({
      workspaceId,
      loadSnapshot: async () => snapshots.shift() ?? snapshots.at(-1)!,
      pollIntervalMs: 1,
      timeoutMs: 5,
      sleep: async () => undefined,
    });

    expect(ready.path).toBe("/tmp/worktree");
    expect(ready.branch).toBe("synara/workspace-1");
  });

  it("surfaces the durable provisioning failure", async () => {
    await expect(
      waitForManagedWorkspaceReady({
        workspaceId,
        loadSnapshot: async () =>
          snapshot([
            workspace({
              state: "error",
              lastFailure: {
                generation: 1,
                kind: "provision",
                stage: "git-worktree-add",
                summary: "target branch is missing",
                logId: null,
              },
            }),
          ]),
        pollIntervalMs: 1,
        timeoutMs: 1,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("git-worktree-add: target branch is missing");
  });

  it("times out with the last observed state", async () => {
    await expect(
      waitForManagedWorkspaceReady({
        workspaceId,
        loadSnapshot: async () => snapshot([workspace()]),
        pollIntervalMs: 1,
        timeoutMs: 2,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("last state: provisioning");
  });
});

describe("waitForWorkspaceConversationSnapshot", () => {
  it("waits for the projected thread before returning the snapshot", async () => {
    const thread = {
      id: threadId,
      projectId: ProjectId.makeUnsafe("project-1"),
      workspaceId,
      title: "Conversation",
      modelSelection: { provider: "codex", model: "gpt-5.5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      envMode: "worktree",
      branch: "synara/workspace-1",
      worktreePath: "/tmp/worktree",
      latestTurn: null,
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      handoff: null,
      session: null,
    } satisfies OrchestrationWorkspaceShellSnapshot["threads"][number];
    const snapshots = [snapshot([workspace()]), { ...snapshot([workspace()]), threads: [thread] }];

    const ready = await waitForWorkspaceConversationSnapshot({
      workspaceId,
      threadId,
      loadSnapshot: async () => snapshots.shift() ?? snapshots.at(-1)!,
      pollIntervalMs: 1,
      timeoutMs: 2,
      sleep: async () => undefined,
    });

    expect(ready.threads).toEqual([thread]);
  });

  it("times out when the projected thread never appears", async () => {
    await expect(
      waitForWorkspaceConversationSnapshot({
        workspaceId,
        threadId,
        loadSnapshot: async () => snapshot([workspace()]),
        pollIntervalMs: 1,
        timeoutMs: 1,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("did not appear in the server read model");
  });
});
