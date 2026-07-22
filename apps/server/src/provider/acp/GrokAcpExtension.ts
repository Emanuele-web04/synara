import type { ProviderUserInputAnswers, UserInputQuestion } from "@synara/contracts";
import { Schema } from "effect";

export const GROK_ASK_USER_QUESTION_METHODS = [
  "_x.ai/ask_user_question",
  "x.ai/ask_user_question",
] as const;

const GrokQuestionOption = Schema.Struct({
  label: Schema.String,
  description: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  preview: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});

const GrokQuestion = Schema.Struct({
  question: Schema.String,
  options: Schema.Array(GrokQuestionOption),
  label: Schema.optional(Schema.String),
  description: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  preview: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  multiSelect: Schema.optional(Schema.Boolean),
});

export const GrokAskUserQuestionRequest = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  questions: Schema.Array(GrokQuestion),
  mode: Schema.optional(Schema.String),
});

export function extractGrokUserInputQuestions(
  request: typeof GrokAskUserQuestionRequest.Type,
): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: `grok-question-${index}`,
    header: question.label?.trim() || "Question",
    question: question.question,
    multiSelect: question.multiSelect === true,
    options:
      question.options.length > 0
        ? question.options.map((option) => ({
            label: option.label,
            description: option.description?.trim() || option.label,
          }))
        : [{ label: "OK", description: "Continue" }],
  }));
}

export function makeGrokQuestionResponse(
  request: typeof GrokAskUserQuestionRequest.Type,
  answers: ProviderUserInputAnswers,
):
  | {
      readonly outcome: "accepted";
      readonly answers: Record<string, ReadonlyArray<string>>;
      readonly annotations: Record<string, never>;
    }
  | { readonly outcome: "cancelled" } {
  const acceptedAnswers: Record<string, ReadonlyArray<string>> = {};
  request.questions.forEach((question, index) => {
    const answer = answers[`grok-question-${index}`];
    const values = (Array.isArray(answer) ? answer : [answer])
      .flatMap((value) => (typeof value === "string" ? [value.trim()] : []))
      .filter((value) => value.length > 0);
    if (values.length > 0) {
      acceptedAnswers[question.question] = values;
    }
  });
  return Object.keys(acceptedAnswers).length === 0
    ? { outcome: "cancelled" }
    : { outcome: "accepted", answers: acceptedAnswers, annotations: {} };
}

/**
 * Grok Build's reverse ACP request for handing a completed native plan to the
 * client. Grok currently prefixes xAI extension methods with `_` on the wire,
 * while older builds used the bare method name, so the adapter accepts both.
 */
export const GROK_EXIT_PLAN_MODE_METHODS = [
  "_x.ai/exit_plan_mode",
  "x.ai/exit_plan_mode",
] as const;

export const GrokExitPlanModeRequest = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  planContent: Schema.NullOr(Schema.String),
});

const SYNARA_PLAN_REVIEW_FEEDBACK =
  "Synara captured this plan for user review. Do not revise or implement it now. End this turn and wait for the user's next message.";

export function extractGrokExitPlanMarkdown(
  request: typeof GrokExitPlanModeRequest.Type,
): string | undefined {
  const planMarkdown = request.planContent?.trim();
  return planMarkdown && planMarkdown.length > 0 ? planMarkdown : undefined;
}

/**
 * Synara owns the approval step after the planning turn settles. Returning a
 * semantic cancellation keeps Grok's native plan-mode write gate active and
 * avoids both auto-implementation and Grok's misleading client-disconnect path.
 */
export function makeGrokExitPlanModeCapturedResponse(): {
  readonly outcome: "cancelled";
  readonly feedback: string;
} {
  return {
    outcome: "cancelled",
    feedback: SYNARA_PLAN_REVIEW_FEEDBACK,
  };
}
