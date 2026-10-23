import type { StatsGetRecapInput } from "@synara/contracts";

export function resolveActivityDayStartMs(nowMs: number): number {
  const dayStart = new Date(nowMs);
  dayStart.setHours(4, 0, 0, 0);
  if (dayStart.getTime() > nowMs) dayStart.setDate(dayStart.getDate() - 1);
  return dayStart.getTime();
}

export type InboxSlotId = "morning" | "afternoon" | "evening";

const HOUR_MS = 3_600_000;

/** Slot start hours in local time; the working day itself starts with the morning. */
const INBOX_SLOT_START_HOURS: ReadonlyArray<{ id: InboxSlotId; label: string; hour: number }> = [
  { id: "morning", label: "Morning", hour: 4 },
  { id: "afternoon", label: "Afternoon", hour: 12 },
  { id: "evening", label: "Evening", hour: 18 },
];

export interface InboxTimeRange {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface InboxSlot extends InboxTimeRange {
  readonly id: InboxSlotId;
  readonly label: string;
}

export interface InboxDayRange extends InboxTimeRange {
  readonly slots: readonly InboxSlot[];
  /** Each hour of the day from its start (23 or 25 of them on a daylight-saving night). */
  readonly hours: readonly InboxTimeRange[];
}

export interface InboxDay extends InboxDayRange {
  readonly currentSlotId: InboxSlotId;
  /** The previous working day, for "this time yesterday" comparisons. */
  readonly previousDay: InboxDayRange;
}

function dayRange(dayStartMs: number): InboxDayRange {
  const at = (hour: number, dayOffset = 0) => {
    const date = new Date(dayStartMs);
    date.setDate(date.getDate() + dayOffset);
    date.setHours(hour, 0, 0, 0);
    return date.getTime();
  };
  const [first] = INBOX_SLOT_START_HOURS;
  const endMs = at(first?.hour ?? 4, 1);
  const slots = INBOX_SLOT_START_HOURS.map((slot, index) => {
    const next = INBOX_SLOT_START_HOURS[index + 1];
    return {
      id: slot.id,
      label: slot.label,
      fromMs: at(slot.hour),
      toMs: next ? at(next.hour) : endMs,
    };
  });
  // Real hours, not wall-clock ones: the repeated hour of a fall-back night is its own bar.
  const hours: InboxTimeRange[] = [];
  for (let fromMs = dayStartMs; fromMs < endMs; fromMs += HOUR_MS) {
    hours.push({ fromMs, toMs: Math.min(fromMs + HOUR_MS, endMs) });
  }
  return { fromMs: dayStartMs, toMs: endMs, slots, hours };
}

/**
 * The working day `nowMs` belongs to (4am to 4am, like the Activity view's Recent
 * section) split into morning, afternoon, and evening. Boundaries come from local
 * wall-clock hours, so a daylight-saving change only shortens or stretches a slot.
 */
export function resolveInboxDay(nowMs: number): InboxDay {
  const today = dayRange(resolveActivityDayStartMs(nowMs));
  const previousDayStart = new Date(today.fromMs);
  previousDayStart.setDate(previousDayStart.getDate() - 1);
  const currentSlot =
    today.slots.find((slot) => nowMs >= slot.fromMs && nowMs < slot.toMs) ?? today.slots.at(-1);
  return {
    ...today,
    currentSlotId: currentSlot?.id ?? "morning",
    previousDay: dayRange(previousDayStart.getTime()),
  };
}

/** The `stats.getRecap` request for a day, bucketed by hour. */
export function recapInputForRange(range: InboxDayRange): StatsGetRecapInput {
  return {
    from: new Date(range.fromMs).toISOString(),
    to: new Date(range.toMs).toISOString(),
    slotBoundaries: range.hours.slice(1).map((hour) => new Date(hour.fromMs).toISOString()),
  };
}
