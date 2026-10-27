import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PolarBillingConfig } from "../config";
import { loadPolarBillingConfig } from "../config";
import { BillingCheckoutNotCreatedError, createPolarBillingProvider } from "./polar";

const config: PolarBillingConfig = {
  environment: "sandbox",
  accessToken: "test-only-token",
  webhookSecret: `whsec_${randomBytes(32).toString("base64")}`,
  organizationId: randomUUID(),
  monthlyProductId: randomUUID(),
  yearlyProductId: randomUUID(),
  desktopBenefitId: randomUUID(),
  checkoutSuccessUrl: "https://example.com/billing/return",
  portalReturnUrl: "https://example.com/settings",
};
const userId = "user_verified_session",
  customerId = randomUUID();
afterEach(() => vi.unstubAllGlobals());
function signed(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const eventId = randomUUID();
  return {
    "webhook-id": eventId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${createHmac(
      "sha256",
      Buffer.from(config.webhookSecret.slice(6), "base64"),
    )
      .update(`${eventId}.${timestamp}.${body}`)
      .digest("base64")}`,
  };
}
function upstream(
  options: {
    status?: string;
    granted?: boolean;
    externalId?: string;
    pending?: unknown[];
    pendingTotal?: number;
    pendingPages?: Record<number, unknown[]>;
    knownCheckout?: unknown;
    knownCheckoutErrorStatus?: number;
    productId?: string;
    subscriptionMetadata?: Record<string, unknown>;
    startedAt?: string | null;
    subscriptionCustomerId?: string;
    checkoutErrorStatus?: number;
  } = {},
) {
  const requests: { path: string; body: unknown }[] = [];
  const fake = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://sandbox-api.polar.sh");
    requests.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    let result: unknown;
    if (url.pathname === "/v1/checkouts/" && init?.method === "POST" && options.checkoutErrorStatus)
      return Response.json(
        {
          detail: [
            {
              loc: ["body", "customer_email"],
              msg: "private vendor validation text",
              input: "private@example.com",
            },
          ],
        },
        { status: options.checkoutErrorStatus },
      );
    if (url.pathname.includes("/customers/external/") && url.pathname.endsWith("/state"))
      result = {
        id: customerId,
        external_id: options.externalId ?? userId,
        organization_id: config.organizationId,
        type: "individual",
        deleted_at: null,
        granted_benefits:
          options.granted === false
            ? []
            : [{ benefit_id: config.desktopBenefitId, benefit_type: "feature_flag" }],
      };
    else if (url.pathname === "/v1/subscriptions/" && init?.method === "GET")
      result = {
        items: [
          {
            id: "sub_owned",
            product_id: options.productId ?? config.monthlyProductId,
            status: options.status ?? "active",
            customer: {
              id: options.subscriptionCustomerId ?? customerId,
              external_id: userId,
              organization_id: config.organizationId,
            },
            metadata: options.subscriptionMetadata ?? {},
            started_at:
              options.startedAt === undefined ? "2026-10-01T00:00:00Z" : options.startedAt,
            created_at: "2026-10-01T00:00:00Z",
            current_period_end: "2026-11-01T00:00:00Z",
            ends_at: null,
            cancel_at_period_end: false,
          },
        ],
        pagination: { total_count: 1, max_page: 1 },
      };
    else if (url.pathname.startsWith("/v1/products/")) {
      const id = url.pathname.split("/").at(-1)!;
      result = {
        id,
        organization_id: config.organizationId,
        is_archived: false,
        is_recurring: true,
        recurring_interval: id === config.monthlyProductId ? "month" : "year",
        recurring_interval_count: 1,
        benefits: [{ id: config.desktopBenefitId, type: "feature_flag" }],
        prices: [
          {
            id: "price_fixed",
            amount_type: "fixed",
            is_archived: false,
            price_amount: 1500,
            price_currency: "eur",
          },
        ],
      };
    } else if (url.pathname === "/v1/checkouts/" && init?.method === "GET")
      result = {
        items:
          options.pendingPages?.[Number(url.searchParams.get("page") ?? 1)] ??
          options.pending ??
          [],
        pagination: {
          total_count: options.pendingTotal ?? options.pending?.length ?? 0,
          max_page: Math.max(
            1,
            Math.ceil((options.pendingTotal ?? options.pending?.length ?? 0) / 100),
          ),
        },
      };
    else if (url.pathname.startsWith("/v1/checkouts/") && init?.method === "GET") {
      if (options.knownCheckoutErrorStatus)
        return Response.json(
          { detail: "Checkout unavailable" },
          { status: options.knownCheckoutErrorStatus },
        );
      result = options.knownCheckout;
    } else if (url.pathname === "/v1/checkouts/" && init?.method === "POST")
      result = {
        id: randomUUID(),
        organization_id: config.organizationId,
        external_customer_id: userId,
        metadata: JSON.parse(String(init.body)).metadata,
        products: JSON.parse(String(init.body)).products.map((id: string) => ({ id })),
        product_id: JSON.parse(String(init.body)).products[0],
        status: "open",
        url: "https://sandbox.polar.sh/checkout/test",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      };
    else if (url.pathname === "/v1/customer-sessions/")
      result = { customer_portal_url: "https://sandbox.polar.sh/test/portal" };
    else if (url.pathname === "/v1/subscriptions/sub_owned") result = {};
    else throw new Error(`Unexpected fake endpoint ${url.pathname}`);
    return Response.json(result);
  });
  vi.stubGlobal("fetch", fake);
  return { requests, fake };
}

describe("Polar sandbox protocol boundary", () => {
  it("verifies raw body signature and timestamp before accepting account scope", async () => {
    const provider = createPolarBillingProvider(config);
    const body = JSON.stringify({
      type: "customer.state_changed",
      data: { external_id: userId, organization_id: config.organizationId },
    });
    const headers = signed(body);
    expect(await provider.verify(body, headers)).toEqual({
      eventId: headers["webhook-id"],
      userId,
    });
    await expect(provider.verify(body + " ", headers)).rejects.toThrow();
    await expect(
      provider.verify(body, signed(body, Math.floor(Date.now() / 1000) - 600)),
    ).rejects.toThrow();
    const foreign = JSON.stringify({
      type: "customer.state_changed",
      data: { external_id: userId, organization_id: randomUUID() },
    });
    expect(await provider.verify(foreign, signed(foreign))).toBeNull();
    const unmapped = JSON.stringify({
      type: "customer.state_changed",
      data: { organization_id: config.organizationId },
    });
    expect(await provider.verify(unmapped, signed(unmapped))).toBeNull();
    const deleted = JSON.stringify({
      type: "customer.state_changed",
      data: { id: customerId, external_id: null, organization_id: config.organizationId },
    });
    expect(await provider.verify(deleted, signed(deleted))).toMatchObject({ customerId });
    const future = JSON.stringify({ type: "a.future.event", data: {} });
    expect(await provider.verify(future, signed(future))).toBeNull();
    await expect(provider.verify(future, {})).rejects.toThrow();
  });
  it("reads authoritative sandbox catalog and binds checkout/portal to verified immutable identity", async () => {
    const { requests } = upstream();
    const provider = createPolarBillingProvider(config);
    expect(await provider.plans()).toEqual([
      { interval: "month", amountMinor: 1500, currency: "EUR" },
      { interval: "year", amountMinor: 1500, currency: "EUR" },
    ]);
    await provider.preflightCheckout(userId, []);
    await provider.checkout(userId, "verified@example.com", "year", "attempt-created", "127.0.0.1");
    expect(requests.find((item) => item.path === "/v1/checkouts/" && item.body)?.body).toEqual({
      products: [config.yearlyProductId],
      external_customer_id: userId,
      customer_email: "verified@example.com",
      metadata: { synara_checkout_attempt_id: "attempt-created" },
      customer_ip_address: "127.0.0.1",
      success_url: config.checkoutSuccessUrl,
      return_url: config.portalReturnUrl,
      allow_discount_codes: false,
    });
    await provider.portal(userId);
    expect(requests.at(-1)?.body).toEqual({
      external_customer_id: userId,
      return_url: config.portalReturnUrl,
    });
  });
  it("classifies only checkout schema 422 as definitely not created without exposing vendor detail", async () => {
    upstream({ checkoutErrorStatus: 422 });
    const provider = createPolarBillingProvider(config);
    const refused = await provider
      .checkout(userId, "private@example.com", "month", randomUUID())
      .catch((error) => error);
    expect(refused).toBeInstanceOf(BillingCheckoutNotCreatedError);
    expect(refused.message).not.toContain("private");
    expect(refused.cause).toBeUndefined();
    upstream({ checkoutErrorStatus: 503 });
    const ambiguous = await provider
      .checkout(userId, "private@example.com", "month", randomUUID())
      .catch((error) => error);
    expect(ambiguous).not.toBeInstanceOf(BillingCheckoutNotCreatedError);
  });
  it("honors granted benefits during past-due recovery and refuses mismatched identity", async () => {
    upstream({ status: "past_due", granted: true });
    const provider = createPolarBillingProvider(config);
    expect(await provider.state(userId)).toMatchObject({
      accessGranted: true,
      subscriptionStatus: "past_due",
      validUntil: null,
      hasSubscription: true,
    });
    upstream({ externalId: "other_user" });
    await expect(provider.state(userId)).rejects.toThrow("scope mismatch");
  });
  it("proves purchase settlement only from matching started subscription metadata", async () => {
    const attemptId = randomUUID();
    const options = {
      status: "canceled",
      granted: false,
      subscriptionMetadata: { synara_checkout_attempt_id: attemptId },
    };
    upstream(options);
    const provider = createPolarBillingProvider(config);
    expect(await provider.state(userId)).toMatchObject({
      hasSubscription: false,
      accessGranted: false,
      settledCheckoutAttempts: [{ attemptId, productId: config.monthlyProductId }],
    });
    upstream({ ...options, startedAt: null });
    expect((await provider.state(userId))?.settledCheckoutAttempts).toEqual([]);
    upstream({ ...options, subscriptionCustomerId: randomUUID() });
    expect((await provider.state(userId))?.settledCheckoutAttempts).toEqual([]);
  });
  it("recovers a pending provider checkout after a lost local write without creating another", async () => {
    const { fake } = upstream({
      pending: [
        {
          id: randomUUID(),
          organization_id: config.organizationId,
          external_customer_id: userId,
          metadata: { synara_checkout_attempt_id: "attempt-recovered" },
          products: [{ id: config.monthlyProductId }],
          product_id: config.monthlyProductId,
          status: "open",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          url: "https://sandbox.polar.sh/checkout/recovered",
        },
      ],
    });
    expect(
      await createPolarBillingProvider(config).recoverCheckout(
        userId,
        "attempt-recovered",
        config.monthlyProductId,
      ),
    ).toMatchObject({ url: "https://sandbox.polar.sh/checkout/recovered" });
    expect(fake).toHaveBeenCalledTimes(1);
  });
  it("recovers an unconfirmed checkout among other customers without relying on email or a Customer row", async () => {
    const attemptId = randomUUID();
    const pending = {
      id: randomUUID(),
      organization_id: config.organizationId,
      external_customer_id: userId,
      customer_id: null,
      metadata: { synara_checkout_attempt_id: attemptId },
      products: [{ id: config.monthlyProductId }],
      product_id: config.monthlyProductId,
      status: "open",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      url: "https://sandbox.polar.sh/checkout/unconfirmed",
    };
    const other = {
      ...pending,
      external_customer_id: "other_user",
      metadata: { synara_checkout_attempt_id: randomUUID() },
    };
    const { fake } = upstream({ pending: [other, pending] });
    const provider = createPolarBillingProvider(config);
    expect(
      await provider.recoverCheckout(userId, attemptId, config.monthlyProductId),
    ).toMatchObject({ status: "open" });
    const lookup = new URL(String(fake.mock.calls[0]![0]));
    expect(lookup.searchParams.has("external_customer_id")).toBe(false);
    expect(lookup.searchParams.has("query")).toBe(false);
    expect(lookup.searchParams.getAll("product_id")).toEqual([config.monthlyProductId]);
    await expect(provider.preflightCheckout(userId, [])).rejects.toThrow("earlier");
    upstream({ pending: [other] });
    await expect(provider.preflightCheckout(userId, [])).resolves.toBeUndefined();
    upstream({ pending: [{ ...pending, external_customer_id: "other_user" }] });
    await expect(
      provider.recoverCheckout(userId, attemptId, config.monthlyProductId),
    ).rejects.toThrow("scope mismatch");
    upstream({ pending: [], pendingTotal: 1001 });
    await expect(
      provider.recoverCheckout(userId, attemptId, config.monthlyProductId),
    ).rejects.toThrow("incomplete");
    await expect(provider.preflightCheckout(userId, [])).rejects.toThrow("incomplete");
  });
  it("uses a known checkout ID directly and keeps a missing or mismatched session fenced", async () => {
    const checkoutId = randomUUID(),
      attemptId = randomUUID();
    const checkout = {
      id: checkoutId,
      organization_id: config.organizationId,
      external_customer_id: userId,
      metadata: { synara_checkout_attempt_id: attemptId },
      products: [{ id: config.monthlyProductId }],
      product_id: config.monthlyProductId,
      status: "open",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      url: "https://sandbox.polar.sh/checkout/known",
    };
    const { fake } = upstream({ knownCheckout: checkout, pendingTotal: 5000 });
    const provider = createPolarBillingProvider(config);
    expect(
      await provider.recoverCheckout(userId, attemptId, config.monthlyProductId, checkoutId),
    ).toMatchObject({ checkoutId, status: "open" });
    expect(fake).toHaveBeenCalledTimes(1);
    expect(new URL(String(fake.mock.calls[0]![0])).pathname).toBe(`/v1/checkouts/${checkoutId}`);
    upstream({ knownCheckoutErrorStatus: 404 });
    await expect(
      provider.recoverCheckout(userId, attemptId, config.monthlyProductId, checkoutId),
    ).rejects.toThrow();
    upstream({ knownCheckout: { ...checkout, external_customer_id: "other_user" } });
    await expect(
      provider.recoverCheckout(userId, attemptId, config.monthlyProductId, checkoutId),
    ).rejects.toThrow("scope mismatch");
  });
  it("finds an unknown attempt on page two and never treats a capped scan as proof of absence", async () => {
    const attemptId = randomUUID();
    const checkout = {
      id: randomUUID(),
      organization_id: config.organizationId,
      external_customer_id: userId,
      metadata: { synara_checkout_attempt_id: attemptId },
      products: [{ id: config.monthlyProductId }],
      product_id: config.monthlyProductId,
      status: "open",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      url: "https://sandbox.polar.sh/checkout/page-two",
    };
    const others = Array.from({ length: 100 }, () => ({
      ...checkout,
      id: randomUUID(),
      external_customer_id: "other_user",
      metadata: { synara_checkout_attempt_id: randomUUID() },
    }));
    const { fake } = upstream({ pendingPages: { 1: others, 2: [checkout] }, pendingTotal: 101 });
    const provider = createPolarBillingProvider(config);
    expect(
      await provider.recoverCheckout(userId, attemptId, config.monthlyProductId),
    ).toMatchObject({ checkoutId: checkout.id });
    expect(fake).toHaveBeenCalledTimes(2);
    expect(new URL(String(fake.mock.calls[1]![0])).searchParams.get("page")).toBe("2");
    expect(new URL(String(fake.mock.calls[1]![0])).searchParams.getAll("sorting")).toEqual([
      "-created_at",
    ]);
    const capped = upstream({ pendingPages: { 1: [checkout] }, pendingTotal: 1001 });
    expect(
      await provider.recoverCheckout(userId, attemptId, config.monthlyProductId),
    ).toMatchObject({ checkoutId: checkout.id });
    expect(capped.fake).toHaveBeenCalledTimes(10);
    upstream({ pendingPages: {}, pendingTotal: 1001 });
    await expect(
      provider.recoverCheckout(userId, attemptId, config.monthlyProductId),
    ).rejects.toThrow("incomplete");
    await expect(provider.preflightCheckout(userId, [])).rejects.toThrow("incomplete");
  });
  it("cancels renewals for previously purchased catalog IDs while preserving customer scope", async () => {
    const oldProductId = randomUUID();
    const { requests } = upstream({ productId: oldProductId });
    await createPolarBillingProvider(config).cancelRenewals(userId, [oldProductId]);
    expect(requests.at(-1)).toEqual({
      path: "/v1/subscriptions/sub_owned",
      body: { cancel_at_period_end: true },
    });
  });
});

describe("sandbox billing operator configuration", () => {
  it("stays disabled by default and refuses production, partial configuration and unsafe return URLs", () => {
    expect(loadPolarBillingConfig({})).toBeUndefined();
    expect(
      loadPolarBillingConfig({ POLAR_BILLING_ENABLED: "false", POLAR_ENVIRONMENT: "production" }),
    ).toBeUndefined();
    expect(() =>
      loadPolarBillingConfig({ POLAR_BILLING_ENABLED: "true", POLAR_ENVIRONMENT: "production" }),
    ).toThrow("sandbox");
    expect(() =>
      loadPolarBillingConfig({ POLAR_BILLING_ENABLED: "true", POLAR_ENVIRONMENT: "sandbox" }),
    ).toThrow("Missing required");
    const env = {
      POLAR_BILLING_ENABLED: "true",
      POLAR_ENVIRONMENT: "sandbox",
      POLAR_ACCESS_TOKEN: config.accessToken,
      POLAR_WEBHOOK_SECRET: config.webhookSecret,
      POLAR_ORGANIZATION_ID: config.organizationId,
      POLAR_MONTHLY_PRODUCT_ID: config.monthlyProductId,
      POLAR_YEARLY_PRODUCT_ID: config.yearlyProductId,
      POLAR_DESKTOP_BENEFIT_ID: config.desktopBenefitId,
      POLAR_CHECKOUT_SUCCESS_URL: config.checkoutSuccessUrl,
      POLAR_PORTAL_RETURN_URL: config.portalReturnUrl,
    };
    expect(loadPolarBillingConfig(env)).toEqual(config);
    expect(() =>
      loadPolarBillingConfig({
        ...env,
        POLAR_CHECKOUT_SUCCESS_URL: "https://username:password@example.com/",
      }),
    ).toThrow("without credentials");
    expect(() =>
      loadPolarBillingConfig({ ...env, POLAR_PORTAL_RETURN_URL: "http://outside.example.com/" }),
    ).toThrow("HTTPS");
  });
});
