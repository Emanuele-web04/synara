import { describe, expect, it } from "vitest";

import { formatDayAwareTimestamp, formatShortTimestamp } from "./timestampFormat";

// ISO strings built from local wall-clock components so expectations are stable across runner timezones
function localIso(
  year: number,
  monthIndex: number,
  day: number,
  hours: number,
  minutes: number,
): string {
  return new Date(year, monthIndex, day, hours, minutes).toISOString();
}

describe("formatDayAwareTimestamp", () => {
  const now = new Date(2026, 2, 17, 23, 0);

  it("shows only the clock time for same-day messages", () => {
    const isoDate = localIso(2026, 2, 17, 9, 5);
    expect(formatDayAwareTimestamp(isoDate, "24-hour", now)).toBe(
      formatShortTimestamp(isoDate, "24-hour"),
    );
  });

  it("prefixes the weekday name for messages from earlier this week", () => {
    const isoDate = localIso(2026, 2, 16, 23, 59);
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(
      new Date(isoDate),
    );
    expect(formatDayAwareTimestamp(isoDate, "24-hour", now)).toBe(
      `${weekday} ${formatShortTimestamp(isoDate, "24-hour")}`,
    );
  });

  it("uses the weekday name up to six calendar days back", () => {
    const isoDate = localIso(2026, 2, 11, 8, 30);
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(
      new Date(isoDate),
    );
    expect(formatDayAwareTimestamp(isoDate, "24-hour", now)).toBe(
      `${weekday} ${formatShortTimestamp(isoDate, "24-hour")}`,
    );
  });

  it("switches to a short date once the weekday name becomes ambiguous", () => {
    const isoDate = localIso(2026, 2, 10, 8, 30);
    const dayLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
      new Date(isoDate),
    );
    expect(formatDayAwareTimestamp(isoDate, "24-hour", now)).toBe(
      `${dayLabel} ${formatShortTimestamp(isoDate, "24-hour")}`,
    );
  });

  it("includes the year for messages from another year", () => {
    const isoDate = localIso(2025, 11, 31, 18, 45);
    const dayLabel = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(isoDate));
    expect(formatDayAwareTimestamp(isoDate, "24-hour", now)).toBe(
      `${dayLabel} ${formatShortTimestamp(isoDate, "24-hour")}`,
    );
  });

  it("dates future days instead of borrowing a weekday name", () => {
    const isoDate = localIso(2026, 2, 19, 10, 0);
    const dayLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
      new Date(isoDate),
    );
    expect(formatDayAwareTimestamp(isoDate, "24-hour", now)).toBe(
      `${dayLabel} ${formatShortTimestamp(isoDate, "24-hour")}`,
    );
  });
});
