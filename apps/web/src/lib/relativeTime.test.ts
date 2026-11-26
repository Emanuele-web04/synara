import { describe, expect, it } from "vitest";

import { formatRelativeTime, formatRelativeTimeAgo } from "./relativeTime";

it("formats complete time-ago phrases", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  expect(formatRelativeTimeAgo("2026-10-02T11:55:00Z", now)).toBe("5m ago");
  expect(formatRelativeTimeAgo("2026-10-02T11:59:30Z", now)).toBe("just now");
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
