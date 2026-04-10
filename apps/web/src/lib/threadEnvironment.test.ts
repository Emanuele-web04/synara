import { describe, expect, it } from "vitest";
import { resolveForkThreadEnvironment } from "./threadEnvironment";

describe("threadEnvironment", () => {
  it("keeps a worktree fork into local on the same worktree", () => {
    expect(
      resolveForkThreadEnvironment({
        target: "local",
        activeRootBranch: "main",
        sourceThread: {
          branch: "feature/worktree-branch",
          envMode: "worktree",
          worktreePath: "/repo/.worktrees/feature-worktree-branch",
        },
      }),
    ).toEqual({
      target: "local",
      envMode: "worktree",
      branch: "feature/worktree-branch",
      worktreePath: "/repo/.worktrees/feature-worktree-branch",
      associatedWorktreePath: "/repo/.worktrees/feature-worktree-branch",
      associatedWorktreeBranch: "feature/worktree-branch",
      associatedWorktreeRef: "feature/worktree-branch",
    });
  });

  it("keeps a local fork into local on the root checkout", () => {
    expect(
      resolveForkThreadEnvironment({
        target: "local",
        activeRootBranch: "main",
        sourceThread: {
          branch: "feature/local-branch",
          envMode: "local",
          worktreePath: null,
        },
      }),
    ).toEqual({
      target: "local",
      envMode: "local",
      branch: "feature/local-branch",
      worktreePath: null,
      associatedWorktreePath: null,
      associatedWorktreeBranch: null,
      associatedWorktreeRef: null,
    });
  });

  it("plans a new worktree fork without reusing the source path", () => {
    expect(
      resolveForkThreadEnvironment({
        target: "worktree",
        activeRootBranch: "main",
        sourceThread: {
          branch: "feature/source-branch",
          envMode: "worktree",
          worktreePath: "/repo/.worktrees/source-branch",
        },
      }),
    ).toEqual({
      target: "worktree",
      envMode: "worktree",
      branch: "feature/source-branch",
      worktreePath: null,
      associatedWorktreePath: null,
      associatedWorktreeBranch: "feature/source-branch",
      associatedWorktreeRef: "feature/source-branch",
    });
  });
});
