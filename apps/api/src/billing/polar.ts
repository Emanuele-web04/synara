// Polar protocol stays here; callers receive only account-scoped commercial facts.
import { createPolar, errors, webhooks, type models } from "@polar-sh/sdk/2026-10";
import type {
  AccountBillingEnvironment,
  AccountBillingInterval,
  AccountBillingStatus,
} from "@synara/contracts";
import { assertPolarBillingConfig, type PolarBillingConfig } from "../config";

// Only a documented checkout-request validation refusal proves no session was created.
export class BillingCheckoutNotCreatedError extends Error {
  constructor() {
    super("Polar rejected the checkout details before creation");
    this.name = "BillingCheckoutNotCreatedError";
  }
}

export type BillingSnapshot = {
  customerId: string;
  accessGranted: boolean;
  subscriptionStatus: string | null;
  validUntil: string | null;
  cancelAtPeriodEnd: boolean;
  hasSubscription: boolean;
  productIds: readonly string[];
  settledCheckoutAttempts: readonly { attemptId: string; productId: string }[];
};
export type BillingCheckout = {
  checkoutId: string;
  url: string;
  expiresAt: string;
  productId: string;
  status: "open" | "expired" | "confirmed" | "succeeded" | "failed";
};
export type BillingProvider = {
  readonly environment: AccountBillingEnvironment;
  plans(): Promise<AccountBillingStatus["plans"]>;
  state(userId: string, knownProductIds?: readonly string[]): Promise<BillingSnapshot | null>;
  productId(interval: AccountBillingInterval): string;
  preflightCheckout(userId: string, knownProductIds: readonly string[]): Promise<void>;
  recoverCheckout(
    userId: string,
    attemptId: string,
    expectedProductId: string,
    checkoutId?: string,
  ): Promise<BillingCheckout | null>;
  checkout(
    userId: string,
    email: string,
    interval: AccountBillingInterval,
    attemptId: string,
    ip?: string,
  ): Promise<BillingCheckout>;
  portal(userId: string): Promise<string>;
  cancelRenewals(userId: string, knownProductIds?: readonly string[]): Promise<void>;
  verify(
    body: string,
    headers: Record<string, string>,
  ): Promise<{ eventId: string; userId?: string; customerId?: string } | null>;
};

const safeUrl = (value: string, environment: AccountBillingEnvironment) => {
  const url = new URL(value);
  const expectedOrigin =
    environment === "sandbox" ? "https://sandbox.polar.sh" : "https://polar.sh";
  if (url.origin !== expectedOrigin || url.username || url.password)
    throw new Error("Unexpected Polar billing URL");
  return url.href;
};

export function createPolarBillingProvider(config: PolarBillingConfig): BillingProvider {
  assertPolarBillingConfig(config);
  const polar = createPolar({
    accessToken: config.accessToken,
    environment: config.environment,
    organizationId: config.organizationId,
    timeout: 10,
  });
  const ids = [config.monthlyProductId, config.yearlyProductId];
  const productId = (interval: AccountBillingInterval) =>
    interval === "month" ? ids[0]! : ids[1]!;
  async function customerState(userId: string) {
    try {
      const state = await polar.customers.getStateExternal(userId);
      if (
        state.organization_id !== config.organizationId ||
        state.external_id !== userId ||
        state.type !== "individual"
      )
        throw new Error("Polar customer scope mismatch");
      return state;
    } catch (error) {
      if (error instanceof errors.ResourceNotFound) return null;
      throw error;
    }
  }
  async function subscriptions(userId: string, knownProductIds: readonly string[] = []) {
    const scopedIds = [...new Set([...ids, ...knownProductIds])];
    const result = await polar.subscriptions.list({
      organization_id: config.organizationId,
      external_customer_id: userId,
      product_id: scopedIds,
      limit: 100,
    });
    // Refuse a truncated/ambiguous commercial state rather than accidentally permitting another purchase.
    if (result.pagination.total_count > 100) throw new Error("Too many Polar subscriptions");
    if (
      result.items.some(
        (item) =>
          item.customer.external_id !== userId ||
          item.customer.organization_id !== config.organizationId ||
          !scopedIds.includes(item.product_id),
      )
    )
      throw new Error("Polar subscription scope mismatch");
    return result.items.toSorted((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async function listCheckouts(productIds: readonly string[], status?: models.CheckoutStatus[]) {
    const items: models.Checkout[] = [];
    // This fallback is for an unknown POST outcome. Known sessions use their ID.
    // A bounded, incomplete scan can recover a match, but cannot prove absence.
    for (let page = 1; page <= 10; page++) {
      const result = await polar.checkouts.list({
        organization_id: config.organizationId,
        product_id: [...productIds],
        ...(status ? { status } : {}),
        sorting: ["-created_at"],
        page,
        limit: 100,
      });
      if (
        result.items.some(
          (item) =>
            item.organization_id !== config.organizationId ||
            !item.products.some((product) => productIds.includes(product.id)),
        )
      )
        throw new Error("Polar checkout scope mismatch");
      items.push(...result.items);
      if (page >= result.pagination.max_page) return { items, complete: true };
    }
    return { items, complete: false };
  }
  function checkoutResult(
    checkout: models.Checkout,
    userId: string,
    attemptId: string,
    expectedProductId: string,
  ): BillingCheckout {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(checkout.id) ||
      checkout.organization_id !== config.organizationId ||
      checkout.external_customer_id !== userId ||
      checkout.metadata.synara_checkout_attempt_id !== attemptId ||
      checkout.products.length !== 1 ||
      checkout.products[0]?.id !== expectedProductId ||
      (checkout.product_id !== null && checkout.product_id !== expectedProductId)
    )
      throw new Error("Polar checkout attempt scope mismatch");
    if (!["open", "expired", "confirmed", "succeeded", "failed"].includes(checkout.status))
      throw new Error("Unknown Polar checkout state");
    return {
      checkoutId: checkout.id,
      url: safeUrl(checkout.url, config.environment),
      expiresAt: checkout.expires_at,
      productId: expectedProductId,
      status: checkout.status,
    };
  }
  const currentStates = new Set(["active", "trialing", "past_due", "incomplete", "paused"]);
  return {
    environment: config.environment,
    async plans() {
      return Promise.all(
        (["month", "year"] as const).map(async (interval) => {
          const product = await polar.products.get(productId(interval));
          if (
            product.organization_id !== config.organizationId ||
            product.is_archived ||
            !product.is_recurring ||
            product.recurring_interval !== interval ||
            product.recurring_interval_count !== 1 ||
            !product.benefits.some(
              (benefit) =>
                benefit.id === config.desktopBenefitId && benefit.type === "feature_flag",
            )
          )
            throw new Error("Polar catalog is not configured for this plan");
          const prices = product.prices.filter((price) => !price.is_archived);
          const price = prices[0];
          if (
            prices.length !== 1 ||
            !price ||
            price.amount_type !== "fixed" ||
            !Number.isSafeInteger(price.price_amount) ||
            price.price_amount <= 0 ||
            !/^[a-z]{3}$/.test(price.price_currency)
          )
            throw new Error("Polar plan requires one fixed catalog price");
          if (
            config.environment === "production" &&
            (product.trial_interval !== null || product.trial_interval_count !== null)
          )
            throw new Error("Production Polar catalog must not configure a trial");
          const expected = config.expectedCatalog;
          if (
            expected &&
            (price.price_currency.toUpperCase() !== expected.currency ||
              price.price_amount !==
                (interval === "month" ? expected.monthlyAmountMinor : expected.yearlyAmountMinor) ||
              price.tax_behavior !== expected.taxBehavior)
          )
            throw new Error(
              "Polar catalog does not match the expected price, currency or tax behavior",
            );
          return {
            interval,
            amountMinor: price.price_amount,
            currency: price.price_currency.toUpperCase(),
          };
        }),
      );
    },
    async state(userId, knownProductIds) {
      const customer = await customerState(userId);
      if (!customer || customer.deleted_at) return null;
      const all = await subscriptions(userId, knownProductIds);
      const subscription = all.find((item) => currentStates.has(item.status)) ?? all[0];
      const granted = customer.granted_benefits.some(
        (benefit) =>
          benefit.benefit_id === config.desktopBenefitId && benefit.benefit_type === "feature_flag",
      );
      return {
        customerId: customer.id,
        productIds: all.map((item) => item.product_id),
        // Checkout metadata is copied to its subscription. A started subscription
        // settles only that exact purchase, even if it ended before our first sync.
        settledCheckoutAttempts: all.flatMap((item) => {
          const attemptId = item.metadata.synara_checkout_attempt_id;
          return item.customer.id === customer.id &&
            typeof item.started_at === "string" &&
            Number.isFinite(Date.parse(item.started_at)) &&
            typeof attemptId === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)
            ? [{ attemptId, productId: item.product_id }]
            : [];
        }),
        accessGranted: granted,
        subscriptionStatus: subscription?.status ?? null,
        // A past-due benefit can remain granted during Polar's configured grace period.
        validUntil:
          subscription && subscription.status !== "past_due"
            ? (subscription.ends_at ?? subscription.current_period_end)
            : null,
        cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? false,
        hasSubscription: all.some((item) => currentStates.has(item.status)),
      };
    },
    productId,
    async recoverCheckout(userId, attemptId, expectedProductId, checkoutId) {
      if (checkoutId) {
        const checkout = await polar.checkouts.get(checkoutId);
        if (checkout.id !== checkoutId) throw new Error("Polar checkout ID mismatch");
        return checkoutResult(checkout, userId, attemptId, expectedProductId);
      }
      // Polar's external-customer filter joins an existing Customer, which is
      // absent before the first confirmation. Authority remains the exact attempt.
      const candidates = await listCheckouts([expectedProductId]);
      const found = candidates.items.filter(
        (item) => item.metadata.synara_checkout_attempt_id === attemptId,
      );
      if (found.length > 1) throw new Error("Ambiguous Polar checkout attempt");
      if (found[0]) return checkoutResult(found[0], userId, attemptId, expectedProductId);
      if (!candidates.complete) throw new Error("Polar checkout recovery scan is incomplete");
      return null;
    },
    async preflightCheckout(userId, knownProductIds) {
      const scopedIds = new Set([...ids, ...knownProductIds]);
      const candidates = await listCheckouts([...scopedIds], ["open", "confirmed"]);
      const pending = candidates.items.some(
        (item) =>
          item.external_customer_id === userId &&
          (item.status === "open" || item.status === "confirmed"),
      );
      if (pending) throw new Error("An earlier Polar checkout still requires verification");
      if (!candidates.complete) throw new Error("Polar checkout preflight scan is incomplete");
    },
    async checkout(userId, email, interval, attemptId, ip) {
      let checkout: models.Checkout;
      try {
        checkout = await polar.checkouts.create({
          products: [productId(interval)],
          external_customer_id: userId,
          customer_email: email,
          metadata: { synara_checkout_attempt_id: attemptId },
          ...(ip ? { customer_ip_address: ip } : {}),
          success_url: config.checkoutSuccessUrl,
          return_url: config.portalReturnUrl,
          allow_discount_codes: interval === "month",
        });
      } catch (error) {
        if (error instanceof errors.HTTPValidationError && error.statusCode === 422)
          throw new BillingCheckoutNotCreatedError();
        throw error;
      }
      return checkoutResult(checkout, userId, attemptId, productId(interval));
    },
    async portal(userId) {
      const session = await polar.customerSessions.create({
        external_customer_id: userId,
        return_url: config.portalReturnUrl,
      });
      return safeUrl(session.customer_portal_url, config.environment);
    },
    async cancelRenewals(userId, knownProductIds) {
      const customer = await customerState(userId);
      if (!customer) return;
      for (const subscription of await subscriptions(userId, knownProductIds)) {
        if (currentStates.has(subscription.status) && !subscription.cancel_at_period_end)
          await polar.subscriptions.update(subscription.id, { cancel_at_period_end: true });
      }
    },
    async verify(body, headers) {
      let event;
      try {
        event = await webhooks.validateEvent(body, headers, config.webhookSecret);
      } catch (error) {
        if (error instanceof webhooks.PolarWebhookUnknownTypeError) return null;
        throw error;
      }
      if (event.type !== "customer.state_changed") return null;
      if (event.data.organization_id !== config.organizationId) return null;
      const userId =
        typeof event.data.external_id === "string" &&
        event.data.external_id.length > 0 &&
        event.data.external_id.length <= 200
          ? event.data.external_id
          : undefined;
      const customerId =
        typeof event.data.id === "string" && event.data.id.length <= 200
          ? event.data.id
          : undefined;
      const eventId = headers["webhook-id"];
      if (!eventId || eventId.length > 200) throw new Error("Invalid Polar webhook scope");
      // Unmapped Polar customers are legitimate. A known provider ID can resolve
      // the immutable local mapping when customer deletion clears external_id.
      if (!userId && !customerId) return null;
      return { eventId, ...(userId ? { userId } : {}), ...(customerId ? { customerId } : {}) };
    },
  };
}
