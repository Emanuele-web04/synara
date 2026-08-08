import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationThreadActivity,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");

async function createThreadReadModel(now: string) {
  const withProject = await Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: EventId.makeUnsafe("evt-project-create"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.makeUnsafe("cmd-project-create"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-project-create"),
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        kind: "project",
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );

  return Effect.runPromise(
    projectEvent(withProject, {
      sequence: 2,
      eventId: EventId.makeUnsafe("evt-thread-create"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.created",
      occurredAt: now,
      commandId: CommandId.makeUnsafe("cmd-thread-create"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-thread-create"),
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        envMode: "local",
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        forkSourceThreadId: null,
        sidechatSourceThreadId: null,
        handoff: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

const importedMessage = {
  messageId: MessageId.makeUnsafe("import:thread-1:claude:u-1"),
  role: "user" as const,
  text: "Imported question",
  createdAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-08-01T09:00:00.000Z",
};

const importedActivity: OrchestrationThreadActivity = {
  id: EventId.makeUnsafe("import:thread-1:claude:tool:tool-1"),
  tone: "tool",
  kind: "tool.completed",
  summary: "Command run",
  payload: { itemType: "command_execution", status: "completed" },
  turnId: null,
  sequence: 0,
  createdAt: "2026-08-01T09:00:05.000Z",
};

describe("decider thread.messages.import activities", () => {
  it("emits message-sent events followed by activity-appended events", async () => {
    const now = new Date().toISOString();
    const readModel = await createThreadReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.messages.import",
          commandId: CommandId.makeUnsafe("cmd-import"),
          threadId: THREAD_ID,
          messages: [importedMessage],
          activities: [importedActivity],
          createdAt: now,
        },
        readModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event?.type)).toEqual([
      "thread.message-sent",
      "thread.activity-appended",
    ]);

    const activityEvent = events[1];
    if (activityEvent?.type !== "thread.activity-appended") {
      throw new Error("expected an activity-appended event");
    }
    expect(activityEvent.occurredAt).toBe(now);
    expect(activityEvent.payload.threadId).toBe(THREAD_ID);
    expect(activityEvent.payload.activity).toEqual(importedActivity);
  });

  it("emits only message events when the command omits activities", async () => {
    const now = new Date().toISOString();
    const readModel = await createThreadReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.messages.import",
          commandId: CommandId.makeUnsafe("cmd-import-plain"),
          threadId: THREAD_ID,
          messages: [importedMessage],
          createdAt: now,
        },
        readModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event?.type)).toEqual(["thread.message-sent"]);
  });
});
