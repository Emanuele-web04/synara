import { describe, expect, it } from "vitest";

import { computeNextAutomationRunAt, computeNextAutomationRunAtAfter } from "./schedule.ts";

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
});
