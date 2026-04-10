import { describe, expect, it } from "vitest";
import {
  ApprovalRequestId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  buildInputNeededCopy,
  buildTaskCompletionCopy,
  collectCompletedThreadCandidates,
  collectInputNeededThreadCandidates,
} from "./taskCompletion.logic";
import type { Thread } from "../types";

function makeThread(overrides: Partial<Thread>): Thread {
  return {
    id: "thread-1" as ThreadId,
    codexThreadId: null,
    projectId: "project-1" as ProjectId,
    title: "Polish notifications",
    modelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: {
      provider: "codex",
      status: "running",
      orchestrationStatus: "running",
      createdAt: "2026-04-05T10:00:00.000Z",
      updatedAt: "2026-04-05T10:00:00.000Z",
    },
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-05T10:00:00.000Z",
    updatedAt: "2026-04-05T10:00:00.000Z",
    latestTurn: {
      turnId: TurnId.makeUnsafe("turn-1"),
      state: "running",
      requestedAt: "2026-04-05T10:00:00.000Z",
      startedAt: "2026-04-05T10:00:00.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
    lastVisitedAt: "2026-04-05T10:00:00.000Z",
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("collectCompletedThreadCandidates", () => {
  it("returns threads that moved from working to completed", () => {
    const previous = [
      makeThread({
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:01.000Z",
        },
      }),
    ];
    const next = [
      makeThread({
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:05.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-04-05T10:00:00.000Z",
          startedAt: "2026-04-05T10:00:00.000Z",
          completedAt: "2026-04-05T10:00:05.000Z",
          assistantMessageId: MessageId.makeUnsafe("msg-1"),
          sourceProposedPlan: undefined,
        },
        messages: [
          {
            id: MessageId.makeUnsafe("msg-1"),
            role: "assistant",
            text: "Finished the task and everything looks good.",
            createdAt: "2026-04-05T10:00:01.000Z",
            completedAt: "2026-04-05T10:00:05.000Z",
            streaming: false,
          },
        ],
      }),
    ];

    expect(collectCompletedThreadCandidates(previous, next)).toEqual([
      {
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Polish notifications",
        completedAt: "2026-04-05T10:00:05.000Z",
        assistantSummary: "Finished the task and everything looks good.",
      },
    ]);
  });

  it("ignores initial hydrated threads and non-completion updates", () => {
    const previous = [makeThread({ session: null })];
    const next = [
      makeThread({
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:05.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-04-05T10:00:00.000Z",
          startedAt: "2026-04-05T10:00:00.000Z",
          completedAt: "2026-04-05T10:00:05.000Z",
          assistantMessageId: null,
          sourceProposedPlan: undefined,
        },
      }),
    ];

    expect(collectCompletedThreadCandidates(previous, next)).toEqual([]);
  });
});

describe("buildTaskCompletionCopy", () => {
  it("prefers assistant output when available", () => {
    expect(
      buildTaskCompletionCopy({
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Polish notifications",
        completedAt: "2026-04-05T10:00:05.000Z",
        assistantSummary: "Finished the task and everything looks good.",
      }),
    ).toEqual({
      title: "Task completed",
      body: "Polish notifications: Finished the task and everything looks good.",
    });
  });
});

describe("collectInputNeededThreadCandidates", () => {
  it("returns threads with newly opened approval requests", () => {
    const previous = [makeThread({ activities: [] })];
    const next = [
      makeThread({
        activities: [
          {
            id: EventId.makeUnsafe("activity-approval-1"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-request-1",
              requestKind: "command",
            },
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-04-05T10:00:04.000Z",
          },
        ],
      }),
    ];

    expect(collectInputNeededThreadCandidates(previous, next)).toEqual([
      {
        kind: "approval",
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Polish notifications",
        createdAt: "2026-04-05T10:00:04.000Z",
        requestId: ApprovalRequestId.makeUnsafe("approval-request-1"),
        requestKind: "command",
      },
    ]);
  });

  it("returns threads with newly opened user-input requests", () => {
    const previous = [makeThread({ activities: [] })];
    const next = [
      makeThread({
        activities: [
          {
            id: EventId.makeUnsafe("activity-user-input-1"),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: {
              requestId: "user-input-request-1",
              questions: [
                {
                  id: "question-1",
                  header: "Question",
                  question: "Continue?",
                  options: [
                    { label: "Yes", description: "Continue" },
                    { label: "No", description: "Stop" },
                  ],
                },
              ],
            },
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-04-05T10:00:06.000Z",
          },
        ],
      }),
    ];

    expect(collectInputNeededThreadCandidates(previous, next)).toEqual([
      {
        kind: "user-input",
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Polish notifications",
        createdAt: "2026-04-05T10:00:06.000Z",
        requestId: ApprovalRequestId.makeUnsafe("user-input-request-1"),
      },
    ]);
  });

  it("ignores already-open requests from the previous snapshot", () => {
    const activities = [
      {
        id: EventId.makeUnsafe("activity-approval-1"),
        tone: "approval" as const,
        kind: "approval.requested",
        summary: "Command approval requested",
        payload: {
          requestId: "approval-request-1",
          requestKind: "command",
        },
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-04-05T10:00:04.000Z",
      },
    ];

    expect(
      collectInputNeededThreadCandidates(
        [makeThread({ activities })],
        [makeThread({ activities })],
      ),
    ).toEqual([]);
  });
});

describe("buildInputNeededCopy", () => {
  it("describes approvals succinctly", () => {
    expect(
      buildInputNeededCopy({
        kind: "approval",
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Polish notifications",
        createdAt: "2026-04-05T10:00:04.000Z",
        requestId: ApprovalRequestId.makeUnsafe("approval-request-1"),
        requestKind: "command",
      }),
    ).toEqual({
      title: "Input needed",
      body: "Polish notifications: Command approval requested.",
    });
  });

  it("describes user-input requests succinctly", () => {
    expect(
      buildInputNeededCopy({
        kind: "user-input",
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Polish notifications",
        createdAt: "2026-04-05T10:00:06.000Z",
        requestId: ApprovalRequestId.makeUnsafe("user-input-request-1"),
      }),
    ).toEqual({
      title: "Input needed",
      body: "Polish notifications: User input requested.",
    });
  });
});
