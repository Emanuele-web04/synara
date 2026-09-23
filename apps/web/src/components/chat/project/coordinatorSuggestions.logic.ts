import type { GroupSettingsSection } from "../group/groupSettingsDialog.logic";

export const COORDINATOR_SUGGESTION_CHIPS = [
  "Connect repositories",
  "Add a goal",
  "Write instructions",
] as const;

export type CoordinatorSuggestionChip = (typeof COORDINATOR_SUGGESTION_CHIPS)[number];

const COORDINATOR_SUGGESTION_SECTIONS: Record<CoordinatorSuggestionChip, GroupSettingsSection> = {
  "Connect repositories": "environment",
  "Add a goal": "general",
  "Write instructions": "memory",
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
