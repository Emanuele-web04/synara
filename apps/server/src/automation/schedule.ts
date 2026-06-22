import type { AutomationSchedule } from "@t3tools/contracts";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_CRON_SEARCH_DAYS = 366;
const TIMEZONE_FORMATTER_CACHE_LIMIT = 64;

const timezoneFormatterCache = new Map<string, Intl.DateTimeFormat>();

function parseTimeOfDay(value: string) {
  const [hoursRaw = "0", minutesRaw = "0"] = value.split(":");
  return {
    hours: Number.parseInt(hoursRaw, 10),
    minutes: Number.parseInt(minutesRaw, 10),
  };
}

function formatTimeOfDay(hours: number, minutes: number): string {
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function requireValidDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid automation schedule ${label}: ${value}`);
  }
  return date;
}

function timezoneFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = timezoneFormatterCache.get(timezone);
  if (cached) {
    return cached;
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatter.format(new Date());
  } catch {
    throw new Error(`Invalid automation schedule timezone: ${timezone}`);
  }
  if (timezoneFormatterCache.size >= TIMEZONE_FORMATTER_CACHE_LIMIT) {
    const oldestKey = timezoneFormatterCache.keys().next().value;
    if (oldestKey) {
      timezoneFormatterCache.delete(oldestKey);
    }
  }
  timezoneFormatterCache.set(timezone, formatter);
  return formatter;
}

function assertValidTimezone(timezone: string): void {
  timezoneFormatter(timezone);
}

function localPartsFor(date: Date, timezone: string) {
  const parts = timezoneFormatter(timezone).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number.parseInt(byType.get("year") ?? "0", 10),
    month: Number.parseInt(byType.get("month") ?? "0", 10),
    day: Number.parseInt(byType.get("day") ?? "0", 10),
    hour: Number.parseInt(byType.get("hour") ?? "0", 10),
    minute: Number.parseInt(byType.get("minute") ?? "0", 10),
    second: Number.parseInt(byType.get("second") ?? "0", 10),
  };
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const parts = localPartsFor(date, timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - date.getTime();
}

// Resolve a local wall-clock slot in an IANA timezone to UTC. We verify the round-trip
// so DST gaps are skipped instead of scheduling at a surprising nearby instant.
function zonedWallClockToUtc(input: {
  readonly timezone: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly timeOfDay: string;
}): Date | null {
  const { hours, minutes } = parseTimeOfDay(input.timeOfDay);
  const naiveUtcMs = Date.UTC(input.year, input.month - 1, input.day, hours, minutes, 0, 0);
  const firstPass = new Date(naiveUtcMs - timezoneOffsetMs(new Date(naiveUtcMs), input.timezone));
  const secondPass = new Date(naiveUtcMs - timezoneOffsetMs(firstPass, input.timezone));
  const roundTrip = localPartsFor(secondPass, input.timezone);
  return roundTrip.year === input.year &&
    roundTrip.month === input.month &&
    roundTrip.day === input.day &&
    roundTrip.hour === hours &&
    roundTrip.minute === minutes
    ? secondPass
    : null;
}

function addLocalDays(
  parts: { readonly year: number; readonly month: number; readonly day: number },
  days: number,
) {
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0, 0));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

function dayOfWeekForLocalDate(input: {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}) {
  return new Date(Date.UTC(input.year, input.month - 1, input.day, 12, 0, 0, 0)).getUTCDay();
}

function computeNextZonedWallClockRunAt(
  schedule: Extract<AutomationSchedule, { type: "daily" | "weekdays" | "weekly" }>,
  from: Date,
): string | null {
  const timezone = schedule.timezone;
  if (!timezone) {
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

    if (schedule.type === "weekdays") {
      // Advance day-by-day until the slot is in the future and lands on a weekday (Mon-Fri).
      while (
        candidate.getTime() <= from.getTime() ||
        candidate.getUTCDay() === 0 ||
        candidate.getUTCDay() === 6
      ) {
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

  const localStart = localPartsFor(from, timezone);
  for (let offset = 0; offset <= 370; offset += 1) {
    const localDate = addLocalDays(localStart, offset);
    const localDow = dayOfWeekForLocalDate(localDate);
    if (schedule.type === "weekdays" && (localDow === 0 || localDow === 6)) {
      continue;
    }
    if (schedule.type === "weekly" && localDow !== schedule.dayOfWeek) {
      continue;
    }
    const candidate = zonedWallClockToUtc({
      timezone,
      ...localDate,
      timeOfDay: schedule.timeOfDay,
    });
    if (candidate && candidate.getTime() > from.getTime()) {
      return candidate.toISOString();
    }
  }
  return null;
}

interface CronField {
  readonly values: ReadonlySet<number>;
  readonly isWildcard: boolean;
}

function sortedCronValues(field: CronField): readonly number[] {
  return Array.from(field.values).toSorted((left, right) => left - right);
}

function parseCronInteger(
  raw: string | undefined,
  name: string,
  errorReason: "bad step" | "out of range",
): number {
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error(`Invalid cron ${name}: ${errorReason}`);
  }
  return Number(raw);
}

function parseCronField(raw: string, min: number, max: number, name: string): CronField {
  const values = new Set<number>();
  let isWildcard = false;
  for (const token of raw.split(",")) {
    const part = token.trim();
    if (!part) {
      throw new Error(`Invalid cron ${name}: empty token`);
    }
    const stepParts = part.split("/");
    if (stepParts.length > 2) {
      throw new Error(`Invalid cron ${name}: bad step`);
    }
    const [rangePart = "", stepPart] = stepParts;
    const step = stepPart === undefined ? 1 : parseCronInteger(stepPart, name, "bad step");
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron ${name}: bad step`);
    }
    // Only a literal `*` is unrestricted for DOM/DOW cron semantics; `*/2` is still a filter.
    if (rangePart === "*" && stepPart === undefined) {
      isWildcard = true;
    }
    const rangeParts = rangePart === "*" ? [String(min), String(max)] : rangePart.split("-");
    if (rangeParts.length > 2) {
      throw new Error(`Invalid cron ${name}: out of range`);
    }
    const [startRaw, endRaw] = rangeParts;
    const start = parseCronInteger(startRaw, name, "out of range");
    const end = parseCronInteger(endRaw ?? startRaw, name, "out of range");
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      throw new Error(`Invalid cron ${name}: out of range`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return { values, isWildcard };
}

function parseCronExpression(expression: string) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("Cron schedules must use a constrained 5-field expression.");
  }
  return {
    minute: parseCronField(fields[0] ?? "", 0, 59, "minute"),
    hour: parseCronField(fields[1] ?? "", 0, 23, "hour"),
    dayOfMonth: parseCronField(fields[2] ?? "", 1, 31, "day-of-month"),
    month: parseCronField(fields[3] ?? "", 1, 12, "month"),
    dayOfWeek: parseCronField(fields[4] ?? "", 0, 6, "day-of-week"),
  };
}

function cronDayMatches(
  cron: ReturnType<typeof parseCronExpression>,
  parts: { readonly year: number; readonly month: number; readonly day: number },
): boolean {
  const dayOfMonthMatches = cron.dayOfMonth.values.has(parts.day);
  const dayOfWeekMatches = cron.dayOfWeek.values.has(dayOfWeekForLocalDate(parts));
  if (cron.dayOfMonth.isWildcard || cron.dayOfWeek.isWildcard) {
    return dayOfMonthMatches && dayOfWeekMatches;
  }
  return dayOfMonthMatches || dayOfWeekMatches;
}

function computeNextCronRunAt(
  schedule: Extract<AutomationSchedule, { type: "cron" }>,
  from: Date,
): string | null {
  assertValidTimezone(schedule.timezone);
  const cron = parseCronExpression(schedule.expression);
  const localStart = localPartsFor(from, schedule.timezone);
  const hours = sortedCronValues(cron.hour);
  const minutes = sortedCronValues(cron.minute);

  // Search by local calendar slots instead of UTC minutes. Sparse cron expressions can be
  // months away, so minute-by-minute timezone formatting would block validation for seconds.
  for (let dayOffset = 0; dayOffset <= MAX_CRON_SEARCH_DAYS; dayOffset += 1) {
    const localDate = addLocalDays(localStart, dayOffset);
    if (!cron.month.values.has(localDate.month) || !cronDayMatches(cron, localDate)) {
      continue;
    }

    for (const hour of hours) {
      if (dayOffset === 0 && hour < localStart.hour) {
        continue;
      }
      for (const minute of minutes) {
        if (dayOffset === 0 && hour === localStart.hour && minute <= localStart.minute) {
          continue;
        }
        const candidate = zonedWallClockToUtc({
          timezone: schedule.timezone,
          ...localDate,
          timeOfDay: formatTimeOfDay(hour, minute),
        });
        if (candidate && candidate.getTime() > from.getTime()) {
          return candidate.toISOString();
        }
      }
    }
  }
  return null;
}

export function computeNextAutomationRunAt(
  schedule: AutomationSchedule,
  fromIso: string,
): string | null {
  if (schedule.type === "manual") {
    return null;
  }

  const from = requireValidDate(fromIso, "timestamp");

  if (schedule.type === "once") {
    const runAt = requireValidDate(schedule.runAt, "runAt");
    return runAt.getTime() > from.getTime() ? runAt.toISOString() : null;
  }

  if (schedule.type === "interval") {
    return new Date(from.getTime() + schedule.everySeconds * 1000).toISOString();
  }

  if (schedule.type === "cron") {
    return computeNextCronRunAt(schedule, from);
  }

  return computeNextZonedWallClockRunAt(schedule, from);
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

  if (schedule.type === "once") {
    return null;
  }

  if (schedule.type === "interval") {
    const from = requireValidDate(fromIso, "timestamp");
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

/**
 * Estimate the spacing between the next two occurrences from a fixed point. This is used
 * for policy validation, not for dispatch, so one-shot/manual schedules return null.
 */
export function computeAutomationScheduleSpacingSeconds(
  schedule: AutomationSchedule,
  fromIso: string,
): number | null {
  if (schedule.type === "manual" || schedule.type === "once") {
    return null;
  }
  const first = computeNextAutomationRunAt(schedule, fromIso);
  if (first === null) {
    return null;
  }
  const second = computeNextAutomationRunAtAfter(schedule, first, first);
  if (second === null) {
    return null;
  }
  const spacingMs = Date.parse(second) - Date.parse(first);
  return Number.isFinite(spacingMs) && spacingMs > 0 ? spacingMs / 1000 : null;
}
