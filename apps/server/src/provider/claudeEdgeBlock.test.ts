import { describe, expect, it } from "vitest";

import {
  claudeEdgeBlockedMessage,
  claudeEdgeBlockRetryWarning,
  isClaudeEdgeBlockedError,
} from "./claudeEdgeBlock.ts";

describe("isClaudeEdgeBlockedError", () => {
  it.each([
    "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare",
    "Please run /login · API Error: 403 Just a moment...",
  ])("treats a Cloudflare 403 page as an edge block: %s", (text) => {
    expect(isClaudeEdgeBlockedError("authentication_failed", text)).toBe(true);
  });

  it.each([
    ["authentication_failed", "Not logged in · Please run /login"],
    ["authentication_failed", 'Failed to authenticate. API Error: 401 {"type":"error"}'],
    ["authentication_failed", "Failed to authenticate. API Error: 403 OAuth token revoked"],
    ["server_error", "API Error: 503 Service Unavailable | Cloudflare"],
  ] as const)("keeps %s for %s", (error, text) => {
    expect(isClaudeEdgeBlockedError(error, text)).toBe(false);
  });
});

describe("claudeEdgeBlockedMessage", () => {
  it("says the block is temporary, not a login problem", () => {
    const message = claudeEdgeBlockedMessage(3);
    expect(message).toMatch(/temporarily blocked the request \(HTTP 403\)/);
    expect(message).toMatch(/after 3 automatic retries/);
    expect(message).toMatch(/login is fine/);
    expect(message).not.toMatch(/auth login/);
  });
});

describe("claudeEdgeBlockRetryWarning", () => {
  it("matches the CLI's own retry notice", () => {
    expect(claudeEdgeBlockRetryWarning({ attempt: 2, maxRetries: 3, delayMs: 15_000 })).toBe(
      "Request retry 2/3 in 15s (HTTP 403 Cloudflare block).",
    );
  });
});
