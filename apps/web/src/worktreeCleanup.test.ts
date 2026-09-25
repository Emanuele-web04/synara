import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import {
  formatWorktreePathForDisplay,
  getOrphanedWorktreePathForThread,
  isThreadAssociatedWithWorktree,
} from "./worktreeCleanup";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

describe("getOrphanedWorktreePathForThread", () => {
  it("returns null when the target thread does not exist", () => {
    const result = getOrphanedWorktreePathForThread([], ThreadId.makeUnsafe("missing-thread"));
    expect(result).toBeNull();
  });

  it("returns null when the target thread has no worktree", () => {
    const threads = [makeThread()];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.makeUnsafe("thread-1"));
    expect(result).toBeNull();
  });

  it("returns the path when no other thread links to that worktree", () => {
    const threads = [makeThread({ worktreePath: "/tmp/repo/worktrees/feature-a" })];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.makeUnsafe("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });

  it("returns null when another thread links to the same worktree", () => {
    const threads = [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.makeUnsafe("thread-1"));
    expect(result).toBeNull();
  });

  it("ignores threads linked to different worktrees", () => {
    const threads = [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-b",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.makeUnsafe("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });
});

describe("formatWorktreePathForDisplay", () => {
  it("shows only the last path segment for unix-like paths", () => {
    const result = formatWorktreePathForDisplay(
      "/Users/julius/.synara/worktrees/synara-mvp/synara-4e609bb8",
    );
    expect(result).toBe("synara-4e609bb8");
  });

  it("normalizes windows separators before selecting the final segment", () => {
    const result = formatWorktreePathForDisplay(
      "C:\\Users\\julius\\.synara\\worktrees\\synara-mvp\\synara-4e609bb8",
    );
    expect(result).toBe("synara-4e609bb8");
  });

  it("ignores trailing slashes", () => {
    const result = formatWorktreePathForDisplay("/tmp/custom-worktrees/my-worktree/");
    expect(result).toBe("my-worktree");
  });
});

describe("isThreadAssociatedWithWorktree", () => {
  const worktreePath = "/tmp/repo/worktrees/feature-a";

  it("matches the current worktree path", () => {
    expect(isThreadAssociatedWithWorktree({ worktreePath }, worktreePath)).toBe(true);
  });

  it("matches the associated worktree path when the thread moved back to local", () => {
    expect(
      isThreadAssociatedWithWorktree(
        { worktreePath: null, associatedWorktreePath: worktreePath },
        worktreePath,
      ),
    ).toBe(true);
  });

  it("ignores surrounding whitespace in recorded paths", () => {
    expect(
      isThreadAssociatedWithWorktree({ worktreePath: `  ${worktreePath}\n` }, worktreePath),
    ).toBe(true);
  });

  it("does not match missing, blank, or different paths", () => {
    expect(isThreadAssociatedWithWorktree({}, worktreePath)).toBe(false);
    expect(
      isThreadAssociatedWithWorktree(
        { worktreePath: "   ", associatedWorktreePath: undefined },
        worktreePath,
      ),
    ).toBe(false);
    expect(
      isThreadAssociatedWithWorktree(
        { worktreePath: "/tmp/repo/worktrees/feature-b" },
        worktreePath,
      ),
    ).toBe(false);
  });
});
