import type { AutomationDefinition, AutomationSchedule } from "@synara/contracts";

/**
 * Lifecycle state of an automation, independent of any in-flight or unreviewed run. Single
 * source of truth shared by the list row meta and the detail Status pill so both surfaces agree
 * on when an automation is active, paused, scheduled, or done.
 */
export type AutomationLifecycleState = "active" | "paused" | "scheduled" | "done";

/** A "once" automation fires a single time; every other schedule recurs (or is manual). */
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

/**
 * Resolve an automation's lifecycle state from its schedule and enabled flag alone. One-time
 * automations are "scheduled" until they fire (enabled with a pending next run) and "done"
 * afterwards — they are never "paused". Recurring and manual automations are "active" or
 * "paused" depending on `enabled`.
 *
 * This deliberately ignores the latest run: live/triage run state is layered on top by the
 * surfaces that need it (the list dot color and row meta), not by the lifecycle itself.
 */
export function automationLifecycleState(
  definition: Pick<AutomationDefinition, "schedule" | "enabled" | "nextRunAt">,
): AutomationLifecycleState {
  if (isOneTimeSchedule(definition.schedule)) {
    return definition.enabled && definition.nextRunAt ? "scheduled" : "done";
  }
  return definition.enabled ? "active" : "paused";
}
