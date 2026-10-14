// FILE: profileFormatting.test.ts
// Purpose: Pins the heatmap tooltip date to the server's calendar-day key in any viewer time zone.
// Layer: web profile feature tests.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
