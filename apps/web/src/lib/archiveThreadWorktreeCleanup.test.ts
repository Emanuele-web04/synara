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
const ARCHIVE_SEQUENCE = 42;

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
        archiveSequence: ARCHIVE_SEQUENCE,
        enabled: false,
        removeWorktree,
      }),
    ).resolves.toBe("skipped");

    expect(removeWorktree).not.toHaveBeenCalled();
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it("asks the server to validate a worktree another thread may still use", async () => {
    harness.state = makeStateWithThreads([
      archivedThread(),
      makeThread({ id: SIBLING_ID, envMode: "worktree", worktreePath: WORKTREE_PATH }),
    ]);
    const removeWorktree = vi.fn();

    await expect(
      releaseOrphanedWorktreeAfterArchive({
        threadId: ARCHIVED_ID,
        archiveSequence: ARCHIVE_SEQUENCE,
        enabled: true,
        removeWorktree,
      }),
    ).resolves.toBe("removed");

    expect(removeWorktree).toHaveBeenCalledOnce();
  });

  it("asks the server to validate an associated worktree after moving local", async () => {
    harness.state = makeStateWithThreads([
      archivedThread({ worktreePath: null, associatedWorktreePath: WORKTREE_PATH }),
    ]);
    const removeWorktree = vi.fn();

    await expect(
      releaseOrphanedWorktreeAfterArchive({
        threadId: ARCHIVED_ID,
        archiveSequence: ARCHIVE_SEQUENCE,
        enabled: true,
        removeWorktree,
      }),
    ).resolves.toBe("removed");

    expect(removeWorktree).toHaveBeenCalledWith(expect.objectContaining({ path: WORKTREE_PATH }));
  });

  it("skips a thread that was restored before cleanup", async () => {
    harness.state = makeStateWithThreads([archivedThread({ archivedAt: null })]);
    const removeWorktree = vi.fn();

    await expect(
      releaseOrphanedWorktreeAfterArchive({
        threadId: ARCHIVED_ID,
        archiveSequence: ARCHIVE_SEQUENCE,
        enabled: true,
        removeWorktree,
      }),
    ).resolves.toBe("skipped");

    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("removes an orphaned worktree without forcing it", async () => {
    const removeWorktree = vi.fn().mockResolvedValue(undefined);

    await expect(
      releaseOrphanedWorktreeAfterArchive({
        threadId: ARCHIVED_ID,
        archiveSequence: ARCHIVE_SEQUENCE,
        enabled: true,
        removeWorktree,
      }),
    ).resolves.toBe("removed");

    expect(removeWorktree).toHaveBeenCalledWith({
      cwd: "/repo",
      path: WORKTREE_PATH,
      force: false,
      reclaimTemporaryBranch: false,
      archiveCleanup: { threadId: ARCHIVED_ID, archiveSequence: ARCHIVE_SEQUENCE },
    });
    expect(harness.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Worktree removed",
      description: "feature-a was deleted. Its branch remains available for recovery.",
    });
  });

  it("reports a refused removal as kept instead of throwing", async () => {
    const removeWorktree = vi.fn().mockRejectedValue(new Error("contains modified files"));
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(
      releaseOrphanedWorktreeAfterArchive({
        threadId: ARCHIVED_ID,
        archiveSequence: ARCHIVE_SEQUENCE,
        enabled: true,
        removeWorktree,
      }),
    ).resolves.toBe("kept");

    expect(harness.toast).toHaveBeenCalledWith({
      type: "info",
      title: "Worktree kept",
      description:
        "feature-a could not be removed safely. Check its task, Git status, or connection.",
    });
    consoleInfo.mockRestore();
  });
});
