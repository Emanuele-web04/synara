import { describe, expect, it } from "vitest";

import {
  isPendingThreadWorktree,
  resolveThreadBranchSourceCwd,
  resolveThreadEnvironmentMode,
  resolveThreadWorkspaceCwds,
  resolveThreadWorkspaceCwd,
  resolveThreadWorkspaceState,
} from "./threadEnvironment";

describe("resolveThreadEnvironmentMode", () => {
  it("treats a materialized worktree path as authoritative", () => {
    expect(
      resolveThreadEnvironmentMode({
        envMode: "local",
        worktreePath: "/repo/.worktrees/feature-a",
      }),
    ).toBe("worktree");
  });

  it("falls back to worktreePath when envMode is missing", () => {
    expect(resolveThreadEnvironmentMode({ worktreePath: "/repo/.worktrees/feature-a" })).toBe(
      "worktree",
    );
    expect(resolveThreadEnvironmentMode({ worktreePath: null })).toBe("local");
  });
});

describe("resolveThreadWorkspaceState", () => {
  it("detects pending worktree threads before the path is materialized", () => {
    expect(resolveThreadWorkspaceState({ envMode: "worktree", worktreePath: null })).toBe(
      "worktree-pending",
    );
  });

  it("detects ready worktree threads once the path exists", () => {
    expect(
      resolveThreadWorkspaceState({
        envMode: "worktree",
        worktreePath: "/repo/.worktrees/feature-a",
      }),
    ).toBe("worktree-ready");
  });
});

describe("resolveThreadWorkspaceCwd", () => {
  it("uses the project root for local threads", () => {
    expect(
      resolveThreadWorkspaceCwd({
        projectCwd: "/repo",
        envMode: "local",
        worktreePath: null,
      }),
    ).toBe("/repo");
  });

  it("returns null for pending worktree threads", () => {
    expect(
      resolveThreadWorkspaceCwd({
        projectCwd: "/repo",
        envMode: "worktree",
        worktreePath: null,
      }),
    ).toBeNull();
    expect(isPendingThreadWorktree({ envMode: "worktree", worktreePath: null })).toBe(true);
  });

  it("uses the materialized worktree path for active worktree threads", () => {
    expect(
      resolveThreadWorkspaceCwd({
        projectCwd: "/repo",
        envMode: "worktree",
        worktreePath: "/repo/.worktrees/feature-a",
      }),
    ).toBe("/repo/.worktrees/feature-a");
  });
});

describe("resolveThreadBranchSourceCwd", () => {
  it("falls back to the project root before worktree creation", () => {
    expect(
      resolveThreadBranchSourceCwd({
        projectCwd: "/repo",
        worktreePath: null,
      }),
    ).toBe("/repo");
  });
});

describe("resolveThreadWorkspaceCwds", () => {
  it("marks the active workspace context as primary and resolves every cwd", () => {
    const contexts = resolveThreadWorkspaceCwds({
      projectId: "project-a" as never,
      envMode: "local",
      branch: null,
      worktreePath: null,
      activeWorkspaceContextId: "project-b",
      workspaceContexts: [
        {
          id: "primary",
          projectId: "project-a" as never,
          label: "Repo A",
          role: "context",
          accessMode: "read-write",
          cwd: null,
          envMode: "local",
          branch: null,
          worktreePath: null,
        },
        {
          id: "project-b",
          projectId: "project-b" as never,
          label: "Repo B",
          role: "primary",
          accessMode: "read-write",
          cwd: null,
          envMode: "worktree",
          branch: "feature",
          worktreePath: "/repo-b/.worktrees/feature",
        },
      ],
      projects: [
        { id: "project-a" as never, workspaceRoot: "/repo-a", kind: "project" },
        { id: "project-b" as never, workspaceRoot: "/repo-b", kind: "project" },
      ],
    });

    expect(contexts.map((entry) => [entry.context.id, entry.cwd, entry.primary])).toEqual([
      ["primary", "/repo-a", false],
      ["project-b", "/repo-b/.worktrees/feature", true],
    ]);
  });
});
