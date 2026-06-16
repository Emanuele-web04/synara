import { describe, expect, it } from "vitest";

import { computeNextAutomationRunAt } from "./schedule.ts";

describe("computeNextAutomationRunAt", () => {
  it("returns null for manual schedules", () => {
    expect(
      computeNextAutomationRunAt({ type: "manual" }, "2026-06-16T10:00:00.000Z"),
    ).toBeNull();
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
      computeNextAutomationRunAt(
        { type: "daily", timeOfDay: "09:30" },
        "2026-06-16T10:00:00.000Z",
      ),
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
