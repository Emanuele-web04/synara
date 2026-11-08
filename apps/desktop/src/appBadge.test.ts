// FILE: appBadge.test.ts
// Purpose: Verifies the Dock badge's sum of notifications and items waiting on the user.

import { describe, expect, it } from "vitest";

import { MAX_APP_BADGE_COUNT, parseAttentionBadgeCount, resolveAppBadgeCount } from "./appBadge";

describe("parseAttentionBadgeCount", () => {
  it("keeps whole counts and rejects anything else", () => {
    expect(parseAttentionBadgeCount(3)).toBe(3);
    expect(parseAttentionBadgeCount(2.7)).toBe(2);
    expect(parseAttentionBadgeCount(-1)).toBe(0);
    expect(parseAttentionBadgeCount(Number.NaN)).toBe(0);
    expect(parseAttentionBadgeCount("4")).toBe(0);
    expect(parseAttentionBadgeCount(undefined)).toBe(0);
    expect(parseAttentionBadgeCount(1_000)).toBe(MAX_APP_BADGE_COUNT);
  });
});

describe("resolveAppBadgeCount", () => {
  it("adds bots waiting on the user to unread notifications, capped", () => {
    expect(resolveAppBadgeCount(0, 0)).toBe(0);
    expect(resolveAppBadgeCount(2, 1)).toBe(3);
    expect(resolveAppBadgeCount(98, 5)).toBe(MAX_APP_BADGE_COUNT);
  });
});
