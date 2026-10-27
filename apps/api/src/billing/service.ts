// Durable sandbox ledger. Payment state never changes device/host ownership or trust.
import type {
  AccountBillingInterval,
  AccountBillingStatus,
  AccountBillingRedirect,
} from "@synara/contracts";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { BillingCheckoutNotCreatedError, type BillingCheckout } from "./polar";
import type { BillingProvider, BillingSnapshot } from "./polar";

export class BillingError extends Error {
  constructor(
    readonly status: 400 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}
export const BILLING_UNAVAILABLE: AccountBillingStatus = {
  provider: "polar",
  environment: "sandbox",
  available: false,
  access: "none",
  subscriptionStatus: null,
  validUntil: null,
  cancelAtPeriodEnd: false,
  checkedAt: null,
  canCheckout: false,
  canManage: false,
  plans: [],
};
type Row = {
  user_id: string;
  customer_id: string | null;
  product_ids: string[];
  access_granted: boolean;
  subscription_status: string | null;
  valid_until: Date | null;
  cancel_at_period_end: boolean;
  has_subscription: boolean;
  checked_at: Date | null;
  checkout_id: string | null;
  checkout_attempt_id: string | null;
  checkout_product_id: string | null;
  checkout_url: string | null;
  checkout_interval: AccountBillingInterval | null;
  checkout_expires_at: Date | null;
  deleted_at: Date | null;
};

function serialize(row: Row, plans: AccountBillingStatus["plans"]): AccountBillingStatus {
  return {
    provider: "polar",
    environment: "sandbox",
    available: true,
    access: row.access_granted ? "granted" : "none",
    subscriptionStatus: row.subscription_status,
    validUntil: row.valid_until?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    checkedAt: row.checked_at?.toISOString() ?? null,
    canCheckout: !row.has_subscription && !row.access_granted,
    canManage: row.customer_id !== null,
    plans,
  };
}

export function createBillingService(options: { pool: pg.Pool; provider: BillingProvider }) {
  const { pool, provider } = options;
  async function withAccount<T>(
    userId: string,
    action: (client: pg.PoolClient, row: Row) => Promise<T>,
  ) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `billing:${userId}`,
      ]);
      await client.query(
        `INSERT INTO billing_accounts(user_id,deleted_at)
        SELECT $1, (SELECT requested_at FROM account_deletions WHERE user_id=$1)
        ON CONFLICT(user_id) DO UPDATE SET deleted_at=coalesce(billing_accounts.deleted_at,excluded.deleted_at)`,
        [userId],
      );
      const { rows } = await client.query<Row>(
        "SELECT * FROM billing_accounts WHERE user_id=$1 FOR UPDATE",
        [userId],
      );
      const result = await action(client, rows[0]!);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function reconcile(client: pg.PoolClient, userId: string): Promise<Row> {
    const existing = await client.query<Row>("SELECT * FROM billing_accounts WHERE user_id=$1", [
      userId,
    ]);
    const state: BillingSnapshot | null = await provider.state(
      userId,
      existing.rows[0]!.product_ids,
    );
    const { rows } = await client.query<Row>(
      `UPDATE billing_accounts SET customer_id=$2,
      access_granted=$3, subscription_status=$4, valid_until=$5, cancel_at_period_end=$6,
      has_subscription=$7, checked_at=now(), product_ids=$8::jsonb,
      checkout_id=CASE WHEN $9 THEN NULL ELSE checkout_id END,
      checkout_attempt_id=CASE WHEN $9 THEN NULL ELSE checkout_attempt_id END,
      checkout_product_id=CASE WHEN $9 THEN NULL ELSE checkout_product_id END,
      checkout_interval=CASE WHEN $9 THEN NULL ELSE checkout_interval END,
      checkout_url=CASE WHEN $9 THEN NULL ELSE checkout_url END,
      checkout_expires_at=CASE WHEN $9 THEN NULL ELSE checkout_expires_at END
      WHERE user_id=$1 AND deleted_at IS NULL RETURNING *`,
      [
        userId,
        state?.customerId ?? null,
        state?.accessGranted ?? false,
        state?.subscriptionStatus ?? null,
        state?.validUntil ?? null,
        state?.cancelAtPeriodEnd ?? false,
        state?.hasSubscription ?? false,
        JSON.stringify([
          ...new Set([...existing.rows[0]!.product_ids, ...(state?.productIds ?? [])]),
        ]),
        state?.settledCheckoutAttempts.some(
          (attempt) =>
            attempt.attemptId === existing.rows[0]!.checkout_attempt_id &&
            attempt.productId === existing.rows[0]!.checkout_product_id,
        ) ?? false,
      ],
    );
    if (!rows[0]) throw new BillingError(409, "This account is being deleted");
    return rows[0];
  }
  function assertAvailable(row: Row) {
    if (row.deleted_at) throw new BillingError(409, "This account is being deleted");
  }
  return {
    async status(userId: string): Promise<AccountBillingStatus> {
      const plans = await provider.plans();
      return withAccount(userId, async (client, row) => {
        assertAvailable(row);
        return serialize(await reconcile(client, userId), plans);
      });
    },
    async checkout(
      userId: string,
      email: string,
      interval: AccountBillingInterval,
      ip?: string,
    ): Promise<AccountBillingRedirect> {
      await provider.plans();
      const prepared = await withAccount(userId, async (client, row) => {
        assertAvailable(row);
        const current = await reconcile(client, userId);
        if (current.has_subscription || current.access_granted)
          throw new BillingError(409, "Manage your existing sandbox subscription instead");
        if (current.checkout_attempt_id) {
          if (!current.checkout_interval || !current.checkout_product_id)
            throw new BillingError(
              409,
              "A sandbox checkout for another plan is still being verified",
            );
          const found = await provider.recoverCheckout(
            userId,
            current.checkout_attempt_id,
            current.checkout_product_id,
            current.checkout_id ?? undefined,
          );
          if (!found)
            throw new BillingError(
              409,
              "Your earlier sandbox checkout is still being verified. Try again later; do not start another purchase",
            );
          if (found.status === "succeeded")
            throw new BillingError(
              409,
              "Your sandbox payment is being synchronized. Refresh the subscription status",
            );
          if (found.status === "open" || found.status === "confirmed") {
            if (current.checkout_interval !== interval)
              throw new BillingError(
                409,
                "A sandbox checkout for another plan is still being verified",
              );
            if (found.status === "open" && new Date(found.expiresAt) <= new Date())
              throw new BillingError(409, "Your earlier sandbox checkout is still being verified");
            await client.query(
              "UPDATE billing_accounts SET checkout_id=$2,checkout_url=$3,checkout_expires_at=$4 WHERE user_id=$1 AND checkout_attempt_id=$5",
              [userId, found.checkoutId, found.url, found.expiresAt, current.checkout_attempt_id],
            );
            return { kind: "existing" as const, url: found.url };
          }
          // Only a fresh, known terminal vendor state authorizes a new POST.
          if (found.status !== "failed" && found.status !== "expired")
            throw new BillingError(409, "Your earlier sandbox checkout is still being verified");
        } else if (current.checkout_url) {
          throw new BillingError(
            409,
            "An earlier sandbox checkout requires verification before another purchase",
          );
        }
        // Failed read-only preparation must not leave an uncertain POST fence.
        await provider.preflightCheckout(userId, current.product_ids);
        const attemptId = randomUUID();
        const productId = provider.productId(interval);
        await client.query(
          "UPDATE billing_accounts SET checkout_id=NULL,checkout_attempt_id=$2,checkout_product_id=$3,checkout_interval=$4,checkout_url=NULL,checkout_expires_at=NULL,product_ids=$5::jsonb WHERE user_id=$1",
          [
            userId,
            attemptId,
            productId,
            interval,
            JSON.stringify([...new Set([...current.product_ids, productId])]),
          ],
        );
        return { kind: "new" as const, attemptId };
      });
      if (prepared.kind === "existing") return { url: prepared.url, environment: "sandbox" };
      // The fence above is already committed. Timeout or a failed local write
      // cannot roll it back and authorize a duplicate vendor POST on retry.
      let checkout: BillingCheckout;
      try {
        checkout = await provider.checkout(userId, email, interval, prepared.attemptId, ip);
      } catch (error) {
        if (!(error instanceof BillingCheckoutNotCreatedError)) throw error;
        // A definitive schema refusal cannot have created a session. Clear only
        // this request's intent; a concurrently recovered/newer one remains fenced.
        await withAccount(userId, async (client) => {
          await client.query(
            "UPDATE billing_accounts SET checkout_id=NULL,checkout_attempt_id=NULL,checkout_product_id=NULL,checkout_interval=NULL,checkout_url=NULL,checkout_expires_at=NULL WHERE user_id=$1 AND checkout_attempt_id=$2",
            [userId, prepared.attemptId],
          );
        });
        throw new BillingError(
          400,
          "The sandbox checkout could not validate your account details. Check your account information before trying again",
        );
      }
      return withAccount(userId, async (client, row) => {
        assertAvailable(row);
        if (row.checkout_attempt_id !== prepared.attemptId)
          throw new BillingError(409, "Sandbox billing changed. Refresh the subscription status");
        await client.query(
          "UPDATE billing_accounts SET checkout_url=$2,checkout_expires_at=$3,checkout_id=$5 WHERE user_id=$1 AND checkout_attempt_id=$4",
          [userId, checkout.url, checkout.expiresAt, prepared.attemptId, checkout.checkoutId],
        );
        return { url: checkout.url, environment: "sandbox" };
      });
    },
    async portal(userId: string): Promise<AccountBillingRedirect> {
      return withAccount(userId, async (client, row) => {
        assertAvailable(row);
        const current = await reconcile(client, userId);
        if (!current.customer_id)
          throw new BillingError(409, "No sandbox billing customer exists for this account");
        return { url: await provider.portal(userId), environment: "sandbox" };
      });
    },
    async webhook(body: string, headers: Record<string, string>) {
      let event: Awaited<ReturnType<BillingProvider["verify"]>>;
      try {
        event = await provider.verify(body, headers);
      } catch {
        throw new BillingError(400, "Invalid Polar webhook");
      }
      if (!event) return;
      let userId = event.userId;
      if (!userId && event.customerId) {
        const mapped = await pool.query<{ user_id: string }>(
          "SELECT user_id FROM billing_accounts WHERE customer_id=$1",
          [event.customerId],
        );
        userId = mapped.rows[0]?.user_id;
      }
      if (!userId) return;
      // Acknowledgement follows durable insertion. Outages remain retryable at Polar.
      await pool.query(
        "INSERT INTO billing_webhook_events(event_id,user_id) VALUES($1,$2) ON CONFLICT(event_id) DO NOTHING",
        [event.eventId, userId],
      );
    },
    async flush() {
      const { rows } = await pool.query<{ user_id: string }>(
        "SELECT DISTINCT user_id FROM billing_webhook_events WHERE handled_at IS NULL AND next_attempt_at <= now() LIMIT 10",
      );
      for (const { user_id: userId } of rows) {
        try {
          await withAccount(userId, async (client, row) => {
            const pending = await client.query<{ event_id: string }>(
              "SELECT event_id FROM billing_webhook_events WHERE user_id=$1 AND handled_at IS NULL AND next_attempt_at <= now() LIMIT 100 FOR UPDATE",
              [userId],
            );
            if (pending.rows.length === 0) return;
            if (row.deleted_at) await provider.cancelRenewals(userId, row.product_ids);
            else await reconcile(client, userId);
            await client.query(
              "UPDATE billing_webhook_events SET handled_at=now() WHERE event_id=ANY($1::text[])",
              [pending.rows.map((event) => event.event_id)],
            );
          });
        } catch {
          await pool.query(
            "UPDATE billing_webhook_events SET next_attempt_at=now()+interval '1 minute' WHERE user_id=$1 AND handled_at IS NULL",
            [userId],
          );
          console.warn("[api] Sandbox billing reconciliation remains queued");
        }
      }
      await pool.query(
        "DELETE FROM billing_webhook_events WHERE handled_at < now()-interval '30 days'",
      );
    },
    async cleanupDeletedAccount(userId: string) {
      await withAccount(userId, async (client, row) => {
        if (!row.deleted_at) throw new BillingError(409, "Account erasure was not requested");
        await provider.cancelRenewals(userId, row.product_ids);
        await client.query(
          "UPDATE billing_accounts SET customer_id=NULL, access_granted=false, subscription_status=NULL, valid_until=NULL, cancel_at_period_end=false, has_subscription=false, checked_at=NULL,checkout_id=NULL,checkout_url=NULL,checkout_interval=NULL,checkout_expires_at=NULL,checkout_attempt_id=NULL,checkout_product_id=NULL WHERE user_id=$1",
          [userId],
        );
      });
    },
  };
}
export type BillingService = ReturnType<typeof createBillingService>;
