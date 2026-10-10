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

// A chip is an invitation to fill a setting — once the setting is filled the
// chip is noise. Fields the summary has not reported yet stay undefined and
// keep their chip visible.
export function visibleCoordinatorSuggestionChips(input: {
  readonly hasGoal: boolean | undefined;
  readonly instructionsConfigured: boolean | undefined;
  readonly linkedProjectCount: number;
}): readonly CoordinatorSuggestionChip[] {
  return COORDINATOR_SUGGESTION_CHIPS.filter((chip) => {
    if (chip === "Add a goal") return input.hasGoal !== true;
    if (chip === "Write instructions") return input.instructionsConfigured !== true;
    if (chip === "Connect repositories") return input.linkedProjectCount === 0;
    return true;
  });
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
