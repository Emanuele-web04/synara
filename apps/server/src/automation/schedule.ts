import type { AutomationSchedule } from "@t3tools/contracts";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function parseTimeOfDay(value: string) {
  const [hoursRaw = "0", minutesRaw = "0"] = value.split(":");
  return {
    hours: Number.parseInt(hoursRaw, 10),
    minutes: Number.parseInt(minutesRaw, 10),
  };
}

export function computeNextAutomationRunAt(
  schedule: AutomationSchedule,
  fromIso: string,
): string | null {
  if (schedule.type === "manual") {
    return null;
  }

  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) {
    throw new Error(`Invalid automation schedule timestamp: ${fromIso}`);
  }

  if (schedule.type === "interval") {
    return new Date(from.getTime() + schedule.everySeconds * 1000).toISOString();
  }

  const { hours, minutes } = parseTimeOfDay(schedule.timeOfDay);
  const candidate = new Date(from);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCHours(hours, minutes, 0, 0);

  if (schedule.type === "daily") {
    if (candidate.getTime() <= from.getTime()) {
      candidate.setTime(candidate.getTime() + DAY_MS);
    }
    return candidate.toISOString();
  }

  const daysUntilTarget = (schedule.dayOfWeek - candidate.getUTCDay() + 7) % 7;
  candidate.setTime(candidate.getTime() + daysUntilTarget * DAY_MS);
  if (candidate.getTime() <= from.getTime()) {
    candidate.setTime(candidate.getTime() + 7 * DAY_MS);
  }
  return candidate.toISOString();
}

/**
 * Compute the next run that is strictly after `notBeforeIso`, coalescing any missed
 * occurrences after downtime into a single future slot instead of replaying every one.
 * For interval schedules this fast-forwards past all elapsed intervals; daily/weekly
 * schedules are naturally coalesced because they resolve to the next wall-clock slot.
 */
export function computeNextAutomationRunAtAfter(
  schedule: AutomationSchedule,
  fromIso: string,
  notBeforeIso: string,
): string | null {
  if (schedule.type === "manual") {
    return null;
  }

  if (schedule.type === "interval") {
    const from = new Date(fromIso);
    if (Number.isNaN(from.getTime())) {
      throw new Error(`Invalid automation schedule timestamp: ${fromIso}`);
    }
    const notBefore = Date.parse(notBeforeIso);
    const floor = Number.isFinite(notBefore) ? notBefore : from.getTime();
    const stepMs = schedule.everySeconds * 1000;
    let next = from.getTime() + stepMs;
    if (next <= floor) {
      // Jump straight to the first slot after the floor rather than looping per interval.
      const missed = Math.ceil((floor - next + 1) / stepMs);
      next += missed * stepMs;
    }
    return new Date(next).toISOString();
  }

  return computeNextAutomationRunAt(schedule, notBeforeIso);
}
