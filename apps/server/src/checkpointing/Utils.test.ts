import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { resolveProjectCwdForKind, resolveThreadWorkspaceCwd } from "./Utils.ts";

describe("resolveProjectCwdForKind", () => {
  it("suppresses the workspace root for a chat-kind project with no materialized worktree", () => {
    expect(
      resolveProjectCwdForKind({
        kind: "chat",
        workspaceRoot: "/tmp/chat-root",
        worktreePath: null,
      }),
    ).toBeNull();
  });

  it("uses the workspace root for a chat-kind project once a worktree is materialized", () => {
    expect(
      resolveProjectCwdForKind({
        kind: "chat",
        workspaceRoot: "/tmp/chat-root",
        worktreePath: "/tmp/chat-worktree",
      }),
    ).toBe("/tmp/chat-root");
  });

  it("treats a studio-kind project's workspace root as a real cwd", () => {
    expect(
      resolveProjectCwdForKind({
        kind: "studio",
        workspaceRoot: "/tmp/studio-root",
        worktreePath: null,
      }),
    ).toBe("/tmp/studio-root");
  });

  it("treats a project-kind project's workspace root as a real cwd", () => {
    expect(
      resolveProjectCwdForKind({
        kind: "project",
        workspaceRoot: "/tmp/project-root",
        worktreePath: null,
      }),
    ).toBe("/tmp/project-root");
  });

  it("defaults to treating the workspace root as real when kind is unknown/absent", () => {
    expect(
      resolveProjectCwdForKind({
        kind: undefined,
        workspaceRoot: "/tmp/unknown-root",
        worktreePath: null,
      }),
    ).toBe("/tmp/unknown-root");
  });
});

describe("resolveThreadWorkspaceCwd", () => {
  const projectId = ProjectId.makeUnsafe("project-1");
  const threadId = ThreadId.makeUnsafe("thread-1");

  it("resolves undefined for a chat-kind thread with no worktree", () => {
    expect(
      resolveThreadWorkspaceCwd({
        thread: { projectId, envMode: "local", worktreePath: null },
        projects: [{ id: projectId, kind: "chat", workspaceRoot: "/tmp/chat-root" }],
      }),
    ).toBeUndefined();
  });

  it("resolves the workspace root for a studio-kind thread with no worktree", () => {
    expect(
      resolveThreadWorkspaceCwd({
        thread: { projectId, envMode: "local", worktreePath: null },
        projects: [{ id: projectId, kind: "studio", workspaceRoot: "/tmp/studio-root" }],
      }),
    ).toBe("/tmp/studio-root");
  });

  it("resolves the materialized worktree path for a studio-kind thread", () => {
    expect(
      resolveThreadWorkspaceCwd({
        thread: { projectId, envMode: "worktree", worktreePath: "/tmp/studio-worktree" },
        projects: [{ id: projectId, kind: "studio", workspaceRoot: "/tmp/studio-root" }],
      }),
    ).toBe("/tmp/studio-worktree");
  });

  it("resolves the materialized worktree path for a chat-kind thread once a worktree exists", () => {
    expect(
      resolveThreadWorkspaceCwd({
        thread: { projectId, envMode: "worktree", worktreePath: "/tmp/chat-worktree" },
        projects: [{ id: projectId, kind: "chat", workspaceRoot: "/tmp/chat-root" }],
      }),
    ).toBe("/tmp/chat-worktree");
  });
});
