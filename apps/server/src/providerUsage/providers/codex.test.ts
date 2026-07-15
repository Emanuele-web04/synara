// FILE: providerUsage/providers/codex.test.ts
// Purpose: Tests Codex reset credit parsing and consumption logic.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { consumeCodexRateLimitResetCredit, parseCodexUsage } from "./codex";

describe("parseCodexUsage — reset credits", () => {
  it("parses availableCount and credits array from rate_limit_reset_credits", () => {
    const result = parseCodexUsage({
      json: {
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 50 },
          secondary_window: { used_percent: 30 },
        },
        rate_limit_reset_credits: {
          available_count: 2,
          total_earned_count: 3,
          credits: [
            { status: "available", expires_at: 1719326400, granted_at: 1718721600000 },
            { status: "available", expires_at: 1719412800, granted_at: 1718808000000 },
            { status: "redeemed", expires_at: 1719240000, granted_at: 1718635200000 },
          ],
        },
      },
      nowMs: 1780000000000,
    });

    expect(result.rateLimitResetCredits).toEqual({
      availableCount: 2,
      totalEarnedCount: 3,
      nextExpiresAt: new Date(1719326400 * 1000).toISOString(), // earliest available
      credits: [
        {
          status: "available",
          expiresAt: new Date(1719326400 * 1000).toISOString(),
          grantedAt: new Date(1718721600000).toISOString(),
        },
        {
          status: "available",
          expiresAt: new Date(1719412800 * 1000).toISOString(),
          grantedAt: new Date(1718808000000).toISOString(),
        },
        {
          status: "redeemed",
          expiresAt: new Date(1719240000 * 1000).toISOString(),
          grantedAt: new Date(1718635200000).toISOString(),
        },
      ],
    });
  });

  it("returns undefined when rate_limit_reset_credits is absent", () => {
    const result = parseCodexUsage({
      json: {
        plan_type: "pro",
        rate_limit: { primary_window: { used_percent: 50 } },
      },
      nowMs: 1780000000000,
    });

    expect(result.rateLimitResetCredits).toBeUndefined();
  });

  it("returns undefined when available_count is 0", () => {
    const result = parseCodexUsage({
      json: {
        plan_type: "pro",
        rate_limit_reset_credits: { available_count: 0, credits: [] },
      },
      nowMs: 1780000000000,
    });

    expect(result.rateLimitResetCredits).toBeUndefined();
  });

  it("handles Unix-seconds expiresAt (< 1e10)", () => {
    const result = parseCodexUsage({
      json: {
        plan_type: "pro",
        rate_limit_reset_credits: {
          available_count: 1,
          credits: [{ status: "available", expires_at: 1719326400 }],
        },
      },
      nowMs: 1780000000000,
    });

    expect(result.rateLimitResetCredits?.credits?.[0]?.expiresAt).toBe(
      new Date(1719326400 * 1000).toISOString(),
    );
  });

  it("handles Unix-milliseconds expiresAt (>= 1e10)", () => {
    const result = parseCodexUsage({
      json: {
        plan_type: "pro",
        rate_limit_reset_credits: {
          available_count: 1,
          credits: [{ status: "available", expires_at: 1718721600000 }],
        },
      },
      nowMs: 1780000000000,
    });

    expect(result.rateLimitResetCredits?.credits?.[0]?.expiresAt).toBe(
      new Date(1718721600000).toISOString(),
    );
  });

  it("computes nextExpiresAt as earliest available credit expiry", () => {
    const result = parseCodexUsage({
      json: {
        plan_type: "pro",
        rate_limit_reset_credits: {
          available_count: 2,
          credits: [
            { status: "available", expires_at: 2000000000 }, // later
            { status: "available", expires_at: 1000000000 }, // earliest
            { status: "redeemed", expires_at: 500000000 }, // not available, excluded
          ],
        },
      },
      nowMs: 1780000000000,
    });

    // Only available credits count — "redeemed" is excluded
    expect(result.rateLimitResetCredits?.nextExpiresAt).toBe(
      new Date(1000000000 * 1000).toISOString(),
    );
  });
});

describe("consumeCodexRateLimitResetCredit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock: successful consume
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: "reset" }),
      headers: new Headers(),
    }) as unknown as typeof fetch;
  });

  it("returns error when auth is api-key", async () => {
    const result = await consumeCodexRateLimitResetCredit({
      auth: { kind: "api-key" },
      idempotencyKey: "test-key",
    });

    expect(result.outcome).toBe("error");
  });

  it("returns noCredit on HTTP 400/409", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
      headers: new Headers(),
    }) as unknown as typeof fetch;

    const result = await consumeCodexRateLimitResetCredit({
      auth: { kind: "oauth", accessToken: "token" },
      idempotencyKey: "test-key",
    });

    expect(result.outcome).toBe("noCredit");
  });

  it("sends redeem_request_id in request body", async () => {
    await consumeCodexRateLimitResetCredit({
      auth: { kind: "oauth", accessToken: "token" },
      idempotencyKey: "unique-key-123",
    });

    const mockFetch = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const fetchCall = mockFetch.mock.calls[0]!;
    const body = JSON.parse(fetchCall[1].body);
    expect(body.redeem_request_id).toBe("unique-key-123");
  });

  it("returns noCredit when code is no_credit or already_redeemed", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: "no_credit" }),
      headers: new Headers(),
    }) as unknown as typeof fetch;

    const result = await consumeCodexRateLimitResetCredit({
      auth: { kind: "oauth", accessToken: "token" },
      idempotencyKey: "test-key",
    });

    expect(result.outcome).toBe("noCredit");
  });

  it("returns error on network failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network error")) as unknown as typeof fetch;

    const result = await consumeCodexRateLimitResetCredit({
      auth: { kind: "oauth", accessToken: "token" },
      idempotencyKey: "test-key",
    });

    expect(result.outcome).toBe("error");
  });
});
