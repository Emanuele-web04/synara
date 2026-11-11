import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { IdentityProviderError } from "../identity/interfaces";
import { createV1Routes, REFRESH_RATE_LIMIT_PER_MINUTE } from "./v1";

describe("refresh admission", () => {
  it("distinguishes a pre-dispatch limit from an uncertain provider refusal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const refreshTokens = vi
        .fn()
        .mockRejectedValueOnce(new IdentityProviderError(429, "Upstream contention"))
        .mockResolvedValue({
          accessToken: "access-2",
          refreshToken: "refresh-2",
          user: { id: "user_1", email: "ada@example.com" },
        });
      // Refresh admission uses only the identity adapter; no database is involved.
      const app = new Hono().route(
        "/api/v1",
        createV1Routes({
          verifier: { refreshTokens },
          trustedProxyHops: 1,
        } as unknown as Parameters<typeof createV1Routes>[0]),
      );
      const refresh = () =>
        app.request("/api/v1/auth/refresh", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.75" },
          body: JSON.stringify({ refreshToken: "retained-token" }),
        });

      const upstream = await refresh();
      expect(upstream.status).toBe(429);
      expect(await upstream.json()).toMatchObject({ error: "rate_limited" });
      for (let attempt = 1; attempt < REFRESH_RATE_LIMIT_PER_MINUTE; attempt += 1) {
        expect((await refresh()).status).toBe(200);
      }
      const limited = await refresh();
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: "refresh_not_attempted" });
      expect(limited.headers.get("retry-after")).toBe("60");
      expect(refreshTokens).toHaveBeenCalledTimes(REFRESH_RATE_LIMIT_PER_MINUTE);

      vi.setSystemTime(Date.now() + 60_001);
      expect((await refresh()).status).toBe(200);
      expect(refreshTokens).toHaveBeenCalledTimes(REFRESH_RATE_LIMIT_PER_MINUTE + 1);
      expect(refreshTokens).toHaveBeenLastCalledWith(
        expect.objectContaining({ refreshToken: "retained-token" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
