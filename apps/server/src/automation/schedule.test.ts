import { describe, expect, it } from "vitest";

import {
  computeAutomationScheduleSpacingSeconds,
  computeNextAutomationRunAt,
  computeNextAutomationRunAtAfter,
} from "./schedule.ts";

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
