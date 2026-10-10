import { MessageId, ThreadId, TurnId, CheckpointRef } from "@synara/contracts";
import { it, expect } from "vitest";
import { applyOrchestrationEvents } from "./storeEventReducer";
import { makeState, makeThread, makeDomainEvent, threadsOf } from "./storeTestFixtures";
import { normalizeChatMessage } from "./storeNormalization";

it("answer metadata preserves the originating turn's final message and completion time", () => {
  const turnId = TurnId.makeUnsafe("old-turn");
  const questionId = MessageId.makeUnsafe("question");
  const finalId = MessageId.makeUnsafe("final");
  const asked = "2026-09-16T10:00:00Z";
  const completed = "2026-09-16T10:02:00Z";
  const question = {
    id: questionId,
    role: "assistant" as const,
    text: "Which option?",
    turnId,
    createdAt: asked,
    completedAt: asked,
    streaming: false,
    asyncUserInput: { questions: [{ title: "Which option?", options: ["A", "B"] }] },
  };
  const latestTurn = {
    turnId,
    state: "completed" as const,
    requestedAt: asked,
    startedAt: asked,
    completedAt: completed,
    assistantMessageId: finalId,
  };
  const initial = makeState(
    makeThread({
      latestTurn,
      messages: [
        question,
        {
          id: finalId,
          role: "assistant",
          text: "Finished the independent work.",
          turnId,
          createdAt: completed,
          completedAt: completed,
          streaming: false,
        },
      ],
    }),
  );
  const next = applyOrchestrationEvents(initial, [
    makeDomainEvent("thread.async-user-input-answered", {
      threadId: ThreadId.makeUnsafe("thread-1"),
      messageId: questionId,
      response: { messageId: MessageId.makeUnsafe("answer"), answers: ["A"] },
    }),
  ]);
  expect(threadsOf(next)[0]!.latestTurn).toEqual(latestTurn);
  expect(threadsOf(next)[0]!.messages[0]!.completedAt).toBe(asked);
  expect(threadsOf(next)[0]!.messages[0]!.asyncUserInput?.response?.answers).toEqual(["A"]);
});

it.each(["rollback", "checkpoint"])(
  "reopens questions after %s and ignores delayed answer snapshots",
  (kind) => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("old-turn");
    const answerTurnId = TurnId.makeUnsafe("answer-turn");
    const answerId = MessageId.makeUnsafe("answer");
    const question = {
      id: MessageId.makeUnsafe("question"),
      role: "assistant" as const,
      text: "Which option?",
      turnId,
      createdAt: "2026-09-16T10:00:00Z",
      updatedAt: "2026-09-16T10:00:00Z",
      streaming: false,
      source: "native" as const,
      asyncUserInput: {
        questions: [{ title: "Which option?" }],
        response: { messageId: answerId, answers: ["A"] },
        responseSequence: 5,
      },
    };
    const initial = makeState(
      makeThread({
        messages: [
          normalizeChatMessage(question, undefined),
          {
            id: answerId,
            role: "user",
            text: "Which option?\nA",
            turnId: answerTurnId,
            streaming: false,
            createdAt: "2026-09-16T10:05:00Z",
          },
        ],
        turnDiffSummaries: [
          {
            turnId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("refs/checkpoints/one"),
            status: "ready",
            files: [],
            completedAt: "2026-09-16T10:02:00Z",
            assistantMessageId: question.id,
          },
        ],
      }),
    );
    const event =
      kind === "rollback"
        ? makeDomainEvent(
            "thread.conversation-rolled-back",
            { threadId, messageId: answerId, numTurns: 1, removedTurnIds: [answerTurnId] },
            { sequence: 10 },
          )
        : makeDomainEvent("thread.reverted", { threadId, turnCount: 1 }, { sequence: 10 });
    const next = threadsOf(applyOrchestrationEvents(initial, [event]))[0]!;
    expect(next.messages.map((m) => m.id)).toEqual([question.id]);
    const reopened = next.messages[0]!;
    expect(reopened.asyncUserInput).toEqual({
      questions: question.asyncUserInput.questions,
      responseSequence: 10,
    });
    expect(normalizeChatMessage(question, reopened).asyncUserInput).toEqual(
      reopened.asyncUserInput,
    );
    const rollbackSnapshot = {
      ...question,
      asyncUserInput: { questions: question.asyncUserInput.questions, responseSequence: 10 },
    };
    expect(
      normalizeChatMessage(rollbackSnapshot, threadsOf(initial)[0]!.messages[0]).asyncUserInput
        ?.response,
    ).toBeUndefined();
  },
);
