import { EventId, MessageId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { applyOrchestrationEvents } from "./storeEventReducer";
import { normalizeThreadFromReadModel } from "./storeNormalization";
import {
  makeActivity,
  makeDomainEvent,
  makeReadModelThread,
  makeState,
  makeThread,
  threadsOf,
} from "./storeTestFixtures";
import { deriveTimelineEntries, deriveWorkLogEntries } from "./workLog";
import { deriveMessagesTimelineRows } from "./components/chat/MessagesTimeline.logic";

const turnId = TurnId.makeUnsafe("failed-turn");
const cause = "Selected model is at capacity. Please try a different model.";
const failure = makeActivity({
  id: "fatal-error",
  turnId,
  sequence: 2,
  kind: "runtime.error",
  tone: "error",
  summary: "Provider runtime error",
  payload: { message: cause, class: "provider_error" },
});
const completed = makeActivity({
  id: "failed-completion",
  turnId,
  sequence: 3,
  kind: "turn.completed",
  tone: "error",
  summary: "Turn failed",
  payload: { state: "failed", errorMessage: cause },
});

describe("durable turn failure feedback", () => {
  it("keeps one standalone failure after the session recovers to ready", () => {
    const initial = makeThread({
      activities: [failure, completed],
      error: cause,
      latestTurn: {
        turnId,
        state: "error",
        requestedAt: failure.createdAt,
        startedAt: failure.createdAt,
        completedAt: completed.createdAt,
        assistantMessageId: null,
      },
    });
    const state = applyOrchestrationEvents(makeState(initial), [
      makeDomainEvent("thread.session-set", {
        threadId: initial.id,
        session: {
          threadId: initial.id,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-10-05T08:11:00.000Z",
        },
      }),
    ]);
    const thread = threadsOf(state)[0]!;
    expect(thread.error).toBeNull();
    expect(thread.latestTurn?.state).toBe("error");
    const entries = deriveWorkLogEntries(thread.activities, turnId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ turnId, turnFailure: { cause } });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: deriveTimelineEntries([], [], entries),
      isWorking: false,
      worktreeSetup: null,
      worktreeSetupOpen: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });
    expect(rows).toMatchObject([{ kind: "work", groupedEntries: [{ turnFailure: { cause } }] }]);
  });

  it("restores the cause on reopening even without a final assistant message", () => {
    const incoming = makeReadModelThread({
      activities: [failure, completed],
      session: {
        threadId: makeThread().id,
        status: "ready",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-10-05T08:11:00.000Z",
      },
    });
    const reopened = normalizeThreadFromReadModel(JSON.parse(JSON.stringify(incoming)), undefined);
    expect(reopened.messages).toEqual([]);
    expect(reopened.error).toBeNull();
    expect(deriveWorkLogEntries(reopened.activities, turnId)).toMatchObject([
      { turnFailure: { cause }, turnId },
    ]);
  });

  it("deduplicates replayed terminal events and keeps older failures after a new turn", () => {
    const nextTurn = TurnId.makeUnsafe("next-turn");
    const entries = deriveWorkLogEntries(
      [
        failure,
        completed,
        { ...failure, id: EventId.makeUnsafe("fatal-error-replay"), sequence: 4 },
        { ...completed, id: EventId.makeUnsafe("completion-replay"), sequence: 5 },
      ],
      nextTurn,
      {
        visibleTurnIds: new Set([nextTurn]),
      },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ turnId, turnFailure: { cause } });
  });

  it("shows an announced retry as active work and never as a failed task", () => {
    const warning = makeActivity({
      id: "retrying",
      turnId,
      kind: "runtime.warning",
      tone: "info",
      summary: "Runtime warning",
      payload: { message: cause, data: { willRetry: true } },
    });
    const entries = deriveWorkLogEntries([warning], turnId);
    expect(entries[0]?.label).toBe("Provider retrying");
    expect(entries.some((entry) => entry.turnFailure)).toBe(false);
    const success = {
      ...completed,
      id: EventId.makeUnsafe("success"),
      tone: "info" as const,
      payload: { state: "completed" },
      summary: "Turn completed",
    };
    expect(
      deriveWorkLogEntries([warning, success], turnId).some((entry) => entry.turnFailure),
    ).toBe(false);
  });

  it.each(["interrupted", "cancelled"])(
    "respects voluntary %s instead of reporting failure",
    (state) => {
      const terminal = {
        ...completed,
        tone: "info" as const,
        payload: { state },
        summary: "Turn interrupted",
      };
      expect(
        deriveWorkLogEntries([failure, terminal], turnId).some((entry) => entry.turnFailure),
      ).toBe(false);
    },
  );

  it("uses the overload code when the provider's wording changes", () => {
    const changed = {
      ...failure,
      payload: { message: "Temporarily unavailable", errorCode: "server_overloaded" },
    };
    expect(deriveWorkLogEntries([changed], turnId)[0]?.turnFailure?.message).toContain(
      "model is at capacity",
    );
  });

  it("keeps an idle connection error as runtime feedback without claiming task failure", () => {
    const idleError = { ...failure, turnId: null, payload: { message: "Connection lost" } };
    const entries = deriveWorkLogEntries([idleError], undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.turnFailure).toBeUndefined();
  });

  it("does not duplicate a scoped completion with a subsequent unscoped runtime error", () => {
    const unscopedError = { ...failure, turnId: null, sequence: 4 };
    const failures = deriveWorkLogEntries([completed, unscopedError], turnId).filter(
      (entry) => entry.turnFailure,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.turnId).toBe(turnId);
  });

  it("does not turn an ambiguous completion into a per-turn task failure", () => {
    expect(
      deriveWorkLogEntries([{ ...completed, turnId: null }], turnId).some(
        (entry) => entry.turnFailure,
      ),
    ).toBe(false);
  });

  it("keeps a failed-turn notice outside folded progress messages after another turn starts", () => {
    const startedAt = "2026-10-05T08:00:00.000Z";
    const progressAt = "2026-10-05T08:05:00.000Z";
    const failedAt = "2026-10-05T08:10:40.000Z";
    const nextAt = "2026-10-05T08:12:00.000Z";
    const messages = [
      {
        id: MessageId.makeUnsafe("request"),
        role: "user" as const,
        text: "Review the PRs",
        createdAt: startedAt,
        streaming: false,
        turnId,
      },
      {
        id: MessageId.makeUnsafe("progress"),
        role: "assistant" as const,
        text: "Preparing worktrees",
        createdAt: progressAt,
        completedAt: progressAt,
        streaming: false,
        turnId,
      },
      {
        id: MessageId.makeUnsafe("next-request"),
        role: "user" as const,
        text: "Continue",
        createdAt: nextAt,
        streaming: false,
        turnId: TurnId.makeUnsafe("next-turn"),
      },
    ];
    const entries = deriveWorkLogEntries(
      [
        { ...failure, createdAt: failedAt },
        { ...completed, createdAt: failedAt },
      ],
      TurnId.makeUnsafe("next-turn"),
    );
    const rows = deriveMessagesTimelineRows({
      timelineEntries: deriveTimelineEntries(messages, [], entries),
      isWorking: true,
      activeTurnId: TurnId.makeUnsafe("next-turn"),
      collapseFinishedTurns: true,
      worktreeSetup: null,
      worktreeSetupOpen: false,
      activeTurnStartedAt: nextAt,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });
    expect(rows.filter((row) => row.kind === "work")).toMatchObject([
      { groupedEntries: [{ turnId, turnFailure: { cause } }] },
    ]);
  });
});
