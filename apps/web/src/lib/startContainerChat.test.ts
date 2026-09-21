import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  startContainerChat,
  startFreshChatForActiveSurface,
  type StartContainerChatResult,
} from "./startContainerChat";

const paths = {
  homeDir: "/Users/tester",
  chatWorkspaceRoot: "/Users/tester/Documents/Synara/Chats",
  studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
  groupsWorkspaceRoot: "/Users/tester/Documents/Synara/Groups",
};

function successfulHandler() {
  return vi.fn(async (): Promise<StartContainerChatResult> => ({ ok: true, threadId: null }));
}

describe("startFreshChatForActiveSurface", () => {
  it("keeps the global New chat action in a group container", async () => {
    const handleNewChat = successfulHandler();
    const handleNewGroupChat = successfulHandler();

    await startFreshChatForActiveSurface({
      activeProject: {
        kind: "group",
        cwd: "/Users/tester/Documents/Synara/Groups/Team A",
      },
      isGroupsRoute: false,
      paths,
      handleNewChat,
      handleNewGroupChat,
    });

    expect(handleNewGroupChat).toHaveBeenCalledOnce();
    expect(handleNewGroupChat).toHaveBeenCalledWith({ fresh: true });
    expect(handleNewChat).not.toHaveBeenCalled();
  });

  it("keeps the global New chat action in the legacy Studio container", async () => {
    const handleNewChat = successfulHandler();
    const handleNewGroupChat = successfulHandler();

    await startFreshChatForActiveSurface({
      activeProject: {
        kind: "studio",
        cwd: "/Users/tester/Documents/Synara/Studio",
      },
      isGroupsRoute: false,
      paths,
      handleNewChat,
      handleNewGroupChat,
    });

    expect(handleNewGroupChat).toHaveBeenCalledOnce();
    expect(handleNewGroupChat).toHaveBeenCalledWith({ fresh: true });
    expect(handleNewChat).not.toHaveBeenCalled();
  });

  it("keeps the global New chat action on the Groups landing route", async () => {
    const handleNewChat = successfulHandler();
    const handleNewGroupChat = successfulHandler();

    await startFreshChatForActiveSurface({
      activeProject: null,
      isGroupsRoute: true,
      paths,
      handleNewChat,
      handleNewGroupChat,
    });

    expect(handleNewGroupChat).toHaveBeenCalledOnce();
    expect(handleNewChat).not.toHaveBeenCalled();
  });

  it("keeps the global New chat action in Projects for ordinary or missing projects", async () => {
    for (const activeProject of [
      { kind: "project" as const, cwd: "/Users/tester/Developer/app" },
      null,
    ]) {
      const handleNewChat = successfulHandler();
      const handleNewGroupChat = successfulHandler();

      await startFreshChatForActiveSurface({
        activeProject,
        isGroupsRoute: false,
        paths,
        handleNewChat,
        handleNewGroupChat,
      });

      expect(handleNewChat).toHaveBeenCalledOnce();
      // Home chat reuses the stored draft thread when one exists (so an in-progress
      // draft survives switching threads) instead of forcing a fresh thread.
      expect(handleNewChat).toHaveBeenCalledWith();
      expect(handleNewGroupChat).not.toHaveBeenCalled();
    }
  });
});

describe("startContainerChat", () => {
  it("returns the created thread so callers can attach context deterministically", async () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const handleNewThread = vi.fn(async () => threadId);

    await expect(
      startContainerChat({
        ensureProjectId: async () => projectId,
        handleNewThread,
        fresh: true,
        errorLabel: "failed",
      }),
    ).resolves.toEqual({ ok: true, threadId });

    expect(handleNewThread).toHaveBeenCalledWith(projectId, {
      fresh: true,
      envMode: "local",
      branch: null,
      worktreePath: null,
    });
  });

  it("clears a stored group draft's inherited worktree metadata without overriding its cwd", async () => {
    const projectId = ProjectId.makeUnsafe("group-project");
    const threadId = ThreadId.makeUnsafe("group-thread");
    const handleNewThread = vi.fn(async () => threadId);

    await startContainerChat({
      ensureProjectId: async () => projectId,
      handleNewThread,
      forceLocalWorkspace: true,
      errorLabel: "failed",
    });

    expect(handleNewThread).toHaveBeenCalledWith(projectId, {
      envMode: "local",
      branch: null,
      worktreePath: null,
    });
  });

  it("applies container thread defaults (e.g. a group's worker routing) to the new chat", async () => {
    const projectId = ProjectId.makeUnsafe("group-project");
    const threadId = ThreadId.makeUnsafe("group-thread");
    const handleNewThread = vi.fn(async () => threadId);
    const applyThreadDefaults = vi.fn(async () => {});

    await expect(
      startContainerChat({
        ensureProjectId: async () => projectId,
        handleNewThread,
        forceLocalWorkspace: true,
        applyThreadDefaults,
        errorLabel: "failed",
      }),
    ).resolves.toEqual({ ok: true, threadId });

    expect(applyThreadDefaults).toHaveBeenCalledWith(threadId);
  });
});
