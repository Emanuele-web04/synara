import {
  CheckpointRef,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ServerConfig } from "../../config.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { THREAD_DETAIL_EVENT_TYPES } from "@synara/shared/threadDetailEvents";

type FixtureCommand<T = OrchestrationCommand> = T extends OrchestrationCommand
  ? Omit<T, "commandId" | "createdAt" | "threadId">
  : never;

async function setup() {
  const db = SqlitePersistenceMemory;
  const layer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(db),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "synara-async-history-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const threadId = ThreadId.makeUnsafe("async-history-thread");
  const turnId = TurnId.makeUnsafe("original-turn");
  const questionId = MessageId.makeUnsafe("question");
  const finalId = MessageId.makeUnsafe("final");
  const answerId = MessageId.makeUnsafe("answer");
  const laterTurnId = TurnId.makeUnsafe("answer-turn");
  const projectId = ProjectId.makeUnsafe("async-history-project");
  let i = 0;
  const now = () => new Date(Date.UTC(2026, 8, 16, 0, 0, i)).toISOString();
  const send = (input: FixtureCommand) => {
    const command = {
      threadId,
      commandId: CommandId.makeUnsafe(`async-history-${++i}`),
      createdAt: now(),
      ...input,
    };
    return runtime.runPromise(engine.dispatch(command));
  };
  await send({
    type: "project.create",
    projectId,
    title: "Async question history",
    workspaceRoot: "/tmp/async-history",
    defaultModelSelection: null,
  });
  await send({
    type: "thread.create",
    projectId,
    title: "Async question history",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    interactionMode: "default",
    runtimeMode: "approval-required",
    branch: null,
    worktreePath: null,
  });
  const session = async (status: "ready" | "running", activeTurnId: TurnId | null) =>
    send({
      type: "thread.session.set",
      session: {
        threadId,
        providerName: "codex",
        status,
        activeTurnId,
        runtimeMode: "approval-required",
        lastError: null,
        updatedAt: now(),
      },
    });
  await session("running", turnId);
  await send({
    type: "thread.message.assistant.delta",
    messageId: questionId,
    turnId,
    delta: "Which option?",
  });
  await send({
    type: "thread.message.assistant.complete",
    messageId: questionId,
    turnId,
    asyncQuestions: [{ title: "Which option?", options: ["A", "B"] }],
  });
  await send({
    type: "thread.message.assistant.delta",
    messageId: finalId,
    turnId,
    delta: "Finished the independent work.",
  });
  await send({ type: "thread.message.assistant.complete", messageId: finalId, turnId });
  await session("ready", null);
  const respond = (messageId = answerId, answer = "A") =>
    send({
      type: "thread.turn.start",
      message: { messageId, role: "user", text: answer, attachments: [] },
      asyncUserInputResponse: { messageId: questionId, answers: [answer] },
      dispatchMode: "steer",
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
  const read = async () =>
    (await runtime.runPromise(engine.getReadModel())).threads.find((t) => t.id === threadId)!;
  const replay = async () => {
    const events = await runtime.runPromise(Stream.runCollect(engine.readEvents(0)));
    let model = createEmptyReadModel(now());
    for (const event of events) model = await runtime.runPromise(projectEvent(model, event));
    return model.threads.find((t) => t.id === threadId)!;
  };
  const originalTurn = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql`SELECT assistant_message_id FROM projection_turns WHERE thread_id=${threadId} AND turn_id=${turnId}`;
      }),
    );
  return {
    runtime,
    engine,
    send,
    session,
    respond,
    read,
    replay,
    originalTurn,
    questionId,
    finalId,
    answerId,
    turnId,
    laterTurnId,
    threadId,
  };
}

it.each(["rollback", "checkpoint"])(
  "reopens a question after %s removes its answer and accepts a replacement",
  async (kind) => {
    const s = await setup();
    try {
      await s.respond();
      await s.send({
        type: "thread.message.user.bind-turn",
        messageId: s.answerId,
        turnId: s.laterTurnId,
      });
      await s.session("ready", null);
      if (kind === "checkpoint") {
        await s.send({
          type: "thread.turn.diff.complete",
          turnId: s.turnId,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe("refs/checkpoints/one"),
          status: "ready",
          files: [],
          completedAt: "2026-09-16T00:00:10.000Z",
          assistantMessageId: s.finalId,
        });
        await s.send({ type: "thread.revert.complete", turnCount: 1 });
      } else {
        await s.send({
          type: "thread.conversation.rollback.complete",
          messageId: s.answerId,
          numTurns: 1,
          removedTurnIds: [s.laterTurnId],
        });
      }
      const thread = await s.read();
      expect(thread.messages.some((m) => m.id === s.answerId)).toBe(false);
      const remainingResponse = thread.messages.find((m) => m.id === s.questionId)?.asyncUserInput
        ?.response;
      expect(remainingResponse).toBeUndefined();
      expect(
        thread.messages.find((m) => m.id === s.questionId)?.asyncUserInput?.responseSequence,
      ).toBeGreaterThan(0);
      expect(
        (await s.replay()).messages.find((m) => m.id === s.questionId)?.asyncUserInput,
      ).toEqual(thread.messages.find((m) => m.id === s.questionId)?.asyncUserInput);
      await s.respond(MessageId.makeUnsafe("replacement"), "B");
      expect(
        (await s.read()).messages.find((m) => m.id === s.questionId)?.asyncUserInput?.response
          ?.answers,
      ).toEqual(["B"]);
    } finally {
      await s.runtime.dispose();
    }
  },
);

it("answering an old question preserves the final assistant message for its turn", async () => {
  const s = await setup();
  try {
    expect(await s.originalTurn()).toEqual([{ assistant_message_id: s.finalId }]);
    await s.respond();
    expect(await s.originalTurn()).toEqual([{ assistant_message_id: s.finalId }]);
    const detailEvents = await s.runtime.runPromise(
      Stream.runCollect(s.engine.readThreadEvents(s.threadId, 0, THREAD_DETAIL_EVENT_TYPES)),
    );
    expect(detailEvents.some((event) => event.type === "thread.async-user-input-answered")).toBe(
      true,
    );
    expect(
      (await s.replay()).messages.find((m) => m.id === s.questionId)?.asyncUserInput?.response
        ?.answers,
    ).toEqual(["A"]);
  } finally {
    await s.runtime.dispose();
  }
});

it("rejects plain-text edit-and-resend of a structured answer", async () => {
  const s = await setup();
  try {
    await s.respond();
    await s.send({
      type: "thread.message.user.bind-turn",
      messageId: s.answerId,
      turnId: s.laterTurnId,
    });
    await s.session("ready", null);
    await expect(
      s.send({
        type: "thread.message.edit-and-resend",
        messageId: s.answerId,
        text: "Which option?\nB",
        runtimeMode: "approval-required",
        interactionMode: "default",
      }),
    ).rejects.toThrow("non-native-message");
    const thread = await s.read();
    expect(thread.messages.find((m) => m.id === s.answerId)).toMatchObject({
      source: "async-user-input",
      text: "Which option?\nA",
    });
    expect(
      thread.messages.find((m) => m.id === s.questionId)?.asyncUserInput?.response?.answers,
    ).toEqual(["A"]);
  } finally {
    await s.runtime.dispose();
  }
});
