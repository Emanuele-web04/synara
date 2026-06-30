import { describe, expect, it } from "vitest";

import {
  isThreadIslandActive,
  selectActiveIslandThread,
  selectIdleIslandThread,
  selectRecentIslandThreads,
  threadActivityTimestamp,
} from "~/lib/islandThreadTracker";
import type { Thread } from "~/types";

function makeThread(overrides: Partial<Omit<Thread, "id">> & { id: string }): Thread {
  return {
    projectId: "p1",
    codexThreadId: null,
    title: "Test",
    modelSelection: { provider: "codex", model: "m1" } as Thread["modelSelection"],
    runtimeMode: "normal" as Thread["runtimeMode"],
    interactionMode: "default" as Thread["interactionMode"],
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-01-01T00:00:00Z",
    activities: [],
    latestTurn: null,
    turnDiffSummaries: [],
    ...overrides,
  } as Thread;
}

function runningSession(): Thread["session"] {
  return {
    status: "running",
    activeTurnId: "turn-1",
  } as Thread["session"];
}

describe("isThreadIslandActive", () => {
  it("returns true for running thread", () => {
    const thread = makeThread({ id: "t1", session: runningSession() });
    expect(isThreadIslandActive(thread)).toBe(true);
  });

  it("returns true for pending approvals", () => {
    const thread = makeThread({ id: "t1", hasPendingApprovals: true });
    expect(isThreadIslandActive(thread)).toBe(true);
  });

  it("returns true for pending user input", () => {
    const thread = makeThread({ id: "t1", hasPendingUserInput: true });
    expect(isThreadIslandActive(thread)).toBe(true);
  });

  it("returns true for actionable proposed plan", () => {
    const thread = makeThread({ id: "t1", hasActionableProposedPlan: true });
    expect(isThreadIslandActive(thread)).toBe(true);
  });

  it("returns false for idle thread with no pending state", () => {
    const thread = makeThread({ id: "t1" });
    expect(isThreadIslandActive(thread)).toBe(false);
  });

  it("returns false for archived thread even if running", () => {
    const thread = makeThread({ id: "t1", session: runningSession(), archivedAt: "2026-01-02" });
    expect(isThreadIslandActive(thread)).toBe(false);
  });

  it("uses === true not truthy for pending flags", () => {
    const thread = makeThread({ id: "t1", hasPendingApprovals: false as unknown as boolean });
    expect(isThreadIslandActive(thread)).toBe(false);
  });
});

describe("threadActivityTimestamp", () => {
  it("uses latestTurn.startedAt when available", () => {
    const thread = makeThread({
      id: "t1",
      latestTurn: { startedAt: "2026-01-02T00:00:00Z" } as Thread["latestTurn"],
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(threadActivityTimestamp(thread)).toBe("2026-01-02T00:00:00Z");
  });

  it("falls back to last activity createdAt", () => {
    const thread = makeThread({
      id: "t1",
      activities: [{ createdAt: "2026-01-03T00:00:00Z" } as Thread["activities"][number]],
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(threadActivityTimestamp(thread)).toBe("2026-01-03T00:00:00Z");
  });

  it("falls back to updatedAt", () => {
    const thread = makeThread({
      id: "t1",
      updatedAt: "2026-01-04T00:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(threadActivityTimestamp(thread)).toBe("2026-01-04T00:00:00Z");
  });

  it("handles null latestTurn.startedAt", () => {
    const thread = makeThread({
      id: "t1",
      latestTurn: { startedAt: null } as Thread["latestTurn"],
      updatedAt: "2026-01-04T00:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(threadActivityTimestamp(thread)).toBe("2026-01-04T00:00:00Z");
  });

  it("returns empty string when all timestamps are null/undefined", () => {
    const thread = {
      ...makeThread({ id: "t1" }),
      latestTurn: null,
      activities: [],
      updatedAt: undefined,
      createdAt: undefined,
    } as unknown as Thread;
    expect(threadActivityTimestamp(thread)).toBe("");
  });

  it("uses createdAt as final fallback", () => {
    const thread = makeThread({
      id: "t1",
      latestTurn: null,
      activities: [],
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(threadActivityTimestamp(thread)).toBe("2026-01-01T00:00:00Z");
  });
});

describe("selectActiveIslandThread", () => {
  it("returns null when no threads are active", () => {
    const threads = [makeThread({ id: "t1" }), makeThread({ id: "t2" })];
    expect(selectActiveIslandThread(threads)).toBeNull();
  });

  it("returns the most recently active running thread", () => {
    const threads = [
      makeThread({ id: "t1", session: runningSession(), createdAt: "2026-01-01T00:00:00Z" }),
      makeThread({ id: "t2", session: runningSession(), createdAt: "2026-01-02T00:00:00Z" }),
    ];
    expect(selectActiveIslandThread(threads)?.id).toBe("t2");
  });

  it("prefers running thread over pending thread with older timestamp", () => {
    const threads = [
      makeThread({ id: "t1", hasPendingApprovals: true, createdAt: "2026-01-01T00:00:00Z" }),
      makeThread({ id: "t2", session: runningSession(), createdAt: "2026-01-02T00:00:00Z" }),
    ];
    expect(selectActiveIslandThread(threads)?.id).toBe("t2");
  });

  it("handles thread deletion by picking next active thread", () => {
    const threads = [
      makeThread({ id: "t1", session: runningSession(), createdAt: "2026-01-01T00:00:00Z" }),
    ];
    expect(selectActiveIslandThread(threads)?.id).toBe("t1");
    // After "deletion" (empty array)
    expect(selectActiveIslandThread([])).toBeNull();
  });

  it("excludes archived threads", () => {
    const threads = [
      makeThread({
        id: "t1",
        session: runningSession(),
        archivedAt: "2026-01-02",
        createdAt: "2026-01-02T00:00:00Z",
      }),
      makeThread({ id: "t2", hasPendingApprovals: true, createdAt: "2026-01-01T00:00:00Z" }),
    ];
    expect(selectActiveIslandThread(threads)?.id).toBe("t2");
  });
});

describe("selectIdleIslandThread", () => {
  it("returns most recently updated thread regardless of running state", () => {
    const threads = [
      makeThread({ id: "t1", createdAt: "2026-01-01T00:00:00Z" }),
      makeThread({ id: "t2", createdAt: "2026-01-02T00:00:00Z" }),
    ];
    expect(selectIdleIslandThread(threads)?.id).toBe("t2");
  });

  it("returns null when all threads are archived", () => {
    const threads = [makeThread({ id: "t1", archivedAt: "2026-01-02" })];
    expect(selectIdleIslandThread(threads)).toBeNull();
  });
});

describe("selectRecentIslandThreads", () => {
  it("returns up to 5 recent threads sorted by recency", () => {
    const threads = [
      makeThread({ id: "t1", createdAt: "2026-01-01T00:00:00Z" }),
      makeThread({ id: "t2", createdAt: "2026-01-03T00:00:00Z" }),
      makeThread({ id: "t3", createdAt: "2026-01-02T00:00:00Z" }),
    ];
    const recent = selectRecentIslandThreads(threads);
    expect(recent.map((t) => t.id)).toEqual(["t2", "t3", "t1"]);
  });

  it("excludes archived threads", () => {
    const threads = [
      makeThread({ id: "t1", createdAt: "2026-01-01T00:00:00Z" }),
      makeThread({ id: "t2", archivedAt: "2026-01-02", createdAt: "2026-01-03T00:00:00Z" }),
    ];
    const recent = selectRecentIslandThreads(threads);
    expect(recent.map((t) => t.id)).toEqual(["t1"]);
  });

  it("respects the limit parameter", () => {
    const threads = Array.from({ length: 7 }, (_, i) =>
      makeThread({ id: `t${i}`, createdAt: `2026-01-0${i + 1}T00:00:00Z` }),
    );
    const recent = selectRecentIslandThreads(threads, 3);
    expect(recent).toHaveLength(3);
    // Most recent first
    expect(recent[0]!.id).toBe("t6");
  });

  it("returns empty array when all threads are archived", () => {
    const threads = [makeThread({ id: "t1", archivedAt: "2026-01-02" })];
    expect(selectRecentIslandThreads(threads)).toEqual([]);
  });
});
