// FILE: profileFormatting.test.ts
// Purpose: Verify profile labels follow the system or an explicit regional number format.
// Layer: web profile feature tests.

import { describe, expect, it } from "vitest";
import { getFormatLocale } from "~/i18n";
import { formatCompact, formatNumber, formatShortDate } from "./profileFormatting";

describe("profile locale formatting", () => {
  it("formats dates and numbers with the system locale", () => {
    expect(formatNumber(1234567)).toBe(
      new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(1234567),
    );
    expect(formatCompact(1234)).toBe(
      `${new Intl.NumberFormat("en", { maximumFractionDigits: 1, useGrouping: false }).format(1.2)}k`,
    );
    expect(formatShortDate("2026-04-03")).toBe(
      new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(new Date("2026-04-03T00:00:00Z")),
    );
    expect(formatNumber(1234567)).toBe(
      new Intl.NumberFormat(getFormatLocale(), { maximumFractionDigits: 0 }).format(1234567),
    );
  });

  it("allows an explicit regional formatter locale", () => {
    expect(formatNumber(1234567, "en-IN")).toBe("12,34,567");
  });
});
