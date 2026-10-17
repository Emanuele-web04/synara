import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-10-11T00:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-effort-retry");
const USER_ID = MessageId.makeUnsafe("user-effort-retry");
const ASSISTANT_ID = MessageId.makeUnsafe("assistant-effort-retry");
const TURN_ID = TurnId.makeUnsafe("turn-effort-retry");
const CHECKPOINT_REF = CheckpointRef.makeUnsafe("refs/synara/checkpoints/retry/turn/1");

function makeThread(): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: ProjectId.makeUnsafe("project-effort-retry"),
    title: "Effort retry",
    modelSelection: { provider: "codex", model: "gpt-5.4", options: { reasoningEffort: "medium" } },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
    latestTurn: {
      turnId: TURN_ID,
      state: "completed",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: ASSISTANT_ID,
    },
    handoff: null,
    messages: [
      {
        id: USER_ID,
        role: "user",
        text: "Fix the flaky test",
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: ASSISTANT_ID,
        role: "assistant",
        text: "First attempt",
        turnId: TURN_ID,
        streaming: false,
        source: "native",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    session: null,
    activities: [],
    proposedPlans: [],
    checkpoints: [
      {
        turnId: TURN_ID,
        checkpointTurnCount: 1,
        checkpointRef: CHECKPOINT_REF,
        status: "ready",
        files: [],
        assistantMessageId: ASSISTANT_ID,
        completedAt: NOW,
      },
    ],
    deletedAt: null,
  };
}

function command(): Extract<OrchestrationCommand, { type: "thread.message.edit-and-resend" }> {
  const source = makeThread();
  return {
    type: "thread.message.edit-and-resend",
    commandId: CommandId.makeUnsafe("cmd-effort-retry"),
    threadId: THREAD_ID,
    messageId: USER_ID,
    text: source.messages[0]!.text,
    modelSelection: { provider: "codex", model: "gpt-5.4", options: { reasoningEffort: "high" } },
    retryFrom: {
      assistantMessageId: ASSISTANT_ID,
      assistantMessageUpdatedAt: NOW,
      turnId: TURN_ID,
      userMessageText: source.messages[0]!.text,
      modelSelection: source.modelSelection,
      checkpointTurnCount: 1,
      checkpointRef: CHECKPOINT_REF,
    },
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: NOW,
  };
}

function decide(thread = makeThread(), request = command()) {
  const readModel: OrchestrationReadModel = {
    snapshotSequence: 1,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads: [thread],
  };
  return decideOrchestrationCommand({ command: request, readModel });
}

async function expectRefusal(thread: OrchestrationThread, request = command()) {
  const result = await Effect.runPromise(decide(thread, request).pipe(Effect.result));
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    expect(result.failure._tag).toBe("OrchestrationCommandInvariantError");
    expect(result.failure.detail.length).toBeGreaterThan(0);
  }
}

describe("settled effort retry admission", () => {
  it("preserves the confirmed source on the admitted provider intent", async () => {
    const result = await Effect.runPromise(decide());
    const events = Array.isArray(result) ? result : [result];
    expect(
      events.find((event) => event.type === "thread.message-edit-resend-requested"),
    ).toMatchObject({ payload: { retryFrom: command().retryFrom } });
  });

  it("refuses a prompt revision from another client", async () => {
    const thread = makeThread();
    await expectRefusal({
      ...thread,
      messages: thread.messages.map((message) =>
        message.id === USER_ID ? { ...message, text: "A different prompt" } : message,
      ),
    });
  });

  it("refuses a newer assistant attempt for the same user message", async () => {
    const thread = makeThread();
    await expectRefusal({
      ...thread,
      messages: thread.messages.map((message) =>
        message.id === ASSISTANT_ID
          ? { ...message, turnId: TurnId.makeUnsafe("newer-turn") }
          : message,
      ),
    });
  });

  it("refuses a revised assistant message", async () => {
    const thread = makeThread();
    await expectRefusal({
      ...thread,
      messages: thread.messages.map((message) =>
        message.id === ASSISTANT_ID
          ? { ...message, updatedAt: "2026-10-11T00:00:01.000Z" }
          : message,
      ),
    });
  });

  it("refuses a changed thread model", async () => {
    await expectRefusal({
      ...makeThread(),
      modelSelection: { provider: "codex", model: "gpt-5.5" },
    });
  });

  it("refuses a provider, model, or non-effort option change", async () => {
    const request = command();
    await expectRefusal(makeThread(), {
      ...request,
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
        options: { reasoningEffort: "high", fastMode: true },
      },
    });
  });

  it("refuses the same effective explicit effort", async () => {
    await expectRefusal(makeThread(), {
      ...command(),
      modelSelection: makeThread().modelSelection,
    });
  });

  it("refuses an active provider session even when the previous answer is settled", async () => {
    await expectRefusal({
      ...makeThread(),
      session: {
        threadId: THREAD_ID,
        providerName: "codex",
        runtimeMode: "approval-required",
        status: "running",
        activeTurnId: TURN_ID,
        lastError: null,
        updatedAt: NOW,
      },
    });
  });

  it("refuses a missing or changed checkpoint", async () => {
    const thread = makeThread();
    await expectRefusal({
      ...thread,
      checkpoints: thread.checkpoints.map((checkpoint) => ({
        ...checkpoint,
        status: "missing",
      })),
    });
    await expectRefusal({
      ...thread,
      checkpoints: thread.checkpoints.map((checkpoint) => ({
        ...checkpoint,
        checkpointRef: CheckpointRef.makeUnsafe("refs/synara/checkpoints/other/turn/1"),
      })),
    });
  });

  it("refuses a new queued prompt after the confirmed turn", async () => {
    const thread = makeThread();
    await expectRefusal({
      ...thread,
      messages: [
        ...thread.messages,
        {
          ...thread.messages[0]!,
          id: MessageId.makeUnsafe("new-prompt"),
          text: "Continue",
        },
      ],
    });
  });

  it("refuses full-access retry even if the caller labels its request approval-required", async () => {
    await expectRefusal({ ...makeThread(), runtimeMode: "full-access" });
  });

  it("refuses changing the user prompt through the effort-only command", async () => {
    await expectRefusal(makeThread(), { ...command(), text: "Also change the implementation" });
  });
});
