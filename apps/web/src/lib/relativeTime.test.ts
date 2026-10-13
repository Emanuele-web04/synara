import { afterEach, describe, expect, it } from "vitest";
import { i18n, setLanguagePreference } from "~/i18n";

import {
  formatRelativeTime,
  formatRelativeTimeAgo,
  formatSnoozeRemainingTime,
} from "./relativeTime";

afterEach(() => setLanguagePreference("system"));

it("formats complete time-ago phrases once in both languages", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  setLanguagePreference("en");
  expect(formatRelativeTimeAgo("2026-10-02T11:55:00Z", now)).toBe("5m ago");
  expect(formatRelativeTimeAgo("2026-10-02T11:59:30Z", now)).toBe("just now");
  setLanguagePreference("es");
  expect(formatRelativeTimeAgo("2026-10-02T11:55:00Z", now)).toBe("hace 5 min");
  expect(formatRelativeTimeAgo("2026-10-02T11:59:30Z", now)).toBe("ahora mismo");
});

it("localizes relative time and snooze countdowns without changing deadline values", () => {
  i18n.addResourceBundle("es", "translation", {
    "{{duration}} left": "Quedan {{duration}}",
    "{{amount}} hr": "{{amount}} h",
    "{{amount}} min": "{{amount}} min",
  });
  setLanguagePreference("es");
  const now = Date.parse("2026-10-02T12:00:00Z");
  expect(formatRelativeTime("2026-10-02T11:55:00Z", now)).toBe(
    new Intl.RelativeTimeFormat("es", { style: "short", numeric: "auto" }).format(-5, "minute"),
  );
  expect(formatSnoozeRemainingTime("2026-10-02T13:28:00Z", now)).toBe("Quedan 1 h 28 min");
});

describe("formatRelativeTime", () => {
  it('returns "now" for timestamps less than 1 minute ago', () => {
    const iso = new Date(Date.now() - 30_000).toISOString();
    expect(formatRelativeTime(iso)).toBe("now");
  });

  it("returns minutes for timestamps under an hour", () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(iso)).toBe("5m");
  });

  it("returns days for timestamps over a day", () => {
    const iso = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(iso)).toBe("2d");
  });

  it('returns "now" for future timestamps caused by clock skew', () => {
    const iso = new Date(Date.now() + 60_000).toISOString();
    expect(formatRelativeTime(iso)).toBe("now");
  });
});
