// FILE: archiveThreadWorktreeCleanup.test.ts
// Purpose: Characterizes the opt-in worktree release that follows an accepted archive.
// Layer: Web orchestration helper tests

import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppState } from "../storeState";
import { makeProject, makeState, makeThread } from "../storeTestFixtures";
import type { Thread } from "../types";

const harness = vi.hoisted(() => ({
  state: null as unknown,
  toast: vi.fn(),
}));

vi.mock("../store", () => ({
  useStore: { getState: () => harness.state },
}));

vi.mock("../components/ui/toast", () => ({
  toastManager: { add: harness.toast },
}));

import { releaseOrphanedWorktreeAfterArchive } from "./archiveThreadWorktreeCleanup";

const ARCHIVED_ID = ThreadId.makeUnsafe("thread-archived");
const SIBLING_ID = ThreadId.makeUnsafe("thread-sibling");
const WORKTREE_PATH = "/home/user/.synara/worktrees/repo/feature-a";

// Folds single-thread fixture states together: ids concatenate, per-thread maps merge.
function makeStateWithThreads(threads: readonly Thread[]): AppState {
  const [first, ...rest] = threads.map(makeState);
  const state = { ...first } as unknown as Record<string, unknown>;
  for (const next of rest) {
    for (const [key, value] of Object.entries(next)) {
      if (key === "threadIds") {
        state[key] = [...(state[key] as unknown[]), ...(value as unknown[])];
      } else if (/By[A-Za-z]*Id$/u.test(key)) {
        state[key] = { ...(state[key] as object), ...(value as object) };
      }
    }
  }
  return { ...(state as unknown as AppState), projects: [makeProject({ cwd: "/repo" })] };
}

function archivedThread(overrides: Partial<Thread> = {}) {
  return makeThread({
    id: ARCHIVED_ID,
    envMode: "worktree",
    worktreePath: WORKTREE_PATH,
    archivedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  });
}

beforeEach(() => {
  harness.state = makeStateWithThreads([archivedThread()]);
  harness.toast.mockReset();
});

describe("releaseOrphanedWorktreeAfterArchive", () => {
  it("does nothing while the setting is off", async () => {
    const removeWorktree = vi.fn();

    await expect(
      releaseOrphanedWorktreeAfterArchive({
        threadId: ARCHIVED_ID,
        enabled: false,
        removeWorktree,
      }),
    ).resolves.toBe("skipped");

    expect(removeWorktree).not.toHaveBeenCalled();
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it("keeps a worktree another thread still uses", async () => {
    harness.state = makeStateWithThreads([
      archivedThread(),
      makeThread({ id: SIBLING_ID, envMode: "worktree", worktreePath: WORKTREE_PATH }),
    ]);
    const removeWorktree = vi.fn();

    await expect(
      releaseOrphanedWorktreeAfterArchive({ threadId: ARCHIVED_ID, enabled: true, removeWorktree }),
    ).resolves.toBe("skipped");

    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("keeps a worktree a thread that moved back to local still points at", async () => {
    harness.state = makeStateWithThreads([
      archivedThread(),
      makeThread({ id: SIBLING_ID, worktreePath: null, associatedWorktreePath: WORKTREE_PATH }),
    ]);
    const removeWorktree = vi.fn();

    await expect(
      releaseOrphanedWorktreeAfterArchive({ threadId: ARCHIVED_ID, enabled: true, removeWorktree }),
    ).resolves.toBe("skipped");

    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("skips a thread whose turn is still running", async () => {
    harness.state = makeStateWithThreads([
      archivedThread({
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      }),
    ]);
    const removeWorktree = vi.fn();

    await expect(
      releaseOrphanedWorktreeAfterArchive({ threadId: ARCHIVED_ID, enabled: true, removeWorktree }),
    ).resolves.toBe("skipped");

    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("removes an orphaned worktree without forcing it", async () => {
    const removeWorktree = vi.fn().mockResolvedValue(undefined);

    await expect(
      releaseOrphanedWorktreeAfterArchive({ threadId: ARCHIVED_ID, enabled: true, removeWorktree }),
    ).resolves.toBe("removed");

    expect(removeWorktree).toHaveBeenCalledWith({
      cwd: "/repo",
      path: WORKTREE_PATH,
      force: false,
    });
    expect(harness.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Worktree removed",
      description: "feature-a was deleted because no other task uses it.",
    });
  });

  it("reports a refused removal as kept instead of throwing", async () => {
    const removeWorktree = vi.fn().mockRejectedValue(new Error("contains modified files"));
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(
      releaseOrphanedWorktreeAfterArchive({ threadId: ARCHIVED_ID, enabled: true, removeWorktree }),
    ).resolves.toBe("kept");

    expect(harness.toast).toHaveBeenCalledWith({
      type: "info",
      title: "Worktree kept",
      description: "feature-a has uncommitted changes or is still in use.",
    });
    consoleInfo.mockRestore();
  });
});
