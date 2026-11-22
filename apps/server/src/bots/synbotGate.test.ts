import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  flavor: "production" as string,
  credentials: null as {
    accountUrl: string;
    organizationId?: string;
    userId?: string;
    accessToken: string;
  } | null,
  billingResult: { available: true, access: "none" as "none" | "granted" },
  billingThrows: false,
  billingCalls: 0,
  /** While set, every billing read waits for it, so a test can interleave a check. */
  billingHold: null as Promise<void> | null,
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
      state.billingCalls += 1;
      const result = state.billingResult;
      if (state.billingHold) await state.billingHold;
      if (state.billingThrows) throw new Error("network down");
      return result;
    }),
  })),
}));

import {
  checkServerSynbotAltoAccess,
  clearServerAltoAccess,
  noteServerAltoAccess,
  onServerAltoAccessRevoked,
  requiresServerSynbotAlto,
} from "./synbotGate";

describe("synbotGate Alto entitlement", () => {
  const dir = "/tmp/synbot-gate-test";

  beforeEach(() => {
    state.flavor = "production";
    state.credentials = null;
    state.billingResult = { available: true, access: "none" };
    state.billingThrows = false;
    state.billingCalls = 0;
    state.billingHold = null;
    clearServerAltoAccess(dir);
  });

  afterEach(() => {
    clearServerAltoAccess(dir);
    vi.clearAllMocks();
  });

  it.each(["beta", "canary", "development"])(
    "leaves SynBot free on the %s flavor",
    async (flavor) => {
      state.flavor = flavor;
      expect(requiresServerSynbotAlto()).toBe(false);
      expect(await checkServerSynbotAltoAccess(dir)).toBe(true);
    },
  );

  it.each(["production", "unknown", "remote", "cua"])(
    "requires Alto on the %s flavor and fails closed when signed out",
    async (flavor) => {
      state.flavor = flavor;
      expect(requiresServerSynbotAlto()).toBe(true);
      expect(await checkServerSynbotAltoAccess(dir)).toBe(false);
    },
  );

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

  const signedIn = (organizationId = "org_1") => {
    state.credentials = {
      accountUrl: "https://api.trysynara.com",
      organizationId,
      userId: "user_1",
      accessToken: "tok",
    };
  };
  /** Holds billing reads until the returned release is called. */
  const hold = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.billingHold = held;
    return release;
  };

  it("keeps a checkout grant that lands while an older check is still running", async () => {
    signedIn();
    const release = hold();
    const stale = checkServerSynbotAltoAccess(dir);
    await vi.waitFor(() => expect(state.billingCalls).toBe(1));
    noteServerAltoAccess(dir, {
      accountUrl: "https://api.trysynara.com",
      organizationId: "org_1",
      userId: "user_1",
      granted: true,
    });
    release();
    // The check read "none" before checkout; it must not overwrite the fresh grant.
    expect(await stale).toBe(true);
    expect(await checkServerSynbotAltoAccess(dir)).toBe(true);
    expect(state.billingCalls).toBe(1);
  });

  it("a check from before sign-out neither grants nor drops the check started after it", async () => {
    signedIn();
    state.billingResult = { available: true, access: "granted" };
    const releaseOld = hold();
    const old = checkServerSynbotAltoAccess(dir);
    await vi.waitFor(() => expect(state.billingCalls).toBe(1));
    clearServerAltoAccess(dir);
    // Signed back in on Free: a new check starts while the old one is still out.
    state.billingResult = { available: true, access: "none" };
    const releaseNew = hold();
    const fresh = checkServerSynbotAltoAccess(dir);
    await vi.waitFor(() => expect(state.billingCalls).toBe(2));
    releaseOld();
    expect(await old).toBe(false);
    // The old check's cleanup left the new one in flight: a third caller joins it.
    const joined = checkServerSynbotAltoAccess(dir);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.billingCalls).toBe(2);
    releaseNew();
    expect(await fresh).toBe(false);
    expect(await joined).toBe(false);
    expect(state.billingCalls).toBe(2);
  });

  it("checks again when the signed-in organization changes", async () => {
    signedIn("org_1");
    state.billingResult = { available: true, access: "granted" };
    expect(await checkServerSynbotAltoAccess(dir)).toBe(true);
    signedIn("org_2");
    state.billingResult = { available: true, access: "none" };
    expect(await checkServerSynbotAltoAccess(dir)).toBe(false);
    expect(state.billingCalls).toBe(2);
  });

  it("tells listeners when access is gone, and only then", async () => {
    const revoked: string[] = [];
    const stop = onServerAltoAccessRevoked((credentialDir) => revoked.push(credentialDir));
    try {
      signedIn();
      state.billingResult = { available: true, access: "granted" };
      expect(await checkServerSynbotAltoAccess(dir)).toBe(true);
      noteServerAltoAccess(dir, { accountUrl: "https://api.trysynara.com", granted: true });
      expect(revoked).toEqual([]);

      noteServerAltoAccess(dir, { accountUrl: "https://api.trysynara.com", granted: false });
      expect(revoked).toEqual([dir]);
      clearServerAltoAccess(dir);
      expect(revoked).toEqual([dir, dir]);
      state.billingResult = { available: true, access: "none" };
      expect(await checkServerSynbotAltoAccess(dir)).toBe(false);
      expect(revoked).toEqual([dir, dir, dir]);
    } finally {
      stop();
    }
    clearServerAltoAccess(dir);
    expect(revoked).toHaveLength(3);
  });
});
