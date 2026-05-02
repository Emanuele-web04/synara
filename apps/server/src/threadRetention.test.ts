// FILE: threadRetention.test.ts
// Purpose: Verifies inactive-thread retention selection without running the server loop.
// Layer: Server maintenance tests
// Exports: Vitest coverage for threadRetention helpers.

import { describe, expect, it } from "vitest";
import { ProjectId, ThreadId, type OrchestrationReadModel } from "@t3tools/contracts";

import { getInactiveThreadIdsForRetention, THREAD_RETENTION_UNUSED_MS } from "./threadRetention";

function makeReadModelThread(
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel["threads"][number] {
  return {
    id: ThreadId.makeUnsafe("thread-active"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    latestUserMessageAt: null,
    deletedAt: null,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestTurn: null,
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    ...overrides,
  } as OrchestrationReadModel["threads"][number];
}

function makeReadModel(threads: OrchestrationReadModel["threads"]): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads,
    updatedAt: "2026-04-20T00:00:00.000Z",
  };
}

describe("thread retention", () => {
  it("selects inactive threads older than the seven-day retention window", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const staleThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-stale"),
      latestUserMessageAt: new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString(),
    });
    const recentThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-recent"),
      latestUserMessageAt: new Date(nowMs - THREAD_RETENTION_UNUSED_MS + 1).toISOString(),
    });

    expect(
      getInactiveThreadIdsForRetention(makeReadModel([staleThread, recentThread]), nowMs),
    ).toEqual([staleThread.id]);
  });

  it("does not select busy or pending threads even when they are old", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const oldActivityAt = new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString();

    expect(
      getInactiveThreadIdsForRetention(
        makeReadModel([
          makeReadModelThread({
            id: ThreadId.makeUnsafe("thread-running"),
            latestUserMessageAt: oldActivityAt,
            session: {
              threadId: ThreadId.makeUnsafe("thread-running"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: oldActivityAt,
            },
          }),
          makeReadModelThread({
            id: ThreadId.makeUnsafe("thread-pending"),
            latestUserMessageAt: oldActivityAt,
            hasPendingUserInput: true,
          }),
        ]),
        nowMs,
      ),
    ).toEqual([]);
  });
});
