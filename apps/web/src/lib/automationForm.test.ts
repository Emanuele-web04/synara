// FILE: automationForm.test.ts
// Purpose: Locks down the inline schedule-field validators — the structural cron check and
// the IANA timezone check that gate commit-on-blur edits on the automation detail page.
// Layer: Web lib test

import { describe, expect, it } from "vitest";

import {
  automationCronExpressionError,
  automationTimezoneError,
  formatDateTime,
  weekdayLabel,
} from "./automationForm";

describe("automation date formatting", () => {
  it("formats dates and English weekdays", () => {
    const runAt = "2026-10-02T12:28:00Z";
    expect(formatDateTime(runAt)).toBe(
      new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(runAt)),
    );
    expect(weekdayLabel(1)).toBe(
      new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" }).format(
        new Date("2026-10-05T00:00:00Z"),
      ),
    );
  });
});

describe("automationCronExpressionError", () => {
  it("accepts structurally valid 5-field expressions", () => {
    expect(automationCronExpressionError("* * * * *")).toBeNull();
    expect(automationCronExpressionError("*/15 9-17 * * 1-5")).toBeNull();
    expect(automationCronExpressionError("0 0 1,15 * *")).toBeNull();
    expect(automationCronExpressionError("  30 4 * * 0  ")).toBeNull();
  });

  it("rejects the wrong field count", () => {
    expect(automationCronExpressionError("")).not.toBeNull();
    expect(automationCronExpressionError("* * * *")).not.toBeNull();
    expect(automationCronExpressionError("* * * * * *")).not.toBeNull();
  });

  it("rejects fields with characters outside the cron vocabulary", () => {
    expect(automationCronExpressionError("every 5 min * *")).not.toBeNull();
    expect(automationCronExpressionError("0 0 * * MON")).not.toBeNull();
  });
});

describe("automationTimezoneError", () => {
  it("accepts real IANA zones", () => {
    expect(automationTimezoneError("Europe/Rome")).toBeNull();
    expect(automationTimezoneError("UTC")).toBeNull();
    expect(automationTimezoneError("  America/New_York  ")).toBeNull();
  });

  it("rejects an empty value — committing it would unrender the row for good", () => {
    expect(automationTimezoneError("")).toBe("Add a timezone");
    expect(automationTimezoneError("   ")).toBe("Add a timezone");
  });

  it("rejects unknown zones", () => {
    expect(automationTimezoneError("Europe/Atlantis")).toBe("Unknown timezone");
    expect(automationTimezoneError("not a zone")).toBe("Unknown timezone");
  });
});
