import type { AutomationDefinition, AutomationSchedule } from "@synara/contracts";

// single source shared by the list row meta and the detail Status pill so both surfaces agree on active/paused/scheduled/done
export type AutomationLifecycleState = "active" | "paused" | "scheduled" | "done";

export function isOneTimeSchedule(schedule: AutomationSchedule): boolean {
  return schedule.type === "once";
}

/**
 * Pause/resume only gates a recurring schedule. A one-time automation is a single shot, so once
 * it exists there is nothing to pause — it just runs and is done.
 */
export function canPauseAutomation(definition: Pick<AutomationDefinition, "schedule">): boolean {
  return !isOneTimeSchedule(definition.schedule);
}

// resolve lifecycle from schedule + enabled alone — deliberately ignores the latest run; live/triage run state is layered on top by the surfaces that need it
export function automationLifecycleState(
  definition: Pick<AutomationDefinition, "schedule" | "enabled" | "nextRunAt">,
): AutomationLifecycleState {
  if (isOneTimeSchedule(definition.schedule)) {
    return definition.enabled && definition.nextRunAt ? "scheduled" : "done";
  }
  return definition.enabled ? "active" : "paused";
}
