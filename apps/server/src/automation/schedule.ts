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
