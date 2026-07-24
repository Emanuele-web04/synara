import { describe, expect, it } from "vitest";
import { AutomationId } from "@synara/contracts";

import {
  computeAutomationScheduleSpacingSeconds,
  computeNextAutomationRunAt,
  computeNextAutomationRunAtAfter,
  deterministicAutomationJitterSeconds,
} from "./schedule.ts";

// Render a UTC instant as "YYYY-MM-DD HH:MM" wall-clock in a timezone, so DST
// assertions check the local wall time rather than a hardcoded UTC offset.
function wallClockInZone(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    // Match the production timezoneFormatter (schedule.ts) exactly: hourCycle "h23"
    // pins midnight to 00:00, whereas hour12:false may resolve to "24:00" per ECMA-402.
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "??";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

describe("computeNextAutomationRunAt", () => {
  it("returns null for manual schedules", () => {
    expect(computeNextAutomationRunAt({ type: "manual" }, "2026-06-16T10:00:00.000Z")).toBeNull();
  });

  it("adds interval seconds", () => {
    expect(
      computeNextAutomationRunAt(
        { type: "interval", everySeconds: 300 },
        "2026-06-16T10:00:00.000Z",
      ),
    ).toBe("2026-06-16T10:05:00.000Z");
  });

  it("returns a future one-shot run time once", () => {
    expect(
      computeNextAutomationRunAt(
        { type: "once", runAt: "2026-06-16T10:00:15.000Z" },
        "2026-06-16T10:00:00.000Z",
      ),
    ).toBe("2026-06-16T10:00:15.000Z");
    expect(
      computeNextAutomationRunAt(
        { type: "once", runAt: "2026-06-16T10:00:00.000Z" },
        "2026-06-16T10:00:00.000Z",
      ),
    ).toBeNull();
  });

  it("uses the next UTC daily time", () => {
    expect(
      computeNextAutomationRunAt({ type: "daily", timeOfDay: "09:30" }, "2026-06-16T10:00:00.000Z"),
    ).toBe("2026-06-17T09:30:00.000Z");
  });

  it("uses the next UTC weekly day and time", () => {
    expect(
      computeNextAutomationRunAt(
        { type: "weekly", dayOfWeek: 2, timeOfDay: "09:30" },
        "2026-06-16T10:00:00.000Z",
      ),
    ).toBe("2026-06-23T09:30:00.000Z");
  });

  it("uses the next weekday slot within the same week", () => {
    // From Tue 10:00 the 09:30 slot has passed, so the next weekday slot is Wed 09:30.
    expect(
      computeNextAutomationRunAt(
        { type: "weekdays", timeOfDay: "09:30" },
        "2026-06-16T10:00:00.000Z",
      ),
    ).toBe("2026-06-17T09:30:00.000Z");
  });

  it("skips the weekend to the next Monday for weekday schedules", () => {
    // Fri 10:00 -> the next weekday 09:30 slot is Monday (Sat/Sun are skipped).
    expect(
      computeNextAutomationRunAt(
        { type: "weekdays", timeOfDay: "09:30" },
        "2026-06-19T10:00:00.000Z",
      ),
    ).toBe("2026-06-22T09:30:00.000Z");
  });

  it("skips the spring-forward gap for timezone-aware daily schedules", () => {
    // America/New_York springs forward 2026-03-08 02:00 -> 03:00, so 02:30 does
    // not exist that day. The gap day must be skipped to the next real 02:30.
    const next = computeNextAutomationRunAt(
      { type: "daily", timeOfDay: "02:30", timezone: "America/New_York" },
      "2026-03-08T05:00:00.000Z", // 2026-03-08 00:00 EST, before the missing slot
    );
    expect(next).toBe("2026-03-09T06:30:00.000Z"); // 02:30 EDT the next day
    expect(wallClockInZone(next!, "America/New_York")).toBe("2026-03-09 02:30");
  });

  it("fires a fall-back duplicate hour exactly once per day across both scheduling paths", () => {
    // America/New_York falls back 2026-11-01 02:00 -> 01:00, so 01:30 happens twice:
    // the first at 01:30 EDT (05:30Z) and the second at 01:30 EST (06:30Z). Assert the
    // exact UTC instant, not just the wall clock — both duplicates render "01:30" in the
    // zone, so a wall-clock-only check could not tell the first from the second.
    const first = computeNextAutomationRunAt(
      { type: "daily", timeOfDay: "01:30", timezone: "America/New_York" },
      "2026-11-01T04:00:00.000Z", // 2026-11-01 00:00 EDT, before either 01:30
    );
    expect(first).toBe("2026-11-01T05:30:00.000Z"); // the FIRST 01:30 (EDT), not 06:30Z
    // No wall-clock assertion on `first`: both duplicate-hour instants (05:30Z and 06:30Z)
    // render "01:30" in-zone, so wall clock cannot discriminate the first occurrence. The
    // UTC assertion above is the real check; `afterFirst` below uses wall clock where it differs.

    // The occurrence after the first 01:30 is the next day, not the second 01:30 on the
    // fall-back day (no double fire within the duplicated hour).
    const afterFirst = computeNextAutomationRunAt(
      { type: "daily", timeOfDay: "01:30", timezone: "America/New_York" },
      first!,
    );
    expect(afterFirst).toBe("2026-11-02T06:30:00.000Z"); // next day's 01:30 (EST), not the 2nd 01:30
    expect(wallClockInZone(afterFirst!, "America/New_York")).toBe("2026-11-02 01:30");

    // The dispatcher path (computeNextAutomationRunAtAfter with `now` inside the repeated
    // hour) must also skip the second same-day 01:30 rather than double-firing.
    const afterInRepeatedHour = computeNextAutomationRunAtAfter(
      { type: "daily", timeOfDay: "01:30", timezone: "America/New_York" },
      first!,
      "2026-11-01T05:45:00.000Z", // 01:45 EDT — still before the second 01:30 (06:30Z)
    );
    expect(afterInRepeatedHour).toBe("2026-11-02T06:30:00.000Z");
  });

  it("uses timezone-aware daily slots when timezone is present", () => {
    expect(
      computeNextAutomationRunAt(
        { type: "daily", timeOfDay: "09:30", timezone: "Europe/Rome" },
        "2026-06-16T06:00:00.000Z",
      ),
    ).toBe("2026-06-16T07:30:00.000Z");
  });

  it("computes constrained cron schedules", () => {
    expect(
      computeNextAutomationRunAt(
        { type: "cron", expression: "*/15 * * * *", timezone: "UTC" },
        "2026-06-16T10:00:00.000Z",
      ),
    ).toBe("2026-06-16T10:15:00.000Z");
  });

  it("uses standard cron OR semantics when day-of-month and day-of-week are both restricted", () => {
    expect(
      computeNextAutomationRunAt(
        { type: "cron", expression: "0 9 1 * 1", timezone: "UTC" },
        "2026-06-02T10:00:00.000Z",
      ),
    ).toBe("2026-06-08T09:00:00.000Z");
  });

  it("accepts 7 as Sunday in cron day-of-week fields", () => {
    expect(
      computeNextAutomationRunAt(
        { type: "cron", expression: "0 9 * * 7", timezone: "UTC" },
        "2026-06-21T08:00:00.000Z",
      ),
    ).toBe("2026-06-21T09:00:00.000Z");
  });

  it("accepts named cron day-of-week fields", () => {
    expect(
      computeNextAutomationRunAt(
        { type: "cron", expression: "0 9 * * SUN", timezone: "UTC" },
        "2026-06-21T08:00:00.000Z",
      ),
    ).toBe("2026-06-21T09:00:00.000Z");
    expect(
      computeNextAutomationRunAt(
        { type: "cron", expression: "0 9 * * MON-FRI", timezone: "UTC" },
        "2026-06-21T10:00:00.000Z",
      ),
    ).toBe("2026-06-22T09:00:00.000Z");
  });

  it("treats stepped cron day wildcards as restricted day fields", () => {
    expect(
      computeNextAutomationRunAt(
        { type: "cron", expression: "0 9 1 * */2", timezone: "UTC" },
        "2026-06-02T10:00:00.000Z",
      ),
    ).toBe("2026-06-04T09:00:00.000Z");
  });

  it("finds sparse cron schedules without scanning every minute", () => {
    expect(
      computeNextAutomationRunAt(
        { type: "cron", expression: "0 9 31 12 *", timezone: "UTC" },
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBe("2026-12-31T09:00:00.000Z");
  });

  it("returns null quickly when no cron occurrence exists within the constrained window", () => {
    expect(
      computeNextAutomationRunAt(
        { type: "cron", expression: "0 9 29 2 *", timezone: "UTC" },
        "2026-03-01T00:00:00.000Z",
      ),
    ).toBeNull();
  });

  it("rejects malformed cron field syntax instead of truncating it", () => {
    expect(() =>
      computeNextAutomationRunAt(
        { type: "cron", expression: "*/5/2 * * * *", timezone: "UTC" },
        "2026-06-16T10:00:00.000Z",
      ),
    ).toThrow(/bad step/);
    expect(() =>
      computeNextAutomationRunAt(
        { type: "cron", expression: "1-2-3 * * * *", timezone: "UTC" },
        "2026-06-16T10:00:00.000Z",
      ),
    ).toThrow(/out of range/);
    expect(() =>
      computeNextAutomationRunAt(
        { type: "cron", expression: "1x * * * *", timezone: "UTC" },
        "2026-06-16T10:00:00.000Z",
      ),
    ).toThrow(/out of range/);
    expect(() =>
      computeNextAutomationRunAt(
        { type: "cron", expression: "*/5x * * * *", timezone: "UTC" },
        "2026-06-16T10:00:00.000Z",
      ),
    ).toThrow(/bad step/);
  });
});

describe("computeNextAutomationRunAtAfter", () => {
  it("returns null for manual schedules", () => {
    expect(
      computeNextAutomationRunAtAfter(
        { type: "manual" },
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:11:00.000Z",
      ),
    ).toBeNull();
  });

  it("returns null after a one-shot occurrence is consumed", () => {
    expect(
      computeNextAutomationRunAtAfter(
        { type: "once", runAt: "2026-06-16T10:00:15.000Z" },
        "2026-06-16T10:00:15.000Z",
        "2026-06-16T10:00:15.000Z",
      ),
    ).toBeNull();
  });

  it("coalesces missed interval slots into a single future slot", () => {
    // 300s interval anchored at 10:00 would tick 10:05, 10:10, 10:15... With the
    // process down until 10:11, we must skip straight to 10:15 — not replay 10:05.
    expect(
      computeNextAutomationRunAtAfter(
        { type: "interval", everySeconds: 300 },
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:11:00.000Z",
      ),
    ).toBe("2026-06-16T10:15:00.000Z");
  });

  it("returns the immediate next interval slot when it is already future", () => {
    // The very next slot (10:05) is already after notBefore (10:00), so no coalescing.
    expect(
      computeNextAutomationRunAtAfter(
        { type: "interval", everySeconds: 300 },
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:00:00.000Z",
      ),
    ).toBe("2026-06-16T10:05:00.000Z");
  });

  it("coalesces more than a day of missed interval slots into one aligned slot", () => {
    // Hourly interval anchored at midnight, process down ~30h. We must land on the
    // first aligned slot after now (07:00 the next day), not replay ~30 backlog ticks.
    expect(
      computeNextAutomationRunAtAfter(
        { type: "interval", everySeconds: 3_600 },
        "2026-06-16T00:00:00.000Z",
        "2026-06-17T06:15:00.000Z",
      ),
    ).toBe("2026-06-17T07:00:00.000Z");
  });

  it("lands exactly on the next slot boundary, not the missed one", () => {
    // notBefore sits exactly on 10:05; the strictly-after slot is 10:10.
    expect(
      computeNextAutomationRunAtAfter(
        { type: "interval", everySeconds: 300 },
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:05:00.000Z",
      ),
    ).toBe("2026-06-16T10:10:00.000Z");
  });

  it("delegates daily schedules to the next future wall-clock slot", () => {
    expect(
      computeNextAutomationRunAtAfter(
        { type: "daily", timeOfDay: "09:30" },
        "2026-06-16T09:30:00.000Z",
        "2026-06-16T10:00:00.000Z",
      ),
    ).toBe("2026-06-17T09:30:00.000Z");
  });

  it("delegates weekly schedules to the next future wall-clock slot", () => {
    expect(
      computeNextAutomationRunAtAfter(
        { type: "weekly", dayOfWeek: 2, timeOfDay: "09:30" },
        "2026-06-16T09:30:00.000Z",
        "2026-06-16T10:00:00.000Z",
      ),
    ).toBe("2026-06-23T09:30:00.000Z");
  });

  it("delegates weekday schedules, skipping the weekend after downtime", () => {
    // Last fired Fri 09:30, back up after the weekend (Mon 08:00) -> next slot is Mon 09:30.
    expect(
      computeNextAutomationRunAtAfter(
        { type: "weekdays", timeOfDay: "09:30" },
        "2026-06-19T09:30:00.000Z",
        "2026-06-22T08:00:00.000Z",
      ),
    ).toBe("2026-06-22T09:30:00.000Z");
  });
});

describe("computeAutomationScheduleSpacingSeconds", () => {
  it("reports null for manual and one-shot schedules", () => {
    expect(
      computeAutomationScheduleSpacingSeconds({ type: "manual" }, "2026-06-16T10:00:00.000Z"),
    ).toBeNull();
    expect(
      computeAutomationScheduleSpacingSeconds(
        { type: "once", runAt: "2026-06-16T10:00:15.000Z" },
        "2026-06-16T10:00:00.000Z",
      ),
    ).toBeNull();
  });

  it("computes interval and cron spacing for policy validation", () => {
    expect(
      computeAutomationScheduleSpacingSeconds(
        { type: "interval", everySeconds: 300 },
        "2026-06-16T10:00:00.000Z",
      ),
    ).toBe(300);
    expect(
      computeAutomationScheduleSpacingSeconds(
        { type: "cron", expression: "* * * * *", timezone: "UTC" },
        "2026-06-16T10:00:00.000Z",
      ),
    ).toBe(60);
  });
});

describe("deterministic automation schedule jitter", () => {
  const context = {
    installSalt: "install-salt",
    automationId: AutomationId.makeUnsafe("automation-a"),
  };

  it("derives one stable 0-119 second phase offset per automation", () => {
    expect(deterministicAutomationJitterSeconds(context)).toBe(15);
    expect(deterministicAutomationJitterSeconds(context)).toBe(15);
    expect(
      deterministicAutomationJitterSeconds({
        ...context,
        automationId: AutomationId.makeUnsafe("automation-b"),
      }),
    ).toBe(38);
  });

  it("jitters wall-clock and cron occurrences", () => {
    expect(
      computeNextAutomationRunAt(
        { type: "daily", timeOfDay: "09:30" },
        "2026-06-16T10:00:00.000Z",
        context,
      ),
    ).toBe("2026-06-17T09:30:15.000Z");

    const cron = { type: "cron", expression: "30 9 * * *", timezone: "UTC" } as const;
    const unjittered = computeNextAutomationRunAt(cron, "2026-06-16T10:00:00.000Z");
    const jittered = computeNextAutomationRunAt(cron, "2026-06-16T10:00:00.000Z", context);
    expect(Date.parse(jittered!) - Date.parse(unjittered!)).toBeGreaterThanOrEqual(0);
    expect(Date.parse(jittered!) - Date.parse(unjittered!)).toBeLessThanOrEqual(119_000);
  });

  it("jitters dense cron occurrences", () => {
    const cron = { type: "cron", expression: "* * * * *", timezone: "UTC" } as const;

    const first = computeNextAutomationRunAt(cron, "2026-06-16T10:00:00.000Z", context);
    const second = computeNextAutomationRunAtAfter(cron, first!, first!, context);

    expect(first).toBe("2026-06-16T10:00:15.000Z");
    expect(second).toBe("2026-06-16T10:01:15.000Z");
    expect(Date.parse(second!) - Date.parse(first!)).toBe(60_000);
  });

  it("preserves dense cron cadence when jitter exceeds one minute", () => {
    const cron = { type: "cron", expression: "* * * * *", timezone: "UTC" } as const;
    const longJitterContext = {
      installSalt: "install-salt",
      automationId: AutomationId.makeUnsafe("automation-0"),
    };
    expect(deterministicAutomationJitterSeconds(longJitterContext)).toBe(93);

    const first = computeNextAutomationRunAt(cron, "2026-06-16T10:00:00.000Z", longJitterContext);
    const second = computeNextAutomationRunAtAfter(cron, first!, first!, longJitterContext);

    expect(first).toBe("2026-06-16T10:00:33.000Z");
    expect(second).toBe("2026-06-16T10:01:33.000Z");
    expect(Date.parse(second!) - Date.parse(first!)).toBe(60_000);
  });

  it("never jitters interval, once, or manual schedules", () => {
    expect(
      computeNextAutomationRunAt(
        { type: "interval", everySeconds: 300 },
        "2026-06-16T10:00:00.000Z",
        context,
      ),
    ).toBe("2026-06-16T10:05:00.000Z");
    expect(
      computeNextAutomationRunAt(
        { type: "once", runAt: "2026-06-16T10:05:00.000Z" },
        "2026-06-16T10:00:00.000Z",
        context,
      ),
    ).toBe("2026-06-16T10:05:00.000Z");
    expect(
      computeNextAutomationRunAt({ type: "manual" }, "2026-06-16T10:00:00.000Z", context),
    ).toBeNull();
  });
});
