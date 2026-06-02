import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-06-02T10:00:00.000Z";

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  occurredAt?: string;
  aggregateId?: string;
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.makeUnsafe(input.aggregateId ?? "thread-1"),
    occurredAt: input.occurredAt ?? NOW,
    commandId: CommandId.makeUnsafe(`cmd-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const threadCreatedEvent = makeEvent({
  sequence: 1,
  type: "thread.created",
  payload: {
    threadId: "thread-1",
    projectId: "project-1",
    title: "demo",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
});

function goalCreatedEvent(overrides?: { tokenBudget?: number | null }): OrchestrationEvent {
  return makeEvent({
    sequence: 2,
    type: "thread.goal-created",
    payload: {
      threadId: "thread-1",
      goal: {
        id: "goal-1",
        objective: "Migrate the auth module",
        status: "active",
        tokenBudget: overrides?.tokenBudget ?? null,
        tokensUsed: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        turnCount: 0,
        continuationCount: 0,
        timeUsedSeconds: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  });
}

async function applyEvents(events: ReadonlyArray<OrchestrationEvent>) {
  let model = createEmptyReadModel(NOW);
  for (const event of events) {
    model = await Effect.runPromise(projectEvent(model, event));
  }
  return model;
}

function turnCompletedActivityEvent(input: {
  sequence: number;
  turnId: string;
  occurredAt: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}): OrchestrationEvent {
  return makeEvent({
    sequence: input.sequence,
    type: "thread.activity-appended",
    occurredAt: input.occurredAt,
    payload: {
      threadId: "thread-1",
      activity: {
        id: EventId.makeUnsafe(`activity-${input.sequence}`),
        tone: "info",
        kind: "turn.completed",
        summary: "Turn completed",
        payload: input.usage ? { usage: input.usage } : {},
        turnId: TurnId.makeUnsafe(input.turnId),
        createdAt: input.occurredAt,
      },
    },
  });
}

describe("orchestration projector — goals", () => {
  it("creates a goal on thread.goal-created", async () => {
    const model = await applyEvents([threadCreatedEvent, goalCreatedEvent()]);
    const goal = model.threads[0]?.goal;
    expect(goal?.status).toBe("active");
    expect(goal?.objective).toBe("Migrate the auth module");
    expect(goal?.turnCount).toBe(0);
  });

  it("transitions status through the lifecycle events", async () => {
    const paused = await applyEvents([
      threadCreatedEvent,
      goalCreatedEvent(),
      makeEvent({
        sequence: 3,
        type: "thread.goal-paused",
        payload: { threadId: "thread-1", updatedAt: NOW },
      }),
    ]);
    expect(paused.threads[0]?.goal?.status).toBe("paused");

    const resumed = await applyEvents([
      threadCreatedEvent,
      goalCreatedEvent(),
      makeEvent({
        sequence: 3,
        type: "thread.goal-paused",
        payload: { threadId: "thread-1", updatedAt: NOW },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.goal-resumed",
        payload: { threadId: "thread-1", updatedAt: NOW },
      }),
    ]);
    expect(resumed.threads[0]?.goal?.status).toBe("active");

    const completed = await applyEvents([
      threadCreatedEvent,
      goalCreatedEvent(),
      makeEvent({
        sequence: 3,
        type: "thread.goal-completed",
        payload: { threadId: "thread-1", updatedAt: NOW },
      }),
    ]);
    expect(completed.threads[0]?.goal?.status).toBe("complete");

    const cleared = await applyEvents([
      threadCreatedEvent,
      goalCreatedEvent(),
      makeEvent({
        sequence: 3,
        type: "thread.goal-cleared",
        payload: { threadId: "thread-1", updatedAt: NOW },
      }),
    ]);
    expect(cleared.threads[0]?.goal?.status).toBe("cleared");
  });

  it("counts hidden goal-continuation turns", async () => {
    const model = await applyEvents([
      threadCreatedEvent,
      goalCreatedEvent(),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        payload: {
          threadId: "thread-1",
          messageId: "msg-continuation-1",
          role: "user",
          text: "continue",
          turnId: null,
          streaming: false,
          source: "goal-continuation",
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    ]);
    expect(model.threads[0]?.goal?.continuationCount).toBe(1);
  });

  it("accumulates turn count and usage on completed turns", async () => {
    const model = await applyEvents([
      threadCreatedEvent,
      goalCreatedEvent(),
      turnCompletedActivityEvent({
        sequence: 3,
        turnId: "turn-1",
        occurredAt: "2026-06-02T10:00:30.000Z",
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    ]);
    const goal = model.threads[0]?.goal;
    expect(goal?.turnCount).toBe(1);
    expect(goal?.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    expect(goal?.tokensUsed).toBe(150);
    expect(goal?.timeUsedSeconds).toBe(30);
  });

  it("trips the budget guard when usage exceeds the token budget", async () => {
    const model = await applyEvents([
      threadCreatedEvent,
      goalCreatedEvent({ tokenBudget: 100 }),
      turnCompletedActivityEvent({
        sequence: 3,
        turnId: "turn-1",
        occurredAt: "2026-06-02T10:00:30.000Z",
        usage: { inputTokens: 90, outputTokens: 60 },
      }),
    ]);
    const goal = model.threads[0]?.goal;
    expect(goal?.tokensUsed).toBe(150);
    expect(goal?.status).toBe("budget_limited");
  });
});
