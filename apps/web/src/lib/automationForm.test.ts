// FILE: automationForm.test.ts
// Purpose: Locks down the inline schedule-field validators — the structural cron check and
// the IANA timezone check that gate commit-on-blur edits on the automation detail page.
// Layer: Web lib test

import { afterEach, describe, expect, it } from "vitest";
import { i18n, setLanguagePreference } from "~/i18n";

import {
  automationCronExpressionError,
  automationTimezoneError,
  formatCadence,
  formatDateTime,
  formatNextRun,
  weekdayLabel,
} from "./automationForm";

afterEach(() => setLanguagePreference("system"));

describe("automation locale formatting", () => {
  it("updates dates and weekdays without retaining the initial locale", () => {
    const runAt = "2026-10-02T12:28:00Z";
    for (const language of ["en", "es"] as const) {
      setLanguagePreference(language);
      expect(formatDateTime(runAt)).toBe(
        new Intl.DateTimeFormat(language, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(runAt)),
      );
      expect(weekdayLabel(1)).toBe(
        new Intl.DateTimeFormat(language, { weekday: "short", timeZone: "UTC" }).format(
          new Date("2026-10-05T00:00:00Z"),
        ),
      );
    }
  });

  it("translates cadence and upcoming run labels without changing schedule data", () => {
    i18n.addResourceBundle("es", "translation", {
      "Daily at {{time}}": "Cada día a las {{time}}",
      "in {{amount}} minutes": "dentro de {{amount}} minutos",
    });
    setLanguagePreference("es");
    expect(formatCadence({ type: "daily", timeOfDay: "09:00", timezone: "Europe/Madrid" })).toBe(
      "Cada día a las 9:00",
    );
    expect(formatNextRun("2026-10-02T12:05:00Z", Date.parse("2026-10-02T12:00:00Z"))).toBe(
      "dentro de 5 minutos",
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
