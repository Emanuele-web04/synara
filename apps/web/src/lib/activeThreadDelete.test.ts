// FILE: activeThreadDelete.test.ts
// Purpose: Characterizes shared active-thread deletion ordering and failure boundaries.
// Layer: Web orchestration helper tests

import { ProjectId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  events: [] as string[],
  dispatchCommand: vi.fn(),
  confirm: vi.fn(),
  disposeThread: vi.fn(),
  reconcile: vi.fn(),
  removeDeletedThreadFromClientState: vi.fn(),
  orphanedWorktreePath: null as string | null,
  threads: [] as Array<{ id: ThreadId; projectId: ProjectId; session: { status: string } | null }>,
  orphanResolver: vi.fn(),
  toast: vi.fn(),
}));

const THREAD_ID = ThreadId.makeUnsafe("thread-delete");
const PROJECT_ID = ProjectId.makeUnsafe("project-delete");
const THREAD = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  session: { status: "running" },
};

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    dialogs: { confirm: harness.confirm },
    orchestration: { dispatchCommand: harness.dispatchCommand },
  }),
}));

vi.mock("../store", () => ({
  useStore: {
    getState: () => ({
      projects: [{ id: PROJECT_ID, cwd: "/repo" }],
      removeDeletedThreadFromClientState: harness.removeDeletedThreadFromClientState,
    }),
  },
}));

vi.mock("../threadDerivation", () => ({
  getThreadFromState: () => THREAD,
  getThreadsFromState: () => harness.threads,
}));

vi.mock("../worktreeCleanup", () => ({
  formatWorktreePathForDisplay: (path: string) => path,
  getOrphanedWorktreePathForThread: harness.orphanResolver,
}));

vi.mock("../components/terminal/terminalRuntimeRegistry", () => ({
  terminalRuntimeRegistry: { disposeThread: harness.disposeThread },
}));

vi.mock("./deletedThreadClientReconciliation", () => ({
  reconcileDeletedThreadFromClient: harness.reconcile,
}));

vi.mock("../components/ui/toast", () => ({
  toastManager: { add: harness.toast },
}));

import { deleteActiveThreadFromClient } from "./activeThreadDelete";

beforeEach(() => {
  harness.events.length = 0;
  harness.orphanedWorktreePath = null;
  harness.threads = [THREAD];
  harness.orphanResolver.mockReset().mockImplementation(() => harness.orphanedWorktreePath);
  harness.confirm.mockReset().mockResolvedValue(false);
  harness.dispatchCommand.mockReset().mockImplementation(async (command: { type: string }) => {
    harness.events.push(command.type);
  });
  harness.disposeThread.mockReset().mockImplementation(() => {
    harness.events.push("terminal.dispose");
  });
  harness.reconcile.mockReset().mockImplementation(() => {
    harness.events.push("reconcile");
  });
  harness.toast.mockReset();
});

describe("deleteActiveThreadFromClient", () => {
  it("lets the server own runtime cleanup and disposes the renderer after delete acceptance", async () => {
    const onDeleted = vi.fn(() => {
      harness.events.push("onDeleted");
    });

    await deleteActiveThreadFromClient({
      threadId: THREAD_ID,
      prepareForDelete: () => {
        harness.events.push("prepare");
        return "prepared";
      },
      onDeleted,
      removeWorktree: vi.fn(),
    });

    expect(harness.events).toEqual([
      "prepare",
      "thread.delete",
      "terminal.dispose",
      "reconcile",
      "onDeleted",
    ]);
    expect(onDeleted).toHaveBeenCalledWith({ thread: THREAD, prepared: "prepared" });
  });

  it("leaves client state untouched when the server rejects deletion", async () => {
    harness.dispatchCommand.mockImplementation(async (command: { type: string }) => {
      harness.events.push(command.type);
      if (command.type === "thread.delete") throw new Error("delete rejected");
    });
    const onDeleted = vi.fn();

    await expect(
      deleteActiveThreadFromClient({
        threadId: THREAD_ID,
        onDeleted,
        removeWorktree: vi.fn(),
      }),
    ).rejects.toThrow("delete rejected");

    expect(harness.reconcile).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("reports worktree cleanup failure without rolling back the accepted delete", async () => {
    harness.orphanedWorktreePath = "/repo-worktree";
    harness.confirm.mockResolvedValue(true);
    const onDeleted = vi.fn();
    const removeWorktree = vi.fn().mockRejectedValue(new Error("busy"));

    await deleteActiveThreadFromClient({
      threadId: THREAD_ID,
      onDeleted,
      removeWorktree,
    });

    expect(onDeleted).toHaveBeenCalledOnce();
    expect(removeWorktree).toHaveBeenCalledWith({
      cwd: "/repo",
      path: "/repo-worktree",
      force: true,
    });
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Thread deleted, but worktree removal failed",
        description: "Could not remove /repo-worktree. busy",
      }),
    );
  });

  it("excludes every planned batch deletion and skips worktree prompting when requested", async () => {
    const otherThreadId = ThreadId.makeUnsafe("thread-delete-other");
    harness.threads = [THREAD, { id: otherThreadId, projectId: PROJECT_ID, session: null }];
    harness.orphanedWorktreePath = "/repo-worktree";
    const removeWorktree = vi.fn();

    await deleteActiveThreadFromClient({
      threadId: THREAD_ID,
      deletedThreadIds: new Set([THREAD_ID, otherThreadId]),
      worktreeCleanupMode: "skip",
      onDeleted: vi.fn(),
      removeWorktree,
    });

    expect(harness.orphanResolver).toHaveBeenCalledWith([THREAD], THREAD_ID);
    expect(harness.confirm).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });
});
