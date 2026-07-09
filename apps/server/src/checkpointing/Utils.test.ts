import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  checkpointRefForThreadTurn,
  checkpointRefForThreadTurnInManagedFamily,
  checkpointRefForThreadTurnStartInManagedFamily,
  isManagedCheckpointRefForThread,
  parseManagedCheckpointRef,
  resolveProjectCwdForKind,
  resolveThreadWorkspaceCwd,
} from "./Utils.ts";

describe("managed checkpoint refs", () => {
  const threadId = ThreadId.makeUnsafe("thread-1");

  it("creates canonical Synara refs", () => {
    expect(checkpointRefForThreadTurn(threadId, 4)).toMatch(/^refs\/synara\/checkpoints\//);
  });

  it("recognizes a structurally valid persisted ref for the same thread", () => {
    const canonical = checkpointRefForThreadTurn(threadId, 4);
    const historical = canonical.replace("refs/synara/", "refs/historical/");
    expect(parseManagedCheckpointRef(historical)?.namespace).toBe("historical");
    expect(isManagedCheckpointRefForThread(historical, threadId)).toBe(true);
  });

  it("rejects malformed refs and refs belonging to a different thread", () => {
    expect(parseManagedCheckpointRef("refs/heads/feature")).toBeNull();
    expect(
      isManagedCheckpointRefForThread(
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-2"), 4),
        threadId,
      ),
    ).toBe(false);
  });

  it("reconstructs turn and turn-start refs in an existing managed family", () => {
    const historical = checkpointRefForThreadTurn(threadId, 4).replace(
      "refs/synara/",
      "refs/historical/",
    );

    expect(checkpointRefForThreadTurnInManagedFamily(historical, threadId, 0)).toBe(
      historical.replace(/\/turn\/4$/, "/turn/0"),
    );
    expect(
      checkpointRefForThreadTurnStartInManagedFamily(
        historical,
        threadId,
        TurnId.makeUnsafe("turn-1"),
      ),
    ).toMatch(/^refs\/historical\/checkpoints\/.+\/turn-start\//);
  });
});

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

  it("resolves the materialized worktree path for a chat-kind thread once a worktree exists", () => {
    expect(
      resolveThreadWorkspaceCwd({
        thread: { projectId, envMode: "worktree", worktreePath: "/tmp/chat-worktree" },
        projects: [{ id: projectId, kind: "chat", workspaceRoot: "/tmp/chat-root" }],
      }),
    ).toBe("/tmp/chat-worktree");
  });
});
