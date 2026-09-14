import type { AsyncUserInputQuestions } from "@synara/contracts";

export const ASYNC_USER_INPUT_ALREADY_ANSWERED =
  "This asynchronous question has already been answered.";

export function formatAsyncUserInputResponse(
  questions: AsyncUserInputQuestions,
  answers: readonly string[],
): string {
  return questions
    .map((question, index) => `${question.title}\n${answers[index] ?? ""}`)
    .join("\n\n");
}
