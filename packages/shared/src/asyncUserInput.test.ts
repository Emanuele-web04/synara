import { expect, it } from "vitest";
import { canRespondToAsyncUserInput, isPendingAsyncUserInputActivity } from "./asyncUserInput";

it("allows async responses only on session-owning tasks", () => {
  expect(canRespondToAsyncUserInput({ id: "root" })).toBe(true);
  expect(canRespondToAsyncUserInput({ id: "child", parentThreadId: "root" })).toBe(false);
  expect(canRespondToAsyncUserInput({ id: "subagent:root:child" })).toBe(false);
});

it("retains valid unanswered cards, not malformed or settled activity", () => {
  const pending = {
    kind: "user-input.async",
    payload: { questions: [{ title: "Which?", options: null }] },
  };
  expect(isPendingAsyncUserInputActivity(pending)).toBe(true);
  expect(isPendingAsyncUserInputActivity({ ...pending, payload: {} })).toBe(false);
  expect(
    isPendingAsyncUserInputActivity({
      ...pending,
      payload: {
        ...pending.payload,
        response: { answers: ["A"], messageId: "answer" },
      },
    }),
  ).toBe(false);
});
