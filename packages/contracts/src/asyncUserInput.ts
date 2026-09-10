import { Schema } from "effect";
import { EventId, MessageId, TrimmedNonEmptyString } from "./baseSchemas";

export const CODEX_ASYNC_USER_INPUT_ACTIVITY_KIND = "user-input.async";

export const AsyncUserInputQuestion = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1)),
  options: Schema.NullOr(Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
});
export type AsyncUserInputQuestion = typeof AsyncUserInputQuestion.Type;

export const AsyncUserInputQuestions = Schema.Array(AsyncUserInputQuestion).check(
  Schema.isMinLength(1),
);

export const AsyncUserInputResponse = Schema.Struct({
  activityId: EventId,
  answers: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
});
export type AsyncUserInputResponse = typeof AsyncUserInputResponse.Type;

export const AsyncUserInputActivityPayload = Schema.Struct({
  questions: AsyncUserInputQuestions,
  response: Schema.optionalKey(
    Schema.Struct({
      answers: Schema.Array(TrimmedNonEmptyString),
      messageId: MessageId,
    }),
  ),
});
export type AsyncUserInputActivityPayload = typeof AsyncUserInputActivityPayload.Type;
