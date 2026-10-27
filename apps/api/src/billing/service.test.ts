import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBillingService } from "./service";
import { decideRemoteBillingAccess } from "./accessPolicy";
import {
  BillingCheckoutNotCreatedError,
  type BillingProvider,
  type BillingSnapshot,
  type BillingCheckout,
} from "./polar";
import { createDb } from "../db";
import { createIsolatedTestDatabase } from "../testing/isolatedDatabase";
import { createAccountDeletionService } from "../accountDeletion";
import type { AccountIdentityVerifier } from "../identity/interfaces";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("sandbox billing durable PostgreSQL ledger", () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let pool: pg.Pool;
  let db: ReturnType<typeof createDb>["db"];
  let deletionPool: pg.Pool;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!);
    pool = new pg.Pool({ connectionString: isolated.url });
    ({ db, pool: deletionPool } = createDb(isolated.url));
  });
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE billing_environment,billing_webhook_events,billing_accounts,account_deletions",
    );
  });
  afterAll(async () => {
    await pool?.end();
    await deletionPool?.end();
    await isolated?.close();
  });
  function fixture(environment: BillingProvider["environment"] = "sandbox") {
    const states = new Map<string, BillingSnapshot>();
    const checkouts = new Map<string, BillingCheckout>();
    const provider: BillingProvider = {
      environment,
      plans: vi.fn(async () => [
        { interval: "month" as const, amountMinor: 1200, currency: "EUR" },
      ]),
      state: vi.fn(async (userId) => states.get(userId) ?? null),
      productId: (interval) => `test-${interval}`,
      preflightCheckout: vi.fn(async () => {}),
      recoverCheckout: vi.fn(async (_userId, attemptId) => checkouts.get(attemptId) ?? null),
      checkout: vi.fn(async (userId, _email, interval, attemptId) => {
        const checkout: BillingCheckout = {
          checkoutId: randomUUID(),
          url: `https://${environment === "sandbox" ? "sandbox.polar.sh" : "polar.sh"}/checkout/${userId}/${attemptId}`,
          productId: `test-${interval}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          status: "open",
        };
        checkouts.set(attemptId, checkout);
        return checkout;
      }),
      portal: vi.fn(
        async (userId) =>
          `https://${environment === "sandbox" ? "sandbox.polar.sh" : "polar.sh"}/portal/${userId}`,
      ),
      cancelRenewals: vi.fn(async () => {}),
      verify: vi.fn(async (body) => JSON.parse(body)),
    };
    const service = createBillingService({ pool, provider });
    const paid = (userId: string, overrides: Partial<BillingSnapshot> = {}) =>
      states.set(userId, {
        customerId: randomUUID(),
        productIds: [randomUUID()],
        settledCheckoutAttempts: [],
        accessGranted: true,
        subscriptionStatus: "active",
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
        cancelAtPeriodEnd: false,
        hasSubscription: true,
        ...overrides,
      });
    return { service, provider, states, paid, checkouts };
  }
  it("atomically claims one billing environment before any provider call", async () => {
    const sandbox = fixture(),
      production = fixture("production");
    const results = await Promise.allSettled([
      sandbox.service.initialize(),
      production.service.initialize(),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { status: 503 } });
    const environment = results[0]!.status === "fulfilled" ? "sandbox" : "production";
    expect((await pool.query("SELECT id,environment FROM billing_environment")).rows).toEqual([
      { id: 1, environment },
    ]);
    expect(sandbox.provider.plans).not.toHaveBeenCalled();
    expect(production.provider.plans).not.toHaveBeenCalled();
  });
  it("refuses a different environment for every entry point without touching a provider", async () => {
    await fixture().service.initialize();
    const { service, provider } = fixture("production");
    const userId = randomUUID();
    for (const invoke of [
      () => service.initialize(),
      () => service.status(userId),
      () => service.access(userId),
      () => service.checkout(userId, "a@example.com", "month"),
      () => service.portal(userId),
      () => service.webhook("{}", {}),
      () => service.flush(),
      () => service.cleanupDeletedAccount(userId),
    ])
      await expect(invoke()).rejects.toMatchObject({ status: 503 });
    for (const method of [
      provider.plans,
      provider.state,
      provider.preflightCheckout,
      provider.recoverCheckout,
      provider.checkout,
      provider.portal,
      provider.cancelRenewals,
      provider.verify,
    ])
      expect(method).not.toHaveBeenCalled();
    expect((await pool.query("SELECT count(*) FROM billing_accounts")).rows[0].count).toBe("0");
    expect((await pool.query("SELECT count(*) FROM billing_webhook_events")).rows[0].count).toBe(
      "0",
    );
  });
  it("never promotes pre-existing sandbox billing rows to production", async () => {
    await pool.query("INSERT INTO billing_accounts(user_id) VALUES($1)", [randomUUID()]);
    const { service, provider } = fixture("production");
    await expect(service.initialize()).rejects.toMatchObject({ status: 503 });
    expect((await pool.query("SELECT environment FROM billing_environment")).rows).toEqual([
      { environment: "sandbox" },
    ]);
    expect(provider.plans).not.toHaveBeenCalled();
    expect(provider.state).not.toHaveBeenCalled();
  });
  it("labels status and redirects with the initialized provider environment", async () => {
    const { service, paid } = fixture("production");
    const userId = randomUUID();
    paid(userId);
    expect(await service.status(userId)).toMatchObject({
      environment: "production",
      access: "granted",
    });
    expect(await service.portal(userId)).toEqual({
      environment: "production",
      url: `https://polar.sh/portal/${userId}`,
    });
    expect(await service.checkout(randomUUID(), "b@example.com", "month")).toMatchObject({
      environment: "production",
    });
  });
  it("bounds authorization caching without plans, stale fallback or extending its checked time", async () => {
    const { service, provider, paid, states } = fixture();
    const userId = randomUUID();
    paid(userId);
    const original = await service.access(userId);
    expect(original).toMatchObject({ access: "granted", available: true });
    expect(await service.access(userId)).toEqual(original);
    expect(provider.state).toHaveBeenCalledTimes(1);
    await pool.query(
      "UPDATE billing_accounts SET checked_at=now()-interval '31 seconds' WHERE user_id=$1",
      [userId],
    );
    vi.mocked(provider.state).mockRejectedValueOnce(new Error("provider offline"));
    await expect(service.access(userId)).rejects.toThrow("provider offline");
    expect(
      (await pool.query("SELECT access_granted FROM billing_accounts WHERE user_id=$1", [userId]))
        .rows[0].access_granted,
    ).toBe(true);
    states.delete(userId);
    expect(await service.access(userId)).toMatchObject({ access: "none" });
    expect(provider.state).toHaveBeenCalledTimes(3);
    expect(provider.plans).not.toHaveBeenCalled();
  });
  it("reconciles a future ledger timestamp using the API clock even when PostgreSQL is ahead", async () => {
    const { service, provider, paid } = fixture();
    const userId = randomUUID();
    paid(userId);
    await service.access(userId);
    await pool.query(
      "UPDATE billing_accounts SET checked_at=now()+interval '1 minute' WHERE user_id=$1",
      [userId],
    );
    const apiNow = Date.now() - 120_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(apiNow);
    try {
      const refreshed = await service.access(userId);
      expect(provider.state).toHaveBeenCalledTimes(2);
      expect(refreshed.checkedAt).toBe(new Date(apiNow).toISOString());
      expect(decideRemoteBillingAccess({ enforcementEnabled: true, status: refreshed })).toEqual({
        allowed: true,
        reason: "allowed",
      });
      expect(
        (
          await pool.query("SELECT checked_at FROM billing_accounts WHERE user_id=$1", [userId])
        ).rows[0].checked_at.toISOString(),
      ).toBe(refreshed.checkedAt);
    } finally {
      vi.useRealTimers();
    }
  });
  it("refreshes a recent authorization when a webhook is pending or its validity expired", async () => {
    const { service, provider, paid, states } = fixture();
    const userId = randomUUID();
    paid(userId);
    await service.access(userId);
    await pool.query(
      "UPDATE billing_accounts SET valid_until=now()-interval '1 second' WHERE user_id=$1",
      [userId],
    );
    expect(await service.access(userId)).toMatchObject({ access: "granted" });
    expect(provider.state).toHaveBeenCalledTimes(2);
    states.delete(userId);
    await service.webhook(JSON.stringify({ eventId: randomUUID(), userId }), {});
    expect(await service.access(userId)).toMatchObject({ access: "none" });
    expect(provider.state).toHaveBeenCalledTimes(3);
    expect(
      (await pool.query("SELECT handled_at FROM billing_webhook_events")).rows[0].handled_at,
    ).toBeNull();
    expect(provider.plans).not.toHaveBeenCalled();
  });
  it("isolates accounts, serializes duplicate checkout and survives a service restart", async () => {
    const { service, provider, paid } = fixture();
    const a = randomUUID(),
      b = randomUUID();
    paid(a);
    expect(await service.status(a)).toMatchObject({
      access: "granted",
      canCheckout: false,
      canManage: true,
    });
    expect(await service.status(b)).toMatchObject({
      access: "none",
      canCheckout: true,
      canManage: false,
    });
    await expect(service.checkout(a, "a@example.com", "month")).rejects.toMatchObject({
      status: 409,
    });
    const results = await Promise.allSettled([
      service.checkout(b, "b@example.com", "month"),
      service.checkout(b, "b@example.com", "month"),
    ]);
    const completed = results.filter((result) => result.status === "fulfilled");
    expect(completed.length).toBeGreaterThan(0);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 409 });
      else expect(result.value).toEqual(completed[0]!.value);
    }
    expect(provider.checkout).toHaveBeenCalledTimes(1);
    const restarted = createBillingService({ pool, provider });
    expect(await restarted.checkout(b, "b@example.com", "month")).toEqual(completed[0]!.value);
    const stored = (
      await pool.query(
        "SELECT checkout_id,checkout_attempt_id FROM billing_accounts WHERE user_id=$1",
        [b],
      )
    ).rows[0];
    expect(vi.mocked(provider.recoverCheckout).mock.calls.at(-1)).toEqual([
      b,
      stored.checkout_attempt_id,
      "test-month",
      stored.checkout_id,
    ]);
    // A pre-0025 row with its original attempt recovers once, then stores its ID.
    await pool.query("UPDATE billing_accounts SET checkout_id=NULL WHERE user_id=$1", [b]);
    expect(await restarted.checkout(b, "b@example.com", "month")).toEqual(completed[0]!.value);
    expect(
      (await pool.query("SELECT checkout_id FROM billing_accounts WHERE user_id=$1", [b])).rows[0]
        .checkout_id,
    ).toBe(stored.checkout_id);
    vi.mocked(provider.recoverCheckout).mockRejectedValueOnce(
      new Error("Known checkout is temporarily unavailable or missing"),
    );
    await expect(restarted.checkout(b, "b@example.com", "month")).rejects.toThrow("Known checkout");
    expect(provider.checkout).toHaveBeenCalledTimes(1);
    expect(
      (await pool.query("SELECT checkout_attempt_id FROM billing_accounts WHERE user_id=$1", [b]))
        .rows[0].checkout_attempt_id,
    ).toBe(stored.checkout_attempt_id);
    await expect(restarted.checkout(b, "b@example.com", "year")).rejects.toMatchObject({
      status: 409,
    });
  });
  it("does not persist a purchase fence when read-only preflight fails before any POST", async () => {
    const { service, provider } = fixture();
    const userId = randomUUID();
    vi.mocked(provider.preflightCheckout).mockRejectedValueOnce(
      new Error("Read-only vendor lookup failed"),
    );
    await expect(service.checkout(userId, "a@example.com", "month")).rejects.toThrow(
      "lookup failed",
    );
    expect(provider.checkout).not.toHaveBeenCalled();
    expect(
      (
        await pool.query("SELECT checkout_attempt_id FROM billing_accounts WHERE user_id=$1", [
          userId,
        ])
      ).rows[0]?.checkout_attempt_id,
    ).toBeFalsy();
    await service.checkout(userId, "a@example.com", "month");
    expect(provider.checkout).toHaveBeenCalledTimes(1);
  });
  it("releases only its own definitively rejected checkout so corrected details can be retried", async () => {
    const { service, provider } = fixture();
    const userId = randomUUID();
    vi.mocked(provider.checkout).mockRejectedValueOnce(new BillingCheckoutNotCreatedError());
    await expect(service.checkout(userId, "invalid@example.com", "month")).rejects.toMatchObject({
      status: 400,
    });
    expect(
      (
        await pool.query(
          "SELECT checkout_attempt_id,checkout_product_id,checkout_interval,checkout_url FROM billing_accounts WHERE user_id=$1",
          [userId],
        )
      ).rows[0],
    ).toEqual({
      checkout_attempt_id: null,
      checkout_product_id: null,
      checkout_interval: null,
      checkout_url: null,
    });
    await service.checkout(userId, "corrected@example.com", "month");
    expect(provider.checkout).toHaveBeenCalledTimes(2);
    const preserved = (
      await pool.query("SELECT checkout_attempt_id FROM billing_accounts WHERE user_id=$1", [
        userId,
      ])
    ).rows[0].checkout_attempt_id;
    const newerAttempt = randomUUID();
    const otherUser = randomUUID();
    // Another worker's newer intent must survive a late refusal from this request.
    vi.mocked(provider.checkout).mockImplementationOnce(async () => {
      await pool.query("UPDATE billing_accounts SET checkout_attempt_id=$2 WHERE user_id=$1", [
        otherUser,
        newerAttempt,
      ]);
      throw new BillingCheckoutNotCreatedError();
    });
    await expect(service.checkout(otherUser, "invalid@example.com", "year")).rejects.toMatchObject({
      status: 400,
    });
    expect(
      (
        await pool.query("SELECT checkout_attempt_id FROM billing_accounts WHERE user_id=$1", [
          otherUser,
        ])
      ).rows[0].checkout_attempt_id,
    ).toBe(newerAttempt);
    expect(
      (
        await pool.query("SELECT checkout_attempt_id FROM billing_accounts WHERE user_id=$1", [
          userId,
        ])
      ).rows[0].checkout_attempt_id,
    ).toBe(preserved);
  });
  it("keeps a committed uncertain attempt through timeouts, delayed visibility and service restart", async () => {
    const { service, provider, checkouts } = fixture();
    const userId = randomUUID();
    let attemptId = "";
    vi.mocked(provider.checkout).mockImplementationOnce(
      async (_userId, _email, _interval, attempt) => {
        attemptId = attempt;
        // A second connection sees the fence before the vendor request has returned.
        expect(
          (
            await pool.query("SELECT checkout_attempt_id FROM billing_accounts WHERE user_id=$1", [
              userId,
            ])
          ).rows[0].checkout_attempt_id,
        ).toBe(attempt);
        throw new Error("Vendor response timed out while its POST may still be running");
      },
    );
    await expect(service.checkout(userId, "a@example.com", "month")).rejects.toThrow("timed out");
    const restarted = createBillingService({ pool, provider });
    await expect(restarted.checkout(userId, "a@example.com", "month")).rejects.toMatchObject({
      status: 409,
    });
    await expect(restarted.checkout(userId, "a@example.com", "month")).rejects.toMatchObject({
      status: 409,
    });
    expect(provider.checkout).toHaveBeenCalledTimes(1);
    checkouts.set(attemptId, {
      checkoutId: randomUUID(),
      url: "https://sandbox.polar.sh/checkout/late",
      productId: "test-product",
      status: "open",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await restarted.checkout(userId, "a@example.com", "month")).toMatchObject({
      url: "https://sandbox.polar.sh/checkout/late",
    });
    expect(provider.checkout).toHaveBeenCalledTimes(1);
  });
  it("revalidates an unexpired failed checkout and creates a fresh attempt only after terminal proof", async () => {
    const { service, provider, checkouts } = fixture();
    const userId = randomUUID();
    const original = await service.checkout(userId, "a@example.com", "month");
    const attempt = [...checkouts.keys()][0]!;
    checkouts.set(attempt, { ...checkouts.get(attempt)!, status: "failed" });
    const replacement = await service.checkout(userId, "a@example.com", "month");
    expect(replacement.url).not.toBe(original.url);
    expect(provider.checkout).toHaveBeenCalledTimes(2);
    const latest = [...checkouts.keys()].at(-1)!;
    checkouts.set(latest, { ...checkouts.get(latest)!, status: "confirmed" });
    expect(await service.checkout(userId, "a@example.com", "month")).toEqual(replacement);
    expect(provider.checkout).toHaveBeenCalledTimes(2);
    checkouts.set(latest, { ...checkouts.get(latest)!, status: "succeeded" });
    await expect(service.checkout(userId, "a@example.com", "month")).rejects.toMatchObject({
      status: 409,
    });
    expect(provider.checkout).toHaveBeenCalledTimes(2);
  });
  it("allows annual checkout after the earlier monthly attempt is positively expired", async () => {
    const { service, provider, checkouts } = fixture();
    const userId = randomUUID();
    await service.checkout(userId, "a@example.com", "month");
    const monthlyAttempt = [...checkouts.keys()][0]!;
    checkouts.set(monthlyAttempt, { ...checkouts.get(monthlyAttempt)!, status: "expired" });
    await service.checkout(userId, "a@example.com", "year");
    expect(provider.checkout).toHaveBeenCalledTimes(2);
    expect(vi.mocked(provider.checkout).mock.calls.at(-1)).toEqual([
      userId,
      "a@example.com",
      "year",
      expect.any(String),
      undefined,
    ]);
    expect(
      (
        await pool.query(
          "SELECT checkout_interval,checkout_product_id FROM billing_accounts WHERE user_id=$1",
          [userId],
        )
      ).rows[0],
    ).toEqual({ checkout_interval: "year", checkout_product_id: "test-year" });
  });
  it("settles only the matching started purchase, including cancellation before the first sync", async () => {
    const { service, provider, checkouts, paid } = fixture();
    const userId = randomUUID();
    await service.checkout(userId, "a@example.com", "month");
    const attemptId = [...checkouts.keys()][0]!;
    checkouts.set(attemptId, { ...checkouts.get(attemptId)!, status: "succeeded" });
    // A manually granted benefit or another subscription must not erase an uncertain purchase.
    paid(userId, {
      subscriptionStatus: null,
      hasSubscription: false,
      settledCheckoutAttempts: [
        { attemptId: randomUUID(), productId: "test-month" },
        { attemptId, productId: "test-year" },
      ],
    });
    expect(await service.status(userId)).toMatchObject({ access: "granted" });
    expect(
      (
        await pool.query("SELECT checkout_attempt_id FROM billing_accounts WHERE user_id=$1", [
          userId,
        ])
      ).rows[0].checkout_attempt_id,
    ).toBe(attemptId);
    paid(userId, {
      accessGranted: false,
      subscriptionStatus: "canceled",
      hasSubscription: false,
      settledCheckoutAttempts: [],
    });
    await expect(service.checkout(userId, "a@example.com", "year")).rejects.toMatchObject({
      status: 409,
    });
    expect(provider.checkout).toHaveBeenCalledTimes(1);
    // The matching subscription really started and ended while the app was offline.
    paid(userId, {
      accessGranted: false,
      subscriptionStatus: "canceled",
      hasSubscription: false,
      settledCheckoutAttempts: [{ attemptId, productId: "test-month" }],
    });
    await service.checkout(userId, "a@example.com", "year");
    expect(provider.checkout).toHaveBeenCalledTimes(2);
    expect(vi.mocked(provider.checkout).mock.calls.at(-1)?.[2]).toBe("year");
  });
  it("deduplicates webhooks and reconciles fresh provider state instead of stale payloads", async () => {
    const { service, provider, paid, states } = fixture();
    const userId = randomUUID();
    paid(userId);
    const body = JSON.stringify({ eventId: "old_event", userId, accessGranted: true });
    await service.webhook(body, {});
    await service.webhook(body, {});
    expect((await pool.query("SELECT count(*) FROM billing_webhook_events")).rows[0].count).toBe(
      "1",
    );
    states.delete(userId);
    await service.flush();
    expect(
      (await pool.query("SELECT access_granted FROM billing_accounts WHERE user_id=$1", [userId]))
        .rows[0].access_granted,
    ).toBe(false);
    expect(provider.state).toHaveBeenCalledTimes(1);
    await service.flush();
    expect(provider.state).toHaveBeenCalledTimes(1);
    const restarted = createBillingService({ pool, provider });
    await restarted.webhook(body, {});
    await restarted.flush();
    expect(provider.state).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT count(*) FROM billing_webhook_events")).rows[0].count).toBe(
      "1",
    );
  });
  it("keeps an event arriving during reconciliation pending regardless of clock skew", async () => {
    const { service, provider, paid, states } = fixture();
    const userId = randomUUID();
    paid(userId);
    const oldState = states.get(userId)!;
    await service.webhook(JSON.stringify({ eventId: "first", userId }), {});
    vi.mocked(provider.state).mockImplementationOnce(async () => {
      await service.webhook(JSON.stringify({ eventId: "arriving", userId }), {});
      await pool.query(
        "UPDATE billing_webhook_events SET received_at=now()-interval '5 minutes' WHERE event_id='arriving'",
      );
      states.delete(userId);
      return oldState;
    });
    await service.flush();
    expect(
      (await pool.query("SELECT handled_at FROM billing_webhook_events WHERE event_id='arriving'"))
        .rows[0].handled_at,
    ).toBeNull();
    await service.flush();
    expect(
      (await pool.query("SELECT access_granted FROM billing_accounts WHERE user_id=$1", [userId]))
        .rows[0].access_granted,
    ).toBe(false);
  });
  it("keeps cancellation-period and past-due granted benefits without changing host trust", async () => {
    const { service, paid } = fixture();
    const userId = randomUUID(),
      hostId = randomUUID();
    await pool.query(
      "INSERT INTO hosts(id,owner_user_id,owner_org_id,environment_id,name,platform,kind,public_key_jwk,key_generation) VALUES($1,$2,'test-org',$3,'Test','darwin','local','{}',7)",
      [hostId, userId, randomUUID()],
    );
    try {
      paid(userId, { cancelAtPeriodEnd: true });
      expect(await service.status(userId)).toMatchObject({
        access: "granted",
        cancelAtPeriodEnd: true,
        canCheckout: false,
      });
      paid(userId, { subscriptionStatus: "past_due", validUntil: null });
      expect(await service.status(userId)).toMatchObject({
        access: "granted",
        subscriptionStatus: "past_due",
        validUntil: null,
      });
      paid(userId, {
        subscriptionStatus: "canceled",
        accessGranted: false,
        hasSubscription: false,
      });
      expect(await service.status(userId)).toMatchObject({ access: "none", canCheckout: true });
      expect(
        (await pool.query("SELECT key_generation,public_key_jwk FROM hosts WHERE id=$1", [hostId]))
          .rows[0],
      ).toEqual({ key_generation: 7, public_key_jwk: {} });
    } finally {
      await pool.query("DELETE FROM hosts WHERE id=$1", [hostId]);
    }
  });
  it("retains a known grant through outage and durably retries deliveries after restart", async () => {
    const { service, provider, paid } = fixture();
    const userId = randomUUID();
    paid(userId);
    await service.status(userId);
    vi.mocked(provider.state).mockRejectedValue(new Error("upstream unavailable"));
    await expect(service.status(userId)).rejects.toThrow("upstream unavailable");
    expect(
      (await pool.query("SELECT access_granted FROM billing_accounts WHERE user_id=$1", [userId]))
        .rows[0].access_granted,
    ).toBe(true);
    await service.webhook(JSON.stringify({ eventId: randomUUID(), userId }), {});
    await service.flush();
    expect(
      (await pool.query("SELECT handled_at FROM billing_webhook_events")).rows[0].handled_at,
    ).toBeNull();
    const pending = (await pool.query("SELECT next_attempt_at FROM billing_webhook_events"))
      .rows[0];
    expect(pending.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    const restarted = createBillingService({ pool, provider });
    const failedReads = vi.mocked(provider.state).mock.calls.length;
    await restarted.flush();
    expect(provider.state).toHaveBeenCalledTimes(failedReads);
    vi.mocked(provider.state).mockResolvedValue(null);
    await pool.query("UPDATE billing_webhook_events SET next_attempt_at=now()-interval '1 second'");
    await restarted.flush();
    expect(
      (await pool.query("SELECT handled_at FROM billing_webhook_events")).rows[0].handled_at,
    ).toEqual(expect.any(Date));
    expect(
      (await pool.query("SELECT access_granted FROM billing_accounts WHERE user_id=$1", [userId]))
        .rows[0].access_granted,
    ).toBe(false);
  });
  it("does not acknowledge invalid signatures or failed durable writes", async () => {
    const { service, provider } = fixture();
    vi.mocked(provider.verify).mockRejectedValueOnce(new Error("bad signature"));
    await expect(service.webhook("{}", {})).rejects.toMatchObject({ status: 400 });
    expect((await pool.query("SELECT count(*) FROM billing_webhook_events")).rows[0].count).toBe(
      "0",
    );
    const query = vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("DB unavailable"));
    await expect(
      service.webhook(JSON.stringify({ eventId: randomUUID(), userId: randomUUID() }), {}),
    ).rejects.toThrow("DB unavailable");
    query.mockRestore();
  });
  it("permanently fences erasure and cancels known old-product renewals before identity deletion", async () => {
    const { service, provider, paid, states } = fixture();
    const userId = randomUUID();
    paid(userId);
    await service.status(userId);
    const originalProducts = states.get(userId)!.productIds;
    const deleteUser = vi.fn(async () => {});
    const deletion = createAccountDeletionService({
      db,
      billing: service,
      verifier: { deleteUser } as unknown as AccountIdentityVerifier,
    });
    await deletion.request(userId);
    await expect(service.status(userId)).rejects.toMatchObject({ status: 409 });
    await service.webhook(JSON.stringify({ eventId: randomUUID(), userId }), {});
    await service.flush();
    expect(provider.cancelRenewals).toHaveBeenCalledWith(userId, originalProducts);
    expect(
      (await pool.query("SELECT access_granted FROM billing_accounts WHERE user_id=$1", [userId]))
        .rows[0].access_granted,
    ).toBe(false);
    await pool.query(
      "UPDATE account_deletions SET next_attempt_at=now()-interval '1 second' WHERE user_id=$1",
      [userId],
    );
    vi.mocked(provider.cancelRenewals).mockRejectedValueOnce(new Error("provider offline"));
    await deletion.flush();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(
      (
        await pool.query(
          "SELECT customer_id,deleted_at,access_granted FROM billing_accounts WHERE user_id=$1",
          [userId],
        )
      ).rows[0],
    ).toMatchObject({
      customer_id: states.get(userId)!.customerId,
      deleted_at: expect.any(Date),
      access_granted: false,
    });
    await pool.query(
      "UPDATE account_deletions SET next_attempt_at=now()-interval '1 second' WHERE user_id=$1",
      [userId],
    );
    const restartedDeletion = createAccountDeletionService({
      db,
      billing: createBillingService({ pool, provider }),
      verifier: { deleteUser } as unknown as AccountIdentityVerifier,
    });
    await restartedDeletion.flush();
    expect(deleteUser).toHaveBeenCalledWith(userId);
    expect(vi.mocked(provider.cancelRenewals).mock.invocationCallOrder[0]).toBeLessThan(
      deleteUser.mock.invocationCallOrder[0]!,
    );
    await pool.query("DELETE FROM account_deletions WHERE user_id=$1", [userId]);
    await service.webhook(JSON.stringify({ eventId: randomUUID(), userId }), {});
    await service.flush();
    expect(
      (
        await pool.query(
          "SELECT deleted_at,access_granted,customer_id FROM billing_accounts WHERE user_id=$1",
          [userId],
        )
      ).rows[0],
    ).toMatchObject({ access_granted: false, customer_id: null });
  });
  it("keeps erasure fenced while its committed checkout POST or purchase is still uncertain", async () => {
    const { service, provider, checkouts, paid } = fixture();
    const userId = randomUUID();
    let attemptId = "";
    let release!: (checkout: BillingCheckout) => void;
    let started!: () => void;
    const posting = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(provider.checkout).mockImplementationOnce(
      async (_user, _email, _interval, attempt) => {
        attemptId = attempt;
        started();
        return new Promise<BillingCheckout>((resolve) => {
          release = resolve;
        });
      },
    );
    const request = service.checkout(userId, "a@example.com", "month");
    await posting;
    const deleteUser = vi.fn(async () => {});
    const deletion = createAccountDeletionService({
      db,
      billing: service,
      verifier: { deleteUser } as unknown as AccountIdentityVerifier,
    });
    await deletion.request(userId);
    async function tryErasure() {
      await pool.query(
        "UPDATE account_deletions SET next_attempt_at=now()-interval '1 second' WHERE user_id=$1",
        [userId],
      );
      await deletion.flush();
    }
    await tryErasure();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(provider.cancelRenewals).not.toHaveBeenCalled();
    expect(
      (
        await pool.query("SELECT checkout_attempt_id FROM billing_accounts WHERE user_id=$1", [
          userId,
        ])
      ).rows[0].checkout_attempt_id,
    ).toBe(attemptId);
    const checkout: BillingCheckout = {
      checkoutId: randomUUID(),
      url: "https://sandbox.polar.sh/checkout/late",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      productId: "test-month",
      status: "open",
    };
    checkouts.set(attemptId, checkout);
    release(checkout);
    await expect(request).rejects.toMatchObject({ status: 409 });
    await tryErasure();
    expect(deleteUser).not.toHaveBeenCalled();
    checkouts.set(attemptId, { ...checkout, status: "succeeded" });
    paid(userId, { settledCheckoutAttempts: [{ attemptId, productId: "test-year" }] });
    await tryErasure();
    expect(deleteUser).not.toHaveBeenCalled();
    paid(userId, { settledCheckoutAttempts: [{ attemptId, productId: "test-month" }] });
    await tryErasure();
    expect(provider.cancelRenewals).toHaveBeenCalledWith(userId, ["test-month"]);
    expect(deleteUser).toHaveBeenCalledWith(userId);
    expect(
      (
        await pool.query(
          "SELECT checkout_attempt_id,deleted_at,access_granted FROM billing_accounts WHERE user_id=$1",
          [userId],
        )
      ).rows[0],
    ).toMatchObject({
      checkout_attempt_id: null,
      deleted_at: expect.any(Date),
      access_granted: false,
    });
  });
  it("finishes billing erasure once its earlier unpaid checkout is positively expired", async () => {
    const { service, provider, checkouts } = fixture();
    const userId = randomUUID();
    await service.checkout(userId, "a@example.com", "month");
    const attemptId = [...checkouts.keys()][0]!;
    checkouts.set(attemptId, { ...checkouts.get(attemptId)!, status: "expired" });
    await pool.query(
      "UPDATE billing_accounts SET deleted_at=now(),access_granted=false WHERE user_id=$1",
      [userId],
    );
    await service.cleanupDeletedAccount(userId);
    expect(provider.cancelRenewals).toHaveBeenCalledWith(userId, ["test-month"]);
    expect(
      (
        await pool.query(
          "SELECT checkout_attempt_id,checkout_url,deleted_at FROM billing_accounts WHERE user_id=$1",
          [userId],
        )
      ).rows[0],
    ).toEqual({ checkout_attempt_id: null, checkout_url: null, deleted_at: expect.any(Date) });
  });
  it("maps signed customer deletion through stored customer ID and ignores unrelated Polar customers", async () => {
    const { service, provider, paid, states } = fixture();
    const userId = randomUUID();
    paid(userId);
    await service.status(userId);
    const customerId = states.get(userId)!.customerId;
    vi.mocked(provider.verify).mockResolvedValueOnce({
      eventId: "unrelated",
      customerId: randomUUID(),
    });
    await service.webhook("{}", {});
    expect((await pool.query("SELECT count(*) FROM billing_webhook_events")).rows[0].count).toBe(
      "0",
    );
    vi.mocked(provider.verify).mockResolvedValueOnce({ eventId: "deleted-customer", customerId });
    await service.webhook("{}", {});
    states.delete(userId);
    await service.flush();
    expect(
      (await pool.query("SELECT access_granted FROM billing_accounts WHERE user_id=$1", [userId]))
        .rows[0].access_granted,
    ).toBe(false);
  });
  it("retains cancellation intent while billing configuration is disabled", async () => {
    const { service, paid } = fixture();
    const userId = randomUUID();
    paid(userId);
    await service.status(userId);
    const deleteUser = vi.fn(async () => {});
    const deletion = createAccountDeletionService({
      db,
      verifier: { deleteUser } as unknown as AccountIdentityVerifier,
    });
    await deletion.request(userId);
    expect(
      (
        await pool.query(
          "SELECT deleted_at,access_granted FROM billing_accounts WHERE user_id=$1",
          [userId],
        )
      ).rows[0],
    ).toMatchObject({ deleted_at: expect.any(Date), access_granted: false });
    await pool.query(
      "UPDATE account_deletions SET next_attempt_at=now()-interval '1 second' WHERE user_id=$1",
      [userId],
    );
    await deletion.flush();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(
      (
        await pool.query("SELECT identity_deleted_at FROM account_deletions WHERE user_id=$1", [
          userId,
        ])
      ).rows[0].identity_deleted_at,
    ).toBeNull();
  });
});
