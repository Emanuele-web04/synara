export const COORDINATOR_SUGGESTION_CHIPS = [
  "Help me set up my code connection",
  "Add a goal",
  "Give me instructions",
] as const;

export function shouldShowCoordinatorSuggestions(input: {
  readonly isCoordinatorThread: boolean;
  readonly messages: ReadonlyArray<{ readonly role: string }>;
}): boolean {
  if (!input.isCoordinatorThread) {
    return false;
  }
  let userCount = 0;
  let assistantCount = 0;
  for (const message of input.messages) {
    if (message.role === "user") userCount += 1;
    if (message.role === "assistant") assistantCount += 1;
  }
  return userCount === 0 && assistantCount === 1;
}
