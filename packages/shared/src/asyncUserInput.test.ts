import { MessageId } from "@synara/contracts";
import { expect, it } from "vitest";
import { clearRemovedAsyncUserInputResponses, mergeAsyncUserInput } from "./asyncUserInput";

it("only clears answers removed by a history edit", () => {
  const questions = [{ title: "Which option?" }];
  const answered = {
    questions,
    response: { messageId: MessageId.makeUnsafe("answer"), answers: ["A"] },
    responseSequence: 5,
  };
  const messages = [{ id: "question", asyncUserInput: answered }];
  expect(
    clearRemovedAsyncUserInputResponses(messages, new Set(["question", "answer"]), 10)[0],
  ).toBe(messages[0]);
  expect(
    clearRemovedAsyncUserInputResponses(messages, new Set(["question"]), 10)[0]?.asyncUserInput,
  ).toEqual({ questions, responseSequence: 10 });
});

it("orders answer and rollback metadata independently of message text", () => {
  const pending = { questions: [{ title: "Which option?" }] };
  const answered = {
    ...pending,
    response: { messageId: MessageId.makeUnsafe("answer"), answers: ["A"] },
    responseSequence: 5,
  };
  const reopened = { ...pending, responseSequence: 10 };
  expect(mergeAsyncUserInput(answered, pending)).toBe(answered);
  expect(mergeAsyncUserInput(answered, reopened)).toBe(reopened);
  expect(mergeAsyncUserInput(reopened, answered)).toBe(reopened);
  const replacement = {
    ...answered,
    response: { ...answered.response, answers: ["B"] },
    responseSequence: 15,
  };
  expect(mergeAsyncUserInput(reopened, replacement)).toBe(replacement);
  expect(mergeAsyncUserInput(replacement, answered)).toBe(replacement);
});
