import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  flavor: "production" as string,
  credentials: null as { accountUrl: string; userId?: string; accessToken: string } | null,
  billingResult: { available: true, access: "none" as "none" | "granted" },
  billingThrows: false,
}));

vi.mock("../betaFeatureGate", () => ({
  get SERVER_DESKTOP_FLAVOR() {
    return state.flavor;
  },
  isServerBetaFeatureEnabled: () => true,
}));

vi.mock("../projectAgent/groupsBetaGate", () => ({
  isServerGroupsEnabled: () => true,
}));

vi.mock("../accountAuth", () => ({
  readAccountCredentials: vi.fn(async () => state.credentials),
  withFreshAccessToken: vi.fn(async (_opts: unknown, fn: (token: string) => Promise<unknown>) =>
    fn(state.credentials?.accessToken ?? ""),
  ),
}));

vi.mock("../accountHttp", () => ({
  createServerAccountClient: vi.fn(() => ({
    billingStatus: vi.fn(async () => {
      if (state.billingThrows) throw new Error("network down");
      return state.billingResult;
    }),
  })),
}));

import {
  checkServerSynbotAltoAccess,
  clearServerAltoAccess,
  noteServerAltoAccess,
  requiresServerSynbotAlto,
} from "./synbotGate";

describe("synbotGate Alto entitlement", () => {
  const dir = "/tmp/synbot-gate-test";

  beforeEach(() => {
    state.flavor = "production";
    state.credentials = null;
    state.billingResult = { available: true, access: "none" };
    state.billingThrows = false;
    clearServerAltoAccess(dir);
  });

  afterEach(() => {
    clearServerAltoAccess(dir);
    vi.clearAllMocks();
  });

  it("allows non-production flavors without requiring Alto", async () => {
    state.flavor = "beta";
    expect(requiresServerSynbotAlto()).toBe(false);
    expect(await checkServerSynbotAltoAccess(dir)).toBe(true);
  });

  it("fails closed in Stable when signed out", async () => {
    expect(requiresServerSynbotAlto()).toBe(true);
    expect(await checkServerSynbotAltoAccess(dir)).toBe(false);
  });

  it("fails closed in Stable without an active Alto subscription or on API errors", async () => {
    state.credentials = {
      accountUrl: "https://api.trysynara.com",
      userId: "user_1",
      accessToken: "tok",
    };
    expect(await checkServerSynbotAltoAccess(dir)).toBe(false);

    clearServerAltoAccess(dir);
    state.billingThrows = true;
    expect(await checkServerSynbotAltoAccess(dir)).toBe(false);
  });

  it("grants in Stable with verified Alto and revokes immediately on sign-out", async () => {
    state.credentials = {
      accountUrl: "https://api.trysynara.com",
      userId: "user_1",
      accessToken: "tok",
    };
    state.billingResult = { available: true, access: "granted" };
    expect(await checkServerSynbotAltoAccess(dir)).toBe(true);

    clearServerAltoAccess(dir);
    state.credentials = null;
    expect(await checkServerSynbotAltoAccess(dir)).toBe(false);
  });

  it("unlocks immediately when AccountSession notes an Alto grant", async () => {
    state.credentials = {
      accountUrl: "https://api.trysynara.com",
      userId: "user_1",
      accessToken: "tok",
    };
    expect(await checkServerSynbotAltoAccess(dir)).toBe(false);

    noteServerAltoAccess(dir, {
      accountUrl: "https://api.trysynara.com",
      userId: "user_1",
      granted: true,
    });
    expect(await checkServerSynbotAltoAccess(dir)).toBe(true);
  });
});
