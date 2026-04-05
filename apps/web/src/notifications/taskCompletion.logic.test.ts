import { describe, expect, it } from "vitest";
import { MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { buildTaskCompletionCopy, collectCompletedThreadCandidates } from "./taskCompletion.logic";
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
