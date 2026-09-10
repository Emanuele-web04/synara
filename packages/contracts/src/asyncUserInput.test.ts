import { Schema } from "effect";
import { expect, it } from "vitest";

import { AsyncUserInputActivityPayload } from "./asyncUserInput";

it("keeps pending and answered async question payloads JSON-compatible", () => {
  const questions = [{ title: "Which approach?", options: null }];
  const response = { answers: ["A"], messageId: "answer-1" };
  const isPayload = Schema.is(AsyncUserInputActivityPayload);

  expect(isPayload({ questions })).toBe(true);
  expect(isPayload({ questions, response })).toBe(true);
  expect(isPayload({ questions, response: undefined })).toBe(false);
});
