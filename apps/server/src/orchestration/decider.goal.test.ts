import {
  CommandId,
  EventId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-06-02T10:00:00.000Z";

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.makeUnsafe("thread-1"),
    occurredAt: NOW,
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

function goalCreatedEvent(status: "active" | "paused" = "active"): OrchestrationEvent {
  return makeEvent({
    sequence: 2,
    type: "thread.goal-created",
    payload: {
      threadId: "thread-1",
      goal: {
        id: "goal-1",
        objective: "Migrate the auth module",
        status,
        tokenBudget: null,
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

async function seedReadModel(events: ReadonlyArray<OrchestrationEvent>) {
  let model = createEmptyReadModel(NOW);
  for (const event of events) {
    model = await Effect.runPromise(projectEvent(model, event));
  }
  return model;
}

function decide(
  command: OrchestrationCommand,
  readModel: Awaited<ReturnType<typeof seedReadModel>>,
) {
  return decideOrchestrationCommand({ command, readModel });
}

describe("orchestration decider — goals", () => {
  it("creates a goal on a thread without one", async () => {
    const readModel = await seedReadModel([threadCreatedEvent]);
    const command = {
      type: "thread.goal.create",
      commandId: CommandId.makeUnsafe("cmd-goal-create"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      goalId: "goal-1",
      objective: "Migrate the auth module",
      tokenBudget: 10_000,
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.goal.create" }>;

    const event = await Effect.runPromise(decide(command, readModel));
    expect(Array.isArray(event)).toBe(false);
    const single = event as Extract<OrchestrationEvent, { type: "thread.goal-created" }>;
    expect(single.type).toBe("thread.goal-created");
    expect(single.payload.goal.objective).toBe("Migrate the auth module");
    expect(single.payload.goal.status).toBe("active");
    expect(single.payload.goal.tokenBudget).toBe(10_000);
  });

  it("rejects creating a second goal while one is active", async () => {
    const readModel = await seedReadModel([threadCreatedEvent, goalCreatedEvent("active")]);
    const command = {
      type: "thread.goal.create",
      commandId: CommandId.makeUnsafe("cmd-goal-create-2"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      goalId: "goal-2",
      objective: "Something else",
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.goal.create" }>;

    const exit = await Effect.runPromiseExit(decide(command, readModel));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("completes an active goal", async () => {
    const readModel = await seedReadModel([threadCreatedEvent, goalCreatedEvent("active")]);
    const command = {
      type: "thread.goal.complete",
      commandId: CommandId.makeUnsafe("cmd-goal-complete"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.goal.complete" }>;

    const event = await Effect.runPromise(decide(command, readModel));
    expect((event as OrchestrationEvent).type).toBe("thread.goal-completed");
  });

  it("rejects pausing when there is no active goal", async () => {
    const readModel = await seedReadModel([threadCreatedEvent]);
    const command = {
      type: "thread.goal.pause",
      commandId: CommandId.makeUnsafe("cmd-goal-pause"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.goal.pause" }>;

    const exit = await Effect.runPromiseExit(decide(command, readModel));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("resumes only a paused goal", async () => {
    const activeModel = await seedReadModel([threadCreatedEvent, goalCreatedEvent("active")]);
    const resumeCommand = {
      type: "thread.goal.resume",
      commandId: CommandId.makeUnsafe("cmd-goal-resume"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: NOW,
    } satisfies Extract<OrchestrationCommand, { type: "thread.goal.resume" }>;

    const exitActive = await Effect.runPromiseExit(decide(resumeCommand, activeModel));
    expect(Exit.isFailure(exitActive)).toBe(true);

    const pausedModel = await seedReadModel([
      threadCreatedEvent,
      goalCreatedEvent("active"),
      makeEvent({
        sequence: 3,
        type: "thread.goal-paused",
        payload: { threadId: "thread-1", updatedAt: NOW },
      }),
    ]);
    const event = await Effect.runPromise(decide(resumeCommand, pausedModel));
    expect((event as OrchestrationEvent).type).toBe("thread.goal-resumed");
  });
});
