import { EventId, TurnId, type OrchestrationThreadActivity } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  NATIVE_ISLAND_MAX_SESSIONS,
  NATIVE_ISLAND_TEXT_LIMITS,
  projectNativeIslandViewModel,
} from "~/components/dynamicIsland/islandViewModel";
import type { Thread } from "~/types";

const NOW_MS = Date.parse("2026-07-22T12:01:00.000Z");

function makeActivity(
  overrides: Partial<OrchestrationThreadActivity> & Pick<OrchestrationThreadActivity, "kind">,
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(`activity-${overrides.kind}`),
    tone: "tool",
    summary: "Working",
    payload: {},
    turnId: null,
    createdAt: "2026-07-22T12:00:10.000Z",
    ...overrides,
  };
}

function makeThread(overrides: Partial<Omit<Thread, "id">> & { id: string }): Thread {
  return {
    projectId: "project-1",
    codexThreadId: null,
    title: `Thread ${overrides.id}`,
    modelSelection: { provider: "codex", model: "gpt-5" } as Thread["modelSelection"],
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-07-22T12:00:00.000Z",
    activities: [],
    latestTurn: null,
    turnDiffSummaries: [],
    ...overrides,
  } as Thread;
}

function runningThread(id: string, createdAt = "2026-07-22T12:00:00.000Z"): Thread {
  const turnId = TurnId.makeUnsafe(`turn-${id}`);
  return makeThread({
    id,
    createdAt,
    session: {
      provider: "codex",
      status: "running",
      activeTurnId: turnId,
      createdAt,
      updatedAt: createdAt,
      orchestrationStatus: "running",
    },
    latestTurn: {
      turnId,
      state: "running",
      requestedAt: createdAt,
      startedAt: createdAt,
      completedAt: null,
      assistantMessageId: null,
    },
  });
}

function approvalThread(id: string, createdAt: string): Thread {
  return makeThread({
    id,
    createdAt,
    hasPendingApprovals: true,
    activities: [
      makeActivity({
        id: EventId.makeUnsafe(`approval-${id}`),
        kind: "approval.requested",
        tone: "approval",
        summary: "Command approval requested",
        createdAt,
        payload: {
          requestId: `request-${id}`,
          requestKind: "command",
          detail: "bun run test --filter web",
        },
      }),
    ],
  });
}

describe("projectNativeIslandViewModel", () => {
  it("projects the active coding state with native labels, elapsed time, and diff totals", () => {
    const thread = runningThread("reading");
    const turnId = thread.latestTurn!.turnId;
    thread.activities = [
      makeActivity({
        kind: "tool.completed",
        summary: "Read MessagesTimeline.tsx 219 lines",
        turnId,
        payload: { requestKind: "file-read" },
      }),
    ];
    thread.turnDiffSummaries = [
      {
        turnId,
        completedAt: "2026-07-22T12:00:30.000Z",
        files: [
          { path: "MessagesTimeline.tsx", additions: 40, deletions: 10 },
          { path: "islandViewModel.ts", additions: 2, deletions: 1 },
        ],
      },
    ];

    const result = projectNativeIslandViewModel([thread], NOW_MS);

    expect(result).toMatchObject({
      target: "native",
      snapshot: {
        version: 1,
        mode: "activity",
        primaryThreadId: "reading",
        sessions: [
          {
            id: "reading",
            provider: "Codex",
            elapsed: "1m",
            activity: "Reading file",
            detail: "Read MessagesTimeline.tsx 219 lines",
            status: "working",
            changeSummary: "+42 −11",
          },
        ],
      },
    });
  });

  it("gives a pending approval global priority over newer activity and React-only modes", () => {
    const approval = approvalThread("approval", "2026-07-22T11:58:00.000Z");
    const userInput = makeThread({
      id: "user-input",
      createdAt: "2026-07-22T12:00:40.000Z",
      hasPendingUserInput: true,
    });
    const plan = makeThread({
      id: "plan",
      createdAt: "2026-07-22T12:00:50.000Z",
      hasActionableProposedPlan: true,
    });
    const activity = runningThread("activity", "2026-07-22T12:00:55.000Z");

    const result = projectNativeIslandViewModel([userInput, activity, plan, approval], NOW_MS);

    expect(result).toMatchObject({
      target: "native",
      snapshot: {
        mode: "approval",
        primaryThreadId: "approval",
        approval: {
          threadId: "approval",
          requestId: "request-approval",
          requestKind: "command",
        },
      },
    });
    expect(result.target).toBe("native");
    if (result.target !== "native") return;
    expect(result.snapshot.sessions[0]).toMatchObject({
      id: "approval",
      activity: "Waiting for permission",
      detail: "bun run test --filter web",
      status: "approval",
    });
  });

  it("returns explicit React fallbacks for user-input and plan modes", () => {
    const userInput = makeThread({
      id: "user-input",
      hasPendingUserInput: true,
      createdAt: "2026-07-22T11:59:00.000Z",
    });
    const plan = makeThread({
      id: "plan",
      hasActionableProposedPlan: true,
      createdAt: "2026-07-22T12:00:00.000Z",
    });

    expect(projectNativeIslandViewModel([plan, userInput], NOW_MS)).toEqual({
      target: "react",
      reason: "user-input",
      threadId: "user-input",
    });
    expect(projectNativeIslandViewModel([plan], NOW_MS)).toEqual({
      target: "react",
      reason: "plan",
      threadId: "plan",
    });
  });

  it("caps active snapshots at five sessions and bounds every display string", () => {
    const longText = `unsafe\u202E${"x".repeat(260)}`;
    const threads = Array.from({ length: 7 }, (_, index) =>
      runningThread(`active-${index}`, `2026-07-22T11:5${index}:00.000Z`),
    );
    threads[6]!.title = longText;
    threads[6]!.activities = [
      makeActivity({
        kind: "task.progress",
        summary: longText,
        turnId: threads[6]!.latestTurn!.turnId,
        createdAt: "2026-07-22T11:59:30.000Z",
      }),
    ];

    const result = projectNativeIslandViewModel(threads, NOW_MS);
    expect(result.target).toBe("native");
    if (result.target !== "native") return;

    expect(result.snapshot.mode).toBe("activity");
    expect(result.snapshot.sessions).toHaveLength(NATIVE_ISLAND_MAX_SESSIONS);
    expect(result.snapshot.sessions[0]?.id).toBe("active-6");
    for (const session of result.snapshot.sessions) {
      expect(Array.from(session.title).length).toBeLessThanOrEqual(NATIVE_ISLAND_TEXT_LIMITS.title);
      expect(Array.from(session.provider).length).toBeLessThanOrEqual(
        NATIVE_ISLAND_TEXT_LIMITS.provider,
      );
      expect(Array.from(session.elapsed).length).toBeLessThanOrEqual(
        NATIVE_ISLAND_TEXT_LIMITS.elapsed,
      );
      expect(Array.from(session.activity).length).toBeLessThanOrEqual(
        NATIVE_ISLAND_TEXT_LIMITS.activity,
      );
      expect(Array.from(session.detail).length).toBeLessThanOrEqual(
        NATIVE_ISLAND_TEXT_LIMITS.detail,
      );
      expect(Array.from(session.changeSummary).length).toBeLessThanOrEqual(
        NATIVE_ISLAND_TEXT_LIMITS.changeSummary,
      );
      expect(Object.values(session).join(" ")).not.toContain("\u202E");
    }
  });

  it("keeps idle and recent-thread UX in React instead of publishing native idle content", () => {
    const recent = makeThread({
      id: "recent",
      createdAt: "2026-07-22T12:00:10.000Z",
    });
    expect(projectNativeIslandViewModel([recent], NOW_MS)).toEqual({
      target: "react",
      reason: "idle",
      threadId: "recent",
    });

    const archivedApproval = approvalThread("archived", "2026-07-22T12:00:00.000Z");
    archivedApproval.archivedAt = "2026-07-22T12:00:30.000Z";

    expect(projectNativeIslandViewModel([archivedApproval], NOW_MS)).toEqual({
      target: "react",
      reason: "idle",
      threadId: null,
    });
  });
});
