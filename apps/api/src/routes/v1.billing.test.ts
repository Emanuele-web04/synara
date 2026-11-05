import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db";
import { createIsolatedTestDatabase } from "../testing/isolatedDatabase";
import { createV1Routes } from "./v1";
import { createWorkosIdentityProvider } from "../identity/workos";
import { createApiSigningService } from "../identity/signing";
import { createDeviceRegistry } from "../identity/deviceRegistry";
import { createHostKeyRegistry } from "../identity/hostKeyRegistry";
import { createHostGrantIssuer } from "../identity/grantIssuer";
import { createHostSecretStore } from "../identity/hostSecretStore";
import { startFakeWorkos } from "../testing/fakeWorkos";
import type { BillingProvider } from "../billing/polar";
import { createBillingService } from "../billing/service";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("authenticated sandbox billing API", () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let database: ReturnType<typeof createDb>;
  let workos: Awaited<ReturnType<typeof startFakeWorkos>>;
  let deps: Parameters<typeof createV1Routes>[0];
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!);
    database = createDb(isolated.url);
    workos = await startFakeWorkos();
    const config = workos.config({ databaseUrl: isolated.url });
    const { verifier, grants } = createWorkosIdentityProvider(config);
    const signing = await createApiSigningService({
      issuer: config.apiPublicUrl,
      seed: config.apiSigningKey,
    });
    deps = {
      verifier,
      grants,
      signing,
      hostKeys: createHostKeyRegistry(database.db, config.apiPublicUrl),
      devices: createDeviceRegistry(database.db, config.apiPublicUrl),
      hostGrants: createHostGrantIssuer(signing),
      hostSecrets: createHostSecretStore(database.db),
      accountBaseUrl: config.baseUrl,
      db: database.db,
    };
  });
  beforeEach(() =>
    database.pool.query(
      "TRUNCATE billing_environment,billing_accounts,billing_webhook_events,account_deletions",
    ),
  );
  afterAll(async () => {
    await workos?.close();
    await database?.pool.end();
    await isolated?.close();
  });
  async function login() {
    const user = workos.addUser({ first_name: "Sandbox" });
    const token = await workos.signAccessToken({ sub: user.id, sid: `session_${randomUUID()}` });
    return {
      user,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    };
  }
  function fixture(environment: BillingProvider["environment"] = "sandbox") {
    const provider: BillingProvider = {
      environment,
      plans: vi.fn(async () => [
        { interval: "month" as const, amountMinor: 1500, currency: "EUR" },
      ]),
      state: vi.fn(async () => null),
      productId: () => "test-product",
      preflightCheckout: vi.fn(async () => {}),
      recoverCheckout: vi.fn(async () => null),
      checkout: vi.fn(async () => ({
        checkoutId: randomUUID(),
        status: "open" as const,
        url: "https://sandbox.polar.sh/checkout/test",
        productId: "test-product",
        expiresAt: "2027-01-01T00:00:00Z",
      })),
      portal: vi.fn(async () => "https://sandbox.polar.sh/test/portal"),
      cancelRenewals: vi.fn(async () => {}),
      verify: vi.fn(async () => null),
    };
    const billing = createBillingService({ pool: database.pool, provider });
    const app = new Hono().route("/api/v1", createV1Routes({ ...deps, billing }));
    return { app, provider, billing };
  }
  it("requires a verified session even when disabled, and labels disabled sandbox status", async () => {
    const app = new Hono().route("/api/v1", createV1Routes(deps));
    expect((await app.request("/api/v1/billing/status")).status).toBe(401);
    const { headers } = await login();
    const response = await app.request("/api/v1/billing/status", { headers });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      environment: "sandbox",
      available: false,
      canCheckout: false,
      canManage: false,
      plans: [],
    });
    expect(
      (
        await app.request("/api/v1/billing/checkout", {
          method: "POST",
          headers,
          body: JSON.stringify({ interval: "month" }),
        })
      ).status,
    ).toBe(503);
  });
  it("ignores attacker-selected account/email/product/redirect fields and binds all calls to caller A", async () => {
    const { app, provider } = fixture();
    const a = await login(),
      b = await login();
    const response = await app.request("/api/v1/billing/checkout", {
      method: "POST",
      headers: a.headers,
      body: JSON.stringify({
        interval: "month",
        userId: b.user.id,
        email: b.user.email,
        productId: randomUUID(),
        successUrl: "https://attacker.invalid",
      }),
    });
    expect(response.status).toBe(200);
    expect(provider.checkout).toHaveBeenCalledWith(
      a.user.id,
      a.user.email,
      "month",
      expect.any(String),
      undefined,
    );
    expect(provider.state).not.toHaveBeenCalledWith(b.user.id, expect.anything());
    expect((await database.pool.query("SELECT user_id FROM billing_accounts")).rows).toEqual([
      { user_id: a.user.id },
    ]);
    expect(
      (await app.request("/api/v1/billing/portal", { method: "POST", headers: b.headers })).status,
    ).toBe(409);
    expect(provider.portal).not.toHaveBeenCalled();
  });
  it("returns sanitized unavailable errors and refuses invalid checkout interval", async () => {
    const { app, provider } = fixture();
    const { headers } = await login();
    const invalid = await app.request("/api/v1/billing/checkout", {
      method: "POST",
      headers,
      body: JSON.stringify({ interval: "lifetime" }),
    });
    expect(invalid.status).toBe(400);
    vi.mocked(provider.plans).mockRejectedValue(new Error("secret-upstream-token"));
    const response = await app.request("/api/v1/billing/status", { headers });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret-upstream-token");
  });
  it("refuses a mixed billing environment before purchases or webhook acknowledgement", async () => {
    await fixture().billing.initialize();
    const { app, provider } = fixture("production");
    const { headers } = await login();
    const checkout = await app.request("/api/v1/billing/checkout", {
      method: "POST",
      headers,
      body: JSON.stringify({ interval: "month" }),
    });
    expect(checkout.status).toBe(503);
    const webhook = await app.request("/api/v1/billing/webhook", { method: "POST", body: "{}" });
    expect(webhook.status).toBe(503);
    expect(provider.plans).not.toHaveBeenCalled();
    expect(provider.checkout).not.toHaveBeenCalled();
    expect(provider.verify).not.toHaveBeenCalled();
    expect(
      (await database.pool.query("SELECT count(*) FROM billing_webhook_events")).rows[0].count,
    ).toBe("0");
  });
  it("keeps webhook auth independent of user bearer tokens and only acknowledges durable acceptance", async () => {
    const { app, provider } = fixture();
    vi.mocked(provider.verify).mockRejectedValueOnce(new Error("signature mismatch"));
    const invalid = await app.request("/api/v1/billing/webhook", { method: "POST", body: "{}" });
    expect(invalid.status).toBe(400);
    const valid = await app.request("/api/v1/billing/webhook", { method: "POST", body: "{}" });
    expect(valid.status).toBe(202);
    vi.mocked(provider.verify).mockResolvedValueOnce({
      eventId: randomUUID(),
      userId: randomUUID(),
    });
    const query = vi
      .spyOn(database.pool, "query")
      .mockRejectedValueOnce(new Error("sensitive DB address"));
    const failed = await app.request("/api/v1/billing/webhook", { method: "POST", body: "{}" });
    query.mockRestore();
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("sensitive DB address");
  });
});
