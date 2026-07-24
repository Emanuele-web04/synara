// FILE: proposalActivity.ts
// Purpose: Builds the durable transcript activity for an automation proposal lifecycle.

import {
  EventId,
  type AutomationDefinition,
  type AutomationProposalState,
  type AutomationSchedule,
} from "@synara/contracts";

export function automationProposalActivityId(automationId: AutomationDefinition["id"]): EventId {
  return EventId.makeUnsafe(`automation-proposal:${automationId}`);
}

export function automationCadenceLabel(schedule: AutomationSchedule): string {
  switch (schedule.type) {
    case "manual":
      return "Manual";
    case "once":
      return `Once ${schedule.runAt}`;
    case "interval":
      return schedule.everySeconds % 60 === 0
        ? `Every ${schedule.everySeconds / 60}m`
        : `Every ${schedule.everySeconds}s`;
    case "daily":
      return `Daily at ${schedule.timeOfDay}`;
    case "weekdays":
      return `Weekdays at ${schedule.timeOfDay}`;
    case "weekly":
      return `Weekly on day ${schedule.dayOfWeek} at ${schedule.timeOfDay}`;
    case "cron":
      return `Cron ${schedule.expression}`;
  }
}

export function buildAutomationProposalActivity(input: {
  readonly definition: AutomationDefinition;
  readonly proposalState: AutomationProposalState;
}) {
  const { definition, proposalState } = input;
  const stateLabel =
    proposalState === "pending"
      ? "Suggested"
      : proposalState === "accepted"
        ? "Accepted"
        : "Dismissed";
  return {
    id: automationProposalActivityId(definition.id),
    tone: "info" as const,
    kind: "automation.created",
    summary: `${stateLabel} automation: ${definition.name}`,
    payload: {
      source: "agent-gateway",
      automationId: definition.id,
      automationName: definition.name,
      mode: definition.mode,
      cadenceLabel: automationCadenceLabel(definition.schedule),
      proposalState,
    },
    turnId: null,
    createdAt: definition.createdAt,
  };
}
