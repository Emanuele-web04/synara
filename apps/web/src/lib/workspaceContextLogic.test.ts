import { describe, expect, it } from "vitest";

import { patchThreadWorkspaceContext, updateThreadWorkspaceContext } from "./workspaceContextLogic";

describe("workspaceContextLogic", () => {
  const baseContext = {
    id: "project:repo-b",
    projectId: "repo-b" as const,
    label: "Other Repo",
    role: "context" as const,
    accessMode: "read-write" as const,
    cwd: "/repos/other",
    envMode: "local" as const,
    branch: "main",
    worktreePath: null,
  };

  it("updates branch and cwd for local context", () => {
    const next = patchThreadWorkspaceContext(baseContext, "/repos/other", {
      branch: "feature/x",
    });
    expect(next.branch).toBe("feature/x");
    expect(next.cwd).toBe("/repos/other");
    expect(next.envMode).toBe("local");
  });

  it("updates worktree path and env mode together", () => {
    const next = patchThreadWorkspaceContext(baseContext, "/repos/other", {
      envMode: "worktree",
      branch: "synara/abc",
      worktreePath: "/repos/other/.worktrees/abc",
    });
    expect(next.envMode).toBe("worktree");
    expect(next.cwd).toBe("/repos/other/.worktrees/abc");
  });

  it("patches only the targeted context in an array", () => {
    const primary = { ...baseContext, id: "primary", role: "primary" as const };
    const next = updateThreadWorkspaceContext([primary, baseContext], baseContext.id, "/repos/other", {
      branch: "develop",
    });
    expect(next[0]?.branch).toBe("main");
    expect(next[1]?.branch).toBe("develop");
  });
});
