import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-10-13T10:00:00.000Z";
const PARENT_ID = ThreadId.makeUnsafe("parent");
const PROJECT_ID = ProjectId.makeUnsafe("project");
const TURN_ID = TurnId.makeUnsafe("child-turn");

function makeThread(input: {
  id: string;
  creationSource?: OrchestrationThread["creationSource"];
  running: boolean;
  provider?: "codex" | "claudeAgent";
}): OrchestrationThread {
  return {
    id: ThreadId.makeUnsafe(input.id),
    projectId: PROJECT_ID,
    parentThreadId: PARENT_ID,
    ...(input.creationSource ? { creationSource: input.creationSource } : {}),
    title: "Child",
    modelSelection:
      input.provider === "claudeAgent"
        ? { provider: "claudeAgent", model: "claude-sonnet-4-5" }
        : { provider: "codex", model: "gpt-5-codex" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
    latestTurn: {
      turnId: TURN_ID,
      state: input.running ? "running" : "completed",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: input.running ? null : NOW,
      assistantMessageId: null,
    },
    handoff: null,
    messages: [],
    session: input.running
      ? {
          threadId: ThreadId.makeUnsafe(input.id),
          providerName: input.provider ?? "codex",
          runtimeMode: "full-access",
          status: "running",
          activeTurnId: TURN_ID,
          lastError: null,
          updatedAt: NOW,
        }
      : null,
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    deletedAt: null,
  };
}

function decide(thread: OrchestrationThread) {
  const readModel: OrchestrationReadModel = {
    snapshotSequence: 1,
    spaces: [],
    projects: [],
    threads: [thread],
    updatedAt: NOW,
  };
  return decideOrchestrationCommand({
    readModel,
    command: {
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe("send-child"),
      threadId: thread.id,
      message: {
        messageId: MessageId.makeUnsafe("child-message"),
        role: "user",
        text: "One brief follow-up",
        attachments: [],
      },
      dispatchMode: "steer",
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: NOW,
    },
  });
}

describe("native subagent message admission", () => {
  it.each([
    { id: "native-child", creationSource: "provider_native" as const },
    { id: "subagent:parent:legacy-child" },
  ])("rejects a finished native child before recording a message ($id)", async (input) => {
    const error = await Effect.runPromise(
      Effect.flip(decide(makeThread({ ...input, running: false }))),
    );
    expect(error).toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      commandType: "thread.turn.start",
    });
  });

  it("accepts a steer into a running native child", async () => {
    const decided = await Effect.runPromise(
      decide(
        makeThread({
          id: "native-running",
          creationSource: "provider_native",
          running: true,
          provider: "claudeAgent",
        }),
      ),
    );
    const events = Array.isArray(decided) ? decided : [decided];
    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(events[0]).toMatchObject({ payload: { startsNewTurn: false } });
  });

  it("rejects direct messages to a running native Codex child", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        decide(
          makeThread({ id: "native-codex", creationSource: "provider_native", running: true }),
        ),
      ),
    );
    expect(error).toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      commandType: "thread.turn.start",
    });
  });

  it("keeps a finished app-owned child available for another turn", async () => {
    const decided = await Effect.runPromise(
      decide(makeThread({ id: "app-child", running: false })),
    );
    const events = Array.isArray(decided) ? decided : [decided];
    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
  });
});
