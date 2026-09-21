import type { GroupSettingsSection } from "../group/groupSettingsDialog.logic";

export const COORDINATOR_SUGGESTION_CHIPS = [
  "Help me set up my code connection",
  "Add a goal",
  "Give me instructions",
] as const;

export type CoordinatorSuggestionChip = (typeof COORDINATOR_SUGGESTION_CHIPS)[number];

const COORDINATOR_SUGGESTION_SECTIONS: Record<CoordinatorSuggestionChip, GroupSettingsSection> = {
  "Help me set up my code connection": "environment",
  "Add a goal": "general",
  "Give me instructions": "memory",
};

export function coordinatorSuggestionSection(label: string): GroupSettingsSection {
  return COORDINATOR_SUGGESTION_SECTIONS[label as CoordinatorSuggestionChip] ?? "general";
}

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
