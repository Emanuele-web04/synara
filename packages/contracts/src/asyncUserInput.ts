import { Schema } from "effect";
import { MessageId, TrimmedNonEmptyString } from "./baseSchemas";

// These questions are transcript content. They have no pending JSON-RPC reply
// and their answers are ordinary user messages, even after the turn completes.
export const AsyncUserInputQuestion = Schema.Struct({
  title: TrimmedNonEmptyString,
  options: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1))),
});
export const AsyncUserInputQuestions = Schema.Array(AsyncUserInputQuestion).check(
  Schema.isMinLength(1),
);
export type AsyncUserInputQuestions = typeof AsyncUserInputQuestions.Type;

export const AsyncUserInputResponse = Schema.Struct({
  messageId: MessageId,
  answers: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
});
export type AsyncUserInputResponse = typeof AsyncUserInputResponse.Type;

export const AsyncUserInput = Schema.Struct({
  questions: AsyncUserInputQuestions,
  response: Schema.optional(AsyncUserInputResponse),
});
export type AsyncUserInput = typeof AsyncUserInput.Type;
