import type { AsyncUserInput, AsyncUserInputQuestions } from "@synara/contracts";

export const ASYNC_USER_INPUT_ALREADY_ANSWERED =
  "This asynchronous question has already been answered.";

export function mergeAsyncUserInput(
  previous: AsyncUserInput,
  incoming: AsyncUserInput | undefined,
): AsyncUserInput;
export function mergeAsyncUserInput(
  previous: AsyncUserInput | undefined,
  incoming: AsyncUserInput | undefined,
): AsyncUserInput | undefined;
export function mergeAsyncUserInput(
  previous: AsyncUserInput | undefined,
  incoming: AsyncUserInput | undefined,
): AsyncUserInput | undefined {
  if (!previous) return incoming;
  if (!incoming) return previous;
  const previousSequence = previous.responseSequence ?? 0;
  const incomingSequence = incoming.responseSequence ?? 0;
  if (previousSequence > incomingSequence) return previous;
  if (incomingSequence > previousSequence) return incoming;
  // legacy snapshots have no sequence — retain an already accepted answer
  return previous.response ? previous : incoming;
}

// only use on deliberate history removal, before applying transcript size caps
export function clearRemovedAsyncUserInputResponses<
  T extends { readonly asyncUserInput?: AsyncUserInput | undefined },
>(messages: ReadonlyArray<T>, retainedMessageIds: ReadonlySet<string>, sequence: number): T[] {
  return messages.map((message) => {
    const input = message.asyncUserInput;
    if (!input?.response || retainedMessageIds.has(input.response.messageId)) return message;
    return {
      ...message,
      asyncUserInput: { questions: input.questions, responseSequence: sequence },
    };
  });
}

export function formatAsyncUserInputResponse(
  questions: AsyncUserInputQuestions,
  answers: readonly string[],
): string {
  return questions
    .map((question, index) => `${question.title}\n${answers[index] ?? ""}`)
    .join("\n\n");
}
