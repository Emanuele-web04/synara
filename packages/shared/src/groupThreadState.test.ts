import { describe, expect, it } from "vitest";

import {
  canSessionAnswerPendingRequests,
  groupThreadNeedsAttention,
  groupThreadStateLabel,
  isLatestTurnSettled,
  isThreadActivelyWorking,
  resolveGroupCoordinatorStatus,
  resolveGroupThreadState,
  type GroupThreadStateThread,
} from "./groupThreadState";

const baseInput = (thread: GroupThreadStateThread) => ({
  thread,
  task: null,
  indexArchived: false,
  pullRequest: null,
});

describe("resolveGroupThreadState", () => {
  it("buckets an empty thread as idle", () => {
    expect(resolveGroupThreadState(baseInput({}))).toBe("idle");
  });

  it("resolves archived threads even when pending flags are stale", () => {
    expect(
      resolveGroupThreadState(
        baseInput({ archivedAt: "2026-01-01T00:00:00.000Z", hasPendingApprovals: true }),
      ),
    ).toBe("resolved");
    expect(resolveGroupThreadState({ ...baseInput({}), indexArchived: true })).toBe("resolved");
  });

  it("resolves done or cancelled tasks", () => {
    expect(resolveGroupThreadState({ ...baseInput({}), task: { status: "done" } })).toBe(
      "resolved",
    );
    expect(
      resolveGroupThreadState({
        ...baseInput({}),
        task: { status: "cancelled", archivedAt: null },
      }),
    ).toBe("resolved");
  });

  it("waits on pending approvals and user input while the session can answer", () => {
    expect(
      resolveGroupThreadState(
        baseInput({
          session: { status: "ready" },
          hasPendingApprovals: true,
        }),
      ),
    ).toBe("waiting");
    expect(
      resolveGroupThreadState(
        baseInput({
          session: { status: "ready" },
          hasPendingUserInput: true,
        }),
      ),
    ).toBe("waiting");
  });

  it("does not wait on pending flags once the session can no longer answer", () => {
    expect(
      resolveGroupThreadState(
        baseInput({
          session: { status: "stopped" },
          hasPendingApprovals: true,
        }),
      ),
    ).toBe("idle");
  });

  it("waits on a failed session or settled error turn", () => {
    expect(resolveGroupThreadState(baseInput({ session: { status: "error" } }))).toBe("waiting");
    expect(
      resolveGroupThreadState(
        baseInput({
          session: { status: "ready" },
          latestTurn: {
            state: "error",
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:01:00.000Z",
          },
        }),
      ),
    ).toBe("waiting");
  });

  it("marks a running session with live work as working", () => {
    expect(
      resolveGroupThreadState(
        baseInput({
          session: { status: "running" },
          latestTurn: { state: "running", startedAt: "2026-01-01T00:00:00.000Z" },
        }),
      ),
    ).toBe("working");
    expect(resolveGroupThreadState(baseInput({ session: { status: "connecting" } }))).toBe(
      "working",
    );
    expect(resolveGroupThreadState(baseInput({ hasLiveTailWork: true }))).toBe("working");
  });

  it("puts an open non-draft PR in review once the thread is not working", () => {
    expect(
      resolveGroupThreadState({
        ...baseInput({ session: { status: "ready" } }),
        pullRequest: { state: "open", isDraft: false },
      }),
    ).toBe("review");
    expect(
      resolveGroupThreadState({
        ...baseInput({ session: { status: "ready" } }),
        pullRequest: { state: "open", isDraft: true },
      }),
    ).toBe("idle");
  });

  it("resolves merged or closed pull requests", () => {
    expect(
      resolveGroupThreadState({
        ...baseInput({ session: { status: "ready" } }),
        pullRequest: { state: "merged" },
      }),
    ).toBe("resolved");
  });
});

describe("resolveGroupCoordinatorStatus", () => {
  const coordinatorStatus = (input: {
    configured?: boolean;
    goalStatus?: string | null;
    thread?: GroupThreadStateThread | null;
  }) =>
    resolveGroupCoordinatorStatus({
      configured: input.configured ?? true,
      goalStatus: input.goalStatus ?? null,
      thread: input.thread ?? null,
    });

  it("reports unconfigured before the group has a coordinator", () => {
    expect(coordinatorStatus({ configured: false })).toBe("unconfigured");
  });

  it("lets goal pause and stop win over live thread state", () => {
    const liveThread: GroupThreadStateThread = {
      session: { status: "running" },
      latestTurn: { state: "running", startedAt: "2026-01-01T00:00:00.000Z" },
    };
    expect(coordinatorStatus({ goalStatus: "paused", thread: liveThread })).toBe("paused");
    expect(coordinatorStatus({ goalStatus: "stopped", thread: liveThread })).toBe("stopped");
  });

  it("reports running while a coordinator turn is in flight", () => {
    expect(
      coordinatorStatus({
        goalStatus: null,
        thread: {
          session: { status: "running" },
          latestTurn: { state: "running", startedAt: "2026-01-01T00:00:00.000Z" },
        },
      }),
    ).toBe("running");
    expect(
      coordinatorStatus({
        goalStatus: "draft",
        thread: { session: { status: "starting" } },
      }),
    ).toBe("running");
  });

  it("counts a pending approval or user-input request as running", () => {
    expect(
      coordinatorStatus({
        thread: { session: { status: "ready" }, hasPendingApprovals: true },
      }),
    ).toBe("running");
    expect(
      coordinatorStatus({
        thread: { session: { status: "ready" }, hasPendingUserInput: true },
      }),
    ).toBe("running");
  });

  it("keeps the established goal-driven mappings", () => {
    expect(coordinatorStatus({ goalStatus: "active", thread: null })).toBe("running");
    expect(coordinatorStatus({ goalStatus: "draft", thread: null })).toBe("idle");
    expect(coordinatorStatus({ goalStatus: null, thread: null })).toBe("idle");
  });

  it("stays idle for a stopped session and an archived thread", () => {
    expect(
      coordinatorStatus({
        thread: {
          session: { status: "stopped" },
          hasPendingApprovals: true,
        },
      }),
    ).toBe("idle");
    expect(
      coordinatorStatus({
        thread: { archivedAt: "2026-01-01T00:00:00.000Z", session: { status: "running" } },
      }),
    ).toBe("idle");
  });
});

describe("session helpers", () => {
  it("lets a missing session answer pending requests", () => {
    expect(canSessionAnswerPendingRequests(null)).toBe(true);
    expect(canSessionAnswerPendingRequests({ status: "closed" })).toBe(false);
    expect(canSessionAnswerPendingRequests({ status: "ready" })).toBe(true);
    expect(
      canSessionAnswerPendingRequests({ status: "ready", orchestrationStatus: "stopped" }),
    ).toBe(false);
  });

  it("settles only completed turns unless the session still runs", () => {
    const turn = {
      state: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
    };
    expect(isLatestTurnSettled(turn, null)).toBe(true);
    expect(isLatestTurnSettled(turn, { status: "running" })).toBe(false);
    expect(
      isLatestTurnSettled({ state: "running", startedAt: "2026-01-01T00:00:00.000Z" }, null),
    ).toBe(false);
  });

  it("labels every state", () => {
    expect(groupThreadStateLabel("waiting")).toBe("Waiting on you");
    expect(groupThreadStateLabel("landing")).toBe("Landing");
    expect(groupThreadStateLabel("resolved")).toBe("Resolved");
  });

  it("masks attention on archived and dead-session threads", () => {
    expect(
      groupThreadNeedsAttention({
        archivedAt: "2026-01-01T00:00:00.000Z",
        hasPendingApprovals: true,
      }),
    ).toBe(false);
    expect(
      groupThreadNeedsAttention({
        session: { status: "error" },
      }),
    ).toBe(true);
    expect(isThreadActivelyWorking({ session: { status: "ready" } })).toBe(false);
  });
});
