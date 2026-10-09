// FILE: formatting.test.ts
// Purpose: Covers the pure profile display formatters.
// Layer: profile-ui tests.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  formatCompact,
  formatDays,
  formatNumber,
  formatShortDate,
  normalizeHandle,
  toDisplayName,
} from "./formatting";

describe("formatCompact", () => {
  it("formats billions, millions, and thousands with trimmed decimals", () => {
    expect(formatCompact(17_000_000_000)).toBe("17bn");
    expect(formatCompact(538_000_000)).toBe("538m");
    expect(formatCompact(1_200)).toBe("1.2k");
    expect(formatCompact(950)).toBe("950");
  });

  it("returns an em dash for missing or non-finite values", () => {
    expect(formatCompact(null)).toBe("—");
    expect(formatCompact(undefined)).toBe("—");
    expect(formatCompact(Number.NaN)).toBe("—");
  });
});

describe("formatNumber / formatDays", () => {
  it("formats whole numbers and pluralizes days", () => {
    expect(formatNumber(4934)).toBe(WHOLE.format(4934));
    expect(formatDays(1)).toBe("1 day");
    expect(formatDays(12)).toBe(`${WHOLE.format(12)} days`);
  });
});

describe("toDisplayName", () => {
  it("title-cases separator-delimited basenames", () => {
    expect(toDisplayName("jane_doe-dev")).toBe("Jane Doe Dev");
    expect(toDisplayName("")).toBe("Synara");
  });
});

describe("normalizeHandle", () => {
  it("slugs to a lowercase @handle with a fallback", () => {
    expect(normalizeHandle("  @Jane Doe! ")).toBe("@janedoe");
    expect(normalizeHandle("$$$")).toBe("@synara");
  });
});

describe("formatShortDate", () => {
  it("rejects missing or malformed input", () => {
    expect(formatShortDate(null)).toBeNull();
    expect(formatShortDate("not-a-date")).toBeNull();
  });
});

const WHOLE = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

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
      const { formatShortDate } = await import("./formatting");
      const expected = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
      }).format(new Date(2026, 3, 3));

      expect(formatShortDate("2026-04-03")).toBe(expected);
    });
  },
);
