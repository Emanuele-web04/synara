import type { AuthSessionState } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { canAccessMind } from "./mindAccess";

const localUnauthenticated = {
  authenticated: false,
  auth: {
    policy: "desktop-managed-local",
    authEnabled: false,
    bootstrapMethods: ["desktop-bootstrap"],
    sessionMethods: ["browser-session-cookie"],
    sessionCookieName: "synara-session",
  },
} satisfies AuthSessionState;

describe("canAccessMind", () => {
  it("allows a local auth-disabled owner with no browser session", () => {
    expect(canAccessMind(localUnauthenticated)).toBe(true);
  });

  it("allows a verified owner session", () => {
    expect(canAccessMind({ ...localUnauthenticated, authenticated: true, role: "owner" })).toBe(
      true,
    );
  });

  it("keeps paired clients, authenticated remote guests, and loading state out", () => {
    expect(canAccessMind({ ...localUnauthenticated, authenticated: true, role: "client" })).toBe(
      false,
    );
    expect(
      canAccessMind({
        ...localUnauthenticated,
        auth: { ...localUnauthenticated.auth, authEnabled: true },
      }),
    ).toBe(false);
    expect(canAccessMind(undefined)).toBe(false);
  });
});
