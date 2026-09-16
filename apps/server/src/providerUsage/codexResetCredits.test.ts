// FILE: providerUsage/codexResetCredits.test.ts
// Purpose: Covers banked-reset parsing — live app-server shape, snake_case tolerance,
// count-only aggregates, and absent-field fallthrough.

import { describe, expect, it } from "vitest";

import { parseCodexResetCredits } from "./codexResetCredits";

describe("parseCodexResetCredits", () => {
  it("maps the live app-server shape with detail rows", () => {
    expect(
      parseCodexResetCredits({
        rateLimitResetCredits: {
          availableCount: 3,
          credits: [
            {
              id: "RateLimitResetCredit_abc",
              resetType: "codexRateLimits",
              status: "available",
              grantedAt: 1_787_357_419,
              expiresAt: 1_789_949_419,
              title: "Full reset",
              description: "Thanks for using Codex!",
            },
            {
              id: "RateLimitResetCredit_redeemed",
              status: "redeemed",
            },
          ],
        },
      }),
    ).toEqual({
      availableCount: 3,
      credits: [
        {
          id: "RateLimitResetCredit_abc",
          status: "available",
          grantedAt: new Date(1_787_357_419 * 1000).toISOString(),
          expiresAt: new Date(1_789_949_419 * 1000).toISOString(),
          title: "Full reset",
          description: "Thanks for using Codex!",
        },
        { id: "RateLimitResetCredit_redeemed", status: "redeemed" },
      ],
    });
  });

  it("tolerates snake_case keys and drops id-less rows", () => {
    expect(
      parseCodexResetCredits({
        rate_limit_reset_credits: {
          available_count: 2,
          credits: [{ id: "  ", status: "available" }, { id: "keep-1", status: "weird" }],
        },
      }),
    ).toEqual({
      availableCount: 2,
      credits: [{ id: "keep-1", status: "unknown" }],
    });
  });

  it("keeps a count-only aggregate without detail rows", () => {
    expect(parseCodexResetCredits({ rateLimitResetCredits: { availableCount: 1 } })).toEqual({
      availableCount: 1,
    });
  });

  it("returns undefined when credits are not reported", () => {
    expect(parseCodexResetCredits({ rateLimits: {} })).toBeUndefined();
    expect(parseCodexResetCredits({ rateLimitResetCredits: {} })).toBeUndefined();
    expect(parseCodexResetCredits(null)).toBeUndefined();
  });
});
