import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { IdentityProviderError, type EnvironmentScopeResolution } from "../identity/interfaces";
import { clearUserCache } from "../identity/userCache";
import { createV1Routes } from "./v1";

/**
 * The fresh path of the organization gate, without a database: `DELETE /me`
 * resolves the session with `freshMembership: true` and answers 400 for a
 * missing body before it touches anything else.
 */
function setup() {
  const userId = `user_${crypto.randomUUID()}`;
  const orgId = `org_${crypto.randomUUID()}`;
  const user = Promise.withResolvers<{ id: string; email: string }>();
  const scope = Promise.withResolvers<EnvironmentScopeResolution>();
  const getUser = vi.fn(() => user.promise);
  const resolveEnvironmentScope = vi.fn(
    async (_session: unknown, _email: string | (() => Promise<string>)) => scope.promise,
  );
  const app = new Hono().route(
    "/api/v1",
    createV1Routes({
      verifier: {
        verifyAccessToken: async () => ({ userId, sessionId: "session_1", orgId }),
        getUser,
      },
      grants: { resolveEnvironmentScope },
      accountDeletion: { isSessionFenced: async () => false },
      trustedProxyHops: 1,
    } as unknown as Parameters<typeof createV1Routes>[0]),
  );
  const request = () =>
    app.request("/api/v1/me", {
      method: "DELETE",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: "{}",
    });
  return { userId, orgId, user, scope, getUser, resolveEnvironmentScope, request };
}

describe("requireOrgSession with fresh membership", () => {
  it("reads the live user and membership together, and provisions with the user's email", async () => {
    const f = setup();
    const pending = f.request();
    // Membership is asked for while the user read is still outstanding.
    await vi.waitFor(() => expect(f.resolveEnvironmentScope).toHaveBeenCalledTimes(1));
    expect(f.getUser).toHaveBeenCalledTimes(1);
    const email = f.resolveEnvironmentScope.mock.calls[0]![1] as () => Promise<string>;
    const provisionedWith = email();
    f.user.resolve({ id: f.userId, email: "ada@example.com" });
    await expect(provisionedWith).resolves.toBe("ada@example.com");
    f.scope.resolve({
      kind: "scoped",
      organization: { orgId: f.orgId, orgName: "Ada", role: "admin" },
    } as EnvironmentScopeResolution);
    const response = await pending;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "validation_failed" });
    clearUserCache();
  });

  it("keeps the user read's answer ahead of a membership failure", async () => {
    const deleted = setup();
    deleted.user.reject(new IdentityProviderError(404, "User not found"));
    deleted.scope.reject(new Error("membership read failed"));
    const gone = await deleted.request();
    expect(gone.status).toBe(401);
    expect(await gone.json()).toMatchObject({ message: "This account no longer exists" });

    const outage = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    outage.user.reject(new Error("user read failed"));
    outage.scope.reject(new IdentityProviderError(404, "Membership not found"));
    const unavailable = await outage.request();
    // Before the reads ran together, a failed user read stopped here: 502, not 401.
    expect(unavailable.status).toBe(502);
    vi.restoreAllMocks();
  });
});
