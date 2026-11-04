// FILE: profileFormatting.test.ts
// Purpose: Pins the heatmap tooltip date to the server's calendar-day key in any viewer time zone.
// Layer: web profile feature tests.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n, setLanguagePreference } from "~/i18n";
import { formatCompact, formatDays, formatNumber, formatShortDate } from "./profileFormatting";

afterEach(() => setLanguagePreference("system"));

describe("profile locale formatting", () => {
  it("refreshes existing date and number formatters when switching between English and Spanish", () => {
    for (const language of ["en", "es"] as const) {
      setLanguagePreference(language);
      expect(formatNumber(1234567)).toBe(
        new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(1234567),
      );
      expect(formatCompact(1234)).toBe(
        `${new Intl.NumberFormat(language, { maximumFractionDigits: 1, useGrouping: false }).format(1.2)}k`,
      );
      expect(formatShortDate("2026-04-03")).toBe(
        new Intl.DateTimeFormat(language, {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(new Date("2026-04-03T00:00:00Z")),
      );
    }
    setLanguagePreference("system");
    expect(formatNumber(1234567)).toBe(
      new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(1234567),
    );
  });

  it("localizes day labels while allowing an explicit regional formatter locale", () => {
    i18n.addResourceBundle("es", "translation", {
      "{{amount}} day": "{{amount}} día",
      "{{amount}} days": "{{amount}} días",
    });
    setLanguagePreference("es");
    expect(formatDays(1)).toBe("1 día");
    expect(formatDays(2)).toBe("2 días");
    expect(formatNumber(1234567, "en-IN")).toBe("12,34,567");
  });
});

// Day keys arrive as the user's local calendar day ("2026-04-03"); the label
// must name that same day whether the viewer sits west or east of UTC.
describe.each(["America/Los_Angeles", "Pacific/Kiritimati"])(
  "formatShortDate in %s",
  (timeZone) => {
    beforeAll(() => {
      vi.stubEnv("TZ", timeZone);
      vi.resetModules();
    });
    afterAll(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("labels a heatmap day key with that same calendar day", async () => {
      const { formatShortDate } = await import("./profileFormatting");
      const expected = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
      }).format(new Date(2026, 3, 3));

      expect(formatShortDate("2026-04-03")).toBe(expected);
    });
  },
);
