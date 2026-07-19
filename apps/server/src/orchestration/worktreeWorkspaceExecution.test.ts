import { ProjectId, WorktreeWorkspaceId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { resolveWorkspaceExecutionCwd } from "./worktreeWorkspaceExecution";

const project = {
  id: ProjectId.makeUnsafe("project-resolver"),
  kind: "project" as const,
  title: "Resolver",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  scripts: [],
  isPinned: false,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
};

describe("resolveWorkspaceExecutionCwd", () => {
  it("uses the workspace path instead of conversation compatibility fields", () => {
    expect(
      resolveWorkspaceExecutionCwd({
        thread: {
          projectId: project.id,
          workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-resolver"),
          envMode: "worktree",
          worktreePath: "/stale-thread-path",
        },
        project,
        workspace: {
          id: WorktreeWorkspaceId.makeUnsafe("workspace-resolver"),
          projectId: project.id,
          repositoryIdentity: "/repo",
          kind: "managed",
          state: "ready",
          title: "Resolver",
          path: "/canonical-worktree",
          branch: "synara/resolver",
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
          createdAt: "2026-07-13T00:00:00.000Z",
          updatedAt: "2026-07-13T00:00:00.000Z",
          archivedAt: null,
          deletedAt: null,
        },
      }),
    ).toBe("/canonical-worktree");
  });

  it("blocks execution until an attached workspace is ready", () => {
    expect(
      resolveWorkspaceExecutionCwd({
        thread: {
          projectId: project.id,
          workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-pending"),
          envMode: "worktree",
          worktreePath: null,
        },
        project,
        workspace: undefined,
      }),
    ).toBeUndefined();
  });
});
