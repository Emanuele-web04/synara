import { describe, expect, it } from "vitest";
import { makeActivity } from "~/storeTestFixtures";
import { deriveLatestRateLimitStatus } from "./rateLimitStatus";

const now = Date.parse("2026-11-11T20:00:00Z");
const quota = (status: string, extra: Record<string, string | number> = {}) =>
  makeActivity({
    kind: "account.rate-limits.updated",
    payload: { provider: "claudeAgent", status, ...extra },
  });

describe("current rate-limit status", () => {
  it("reads usage-only warnings and clears them on recovery without reviving old limits", () => {
    const warning = quota("allowed_warning", { utilization: 0.91 });
    expect(deriveLatestRateLimitStatus([warning], now)).toEqual({
      status: "allowed_warning",
      utilization: 0.91,
    });
    expect(deriveLatestRateLimitStatus([warning, quota("allowed")], now)).toBeNull();
    expect(
      deriveLatestRateLimitStatus(
        [warning, quota("allowed_warning", { resetsAt: "2026-11-11T19:59:00Z" })],
        now,
      ),
    ).toBeNull();
  });
  it("does not let recovery in a different window clear a blocked limit", () => {
    const blocked = quota("rejected", { rateLimitType: "five_hour" });
    expect(
      deriveLatestRateLimitStatus([blocked, quota("allowed", { rateLimitType: "seven_day" })], now)
        ?.status,
    ).toBe("rejected");
    expect(
      deriveLatestRateLimitStatus(
        [blocked, quota("allowed_warning", { rateLimitType: "seven_day" })],
        now,
      )?.status,
    ).toBe("rejected");
    expect(
      deriveLatestRateLimitStatus([blocked, quota("allowed", { rateLimitType: "five_hour" })], now),
    ).toBeNull();
  });
  it("keeps account and provider warnings separate after a handoff", () => {
    const work = quota("allowed_warning", { providerInstanceId: "claude_work" });
    const personal = quota("allowed", { providerInstanceId: "claudeAgent" });
    expect(
      deriveLatestRateLimitStatus([work, personal], now, {
        provider: "claudeAgent",
        instanceId: "claude_work",
      })?.status,
    ).toBe("allowed_warning");
    expect(
      deriveLatestRateLimitStatus([work], now, { provider: "codex", instanceId: "codex" }),
    ).toBeNull();
    expect(
      deriveLatestRateLimitStatus([quota("allowed_warning")], now, {
        provider: "claudeAgent",
        instanceId: "claude_work",
      }),
    ).toBeNull();
  });
});
