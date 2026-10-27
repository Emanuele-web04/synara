import type { AccountErrorBody } from "@synara/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as billingModule from "./billing/service";
import { randomUUID } from "node:crypto";
import { createIsolatedTestDatabase } from "./testing/isolatedDatabase";
import { API_MAX_BODY_BYTES, createApp } from "./app";
import type { ApiConfig } from "./config";
import { runMigrations } from "./db/migrate";
import { startFakeWorkos, type FakeWorkos } from "./testing/fakeWorkos";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** A syntactically plausible OTP-send body padded to exactly `size` bytes. */
function oversizedSendBody(size: number): string {
  return `{"email":"a@example.com","pad":"${"x".repeat(size)}"}`.slice(0, size);
}

describe.skipIf(!TEST_DATABASE_URL)("createApp", () => {
  const databaseUrl = TEST_DATABASE_URL as string;

  let workos: FakeWorkos;
  let baseConfig: ApiConfig;
  let pool: Awaited<ReturnType<typeof createApp>>["pool"];

  beforeAll(async () => {
    await runMigrations(databaseUrl);
    workos = await startFakeWorkos();
    baseConfig = workos.config({ databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
    await workos.close();
  });

  it("serves v1 instance info", async () => {
    const built = await createApp(baseConfig);
    pool = built.pool;
    expect(built.flushBilling).toBeUndefined();

    const res = await built.app.request("/api/v1/instance");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string };
    expect(body.version).toBeTruthy();
  });

  it("keeps housekeeping independent while configured sandbox billing is stalled", async () => {
    let releaseBilling!: () => void;
    let finishedBilling = false;
    const stalled = new Promise<void>((resolve) => {
      releaseBilling = resolve;
    }).then(() => {
      finishedBilling = true;
    });
    const originalCreateBilling = billingModule.createBillingService;
    const factory = vi
      .spyOn(billingModule, "createBillingService")
      .mockImplementation((options) => ({
        ...originalCreateBilling(options),
        flush: () => stalled,
      }));
    let built: Awaited<ReturnType<typeof createApp>> | undefined;
    const isolated = await createIsolatedTestDatabase(databaseUrl);
    try {
      built = await createApp({
        ...baseConfig,
        databaseUrl: isolated.url,
        polarBilling: {
          environment: "sandbox",
          accessToken: "test-only",
          webhookSecret: "test-only",
          organizationId: randomUUID(),
          monthlyProductId: randomUUID(),
          yearlyProductId: randomUUID(),
          desktopBenefitId: randomUUID(),
          checkoutSuccessUrl: "https://example.com/return",
          portalReturnUrl: "https://example.com/return",
        },
      });
      expect(built.flushBilling).toBeTypeOf("function");
      const inFlight = built.flushBilling!();
      await built.cleanup();
      expect(finishedBilling).toBe(false);
      releaseBilling();
      await inFlight;
      expect(finishedBilling).toBe(true);
    } finally {
      releaseBilling();
      factory.mockRestore();
      await built?.pool.end();
      await isolated.close();
    }
  });

  it.each([
    { path: "/api/v1/hosts/retired/relay-ticket", method: "POST", status: 410 },
    { path: "/internal/revocations?after=0", method: "GET", status: 401 },
  ])("keeps the retired relay endpoint $path disabled", async ({ path, method, status }) => {
    const built = await createApp(baseConfig);
    try {
      const response = await built.app.request(path, {
        method,
        headers: { authorization: "Bearer retired-relay-credential" },
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({
        error: status === 410 ? "validation_failed" : "unauthorized",
      });
    } finally {
      await built.pool.end();
    }
  });

  it("returns a JSON AccountErrorBody for unknown API routes", async () => {
    const built = await createApp(baseConfig);
    pool = built.pool;

    const res = await built.app.request("/api/v1/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as AccountErrorBody;
    expect(body.error).toBe("validation_failed");
    expect(typeof body.message).toBe("string");
  });

  // The net under every /api/ route: whatever throws, the client still gets the
  // documented JSON shape instead of Hono's plain-text "Internal Server Error".
  it("maps an unhandled throw under /api/ onto the error contract", async () => {
    const built = await createApp(baseConfig);
    pool = built.pool;

    built.app.get("/api/v1/boom", () => {
      throw new Error("simulated downstream failure");
    });

    const res = await built.app.request("/api/v1/boom");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as AccountErrorBody;
    expect(body.error).toBe("internal_error");
    expect(typeof body.message).toBe("string");
  });

  // An unauthenticated caller must not be able to make the server buffer an
  // arbitrarily large body before schema validation runs. At the boundary the
  // limiter admits the request (it then fails ordinary validation); one byte
  // over answers 413 in the documented error shape.
  it("rejects a request body over the size limit with a 413 error body", async () => {
    const built = await createApp(baseConfig);
    pool = built.pool;

    const post = (body: string) =>
      built.app.request("/api/v1/auth/otp/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

    const atLimit = await post(oversizedSendBody(API_MAX_BODY_BYTES));
    expect(atLimit.status).not.toBe(413);

    const oneOver = await post(oversizedSendBody(API_MAX_BODY_BYTES + 1));
    expect(oneOver.status).toBe(413);
    const body = (await oneOver.json()) as AccountErrorBody;
    expect(body.error).toBe("validation_failed");
    expect(body.message).not.toContain("x".repeat(32));
  });

  it("points non-API paths at the repo instead of returning the API error body", async () => {
    const built = await createApp(baseConfig);
    pool = built.pool;

    const res = await built.app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("Sign in from the Synara app");
    expect(body).toContain("https://github.com/Emanuele-web04/synara");
  });
});
