// Durable billing ledger. Payment state never changes device/host ownership or trust.
import type {
  AccountBillingEnvironment,
  AccountBillingInterval,
  AccountBillingStatus,
  AccountBillingRedirect,
} from "@synara/contracts";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import {
  BillingCatalogUnavailableError,
  BillingCheckoutNotCreatedError,
  type BillingCheckout,
} from "./polar";
import type { BillingProvider, BillingSnapshot } from "./polar";
import type { StoredBillingAccess } from "./accessPolicy";

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

/**
 * How long a reconciled authorization is reused without asking the provider.
 * Deliberately below REMOTE_BILLING_MAX_STATUS_AGE_MS in accessPolicy.ts,
 * which refuses older statuses outright: a longer reuse here would turn into
 * `billing_unavailable` there, not into fewer provider calls.
 */
const ACCESS_REUSE_MS = 30_000;

type AccessRow = Pick<Row, "access_granted" | "checked_at" | "valid_until">;
type BillingAccess = Pick<
  AccountBillingStatus,
  "available" | "access" | "checkedAt" | "validUntil"
>;

/**
 * Whether a stored authorization may be served without reconciling: checked
 * within the reuse window by the API clock (a future timestamp is not
 * trusted), and its lease not yet over. Pending webhooks and the erasure
 * fence are checked separately by each caller.
 */
function isAccessReusable(row: AccessRow, now: number): boolean {
  const age = row.checked_at ? now - row.checked_at.getTime() : Infinity;
  return (
    age >= 0 && age <= ACCESS_REUSE_MS && (!row.valid_until || row.valid_until.getTime() > now)
  );
}

/** Ledger columns are null when `present` is false: the row does not exist yet. */
type Probe = AccessRow &
  Pick<Row, "deleted_at" | "product_ids" | "checkout_attempt_id" | "checkout_product_id"> & {
    present: boolean;
    pending_webhook: boolean;
    deleting: boolean;
  };

/** The single-statement answer: reusable, no pending webhook, no erasure. */
function isProbeReusable(probe: Probe, now: number): boolean {
  return (
    probe.present &&
    !probe.deleted_at &&
    !probe.deleting &&
    !probe.pending_webhook &&
    isAccessReusable(probe, now)
  );
}

/**
 * Whether the locked row still holds what a provider snapshot was requested
 * for: the same last check, product scope and open checkout attempt. A row
 * missing at probe time must still hold the defaults its upsert created.
 */
function isUnchangedSince(row: Row, before: Probe): boolean {
  return (
    (row.checked_at?.getTime() ?? null) === (before.checked_at?.getTime() ?? null) &&
    JSON.stringify(row.product_ids) === JSON.stringify(before.product_ids ?? []) &&
    row.checkout_attempt_id === before.checkout_attempt_id &&
    row.checkout_product_id === before.checkout_product_id
  );
}

function serializeAccess(row: AccessRow): BillingAccess {
  return {
    available: true,
    access: row.access_granted ? "granted" : "none",
    checkedAt: row.checked_at?.toISOString() ?? null,
    validUntil: row.valid_until?.toISOString() ?? null,
  };
}

function serialize(
  row: Row,
  plans: AccountBillingStatus["plans"],
  environment: AccountBillingEnvironment,
): AccountBillingStatus {
  return {
    provider: "polar",
    environment,
    available: true,
    access: row.access_granted ? "granted" : "none",
    subscriptionStatus: row.subscription_status,
    validUntil: row.valid_until?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    checkedAt: row.checked_at?.toISOString() ?? null,
    canCheckout: plans.length > 0 && !row.has_subscription && !row.access_granted,
    canManage: row.customer_id !== null,
    plans,
  };
}

export function createBillingService(options: { pool: pg.Pool; provider: BillingProvider }) {
  const { pool, provider } = options;
  let initialization: Promise<void> | undefined;
  function initialize(): Promise<void> {
    if (!initialization) {
      initialization = (async () => {
        // Pre-existing commercial rows were created before production was supported.
        // The singleton claim is atomic even when two environments start together.
        await pool.query(
          `INSERT INTO billing_environment(id,environment)
          SELECT 1,CASE WHEN EXISTS(SELECT 1 FROM billing_accounts)
            OR EXISTS(SELECT 1 FROM billing_webhook_events) THEN 'sandbox' ELSE $1 END
          ON CONFLICT(id) DO NOTHING`,
          [provider.environment],
        );
        const { rows } = await pool.query<{ environment: AccountBillingEnvironment }>(
          "SELECT environment FROM billing_environment WHERE id=1",
        );
        if (rows[0]?.environment !== provider.environment)
          throw new BillingError(503, "Billing is unavailable for this configuration");
      })().catch((error) => {
        initialization = undefined;
        throw error;
      });
    }
    return initialization;
  }
  async function withAccount<T, K extends keyof Row = keyof Row>(
    userId: string,
    action: (client: pg.PoolClient, row: Pick<Row, K>) => Promise<T>,
    columns?: readonly K[],
  ) {
    await initialize();
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
      const { rows } = await client.query<Pick<Row, K>>(
        `SELECT ${columns?.join(",") ?? "*"} FROM billing_accounts WHERE user_id=$1 FOR UPDATE`,
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
    // The lease evaluator and its successful check use the same API clock.
    return applySnapshot(client, userId, existing.rows[0]!, state, new Date());
  }
  async function applySnapshot(
    client: pg.PoolClient,
    userId: string,
    existing: Pick<Row, "product_ids" | "checkout_attempt_id" | "checkout_product_id">,
    state: BillingSnapshot | null,
    checkedAt: Date,
  ): Promise<Row> {
    const { rows } = await client.query<Row>(
      `UPDATE billing_accounts SET customer_id=$2,
      access_granted=$3, subscription_status=$4, valid_until=$5, cancel_at_period_end=$6,
      has_subscription=$7, checked_at=$10, product_ids=$8::jsonb,
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
        JSON.stringify([...new Set([...existing.product_ids, ...(state?.productIds ?? [])])]),
        state?.settledCheckoutAttempts.some(
          (attempt) =>
            attempt.attemptId === existing.checkout_attempt_id &&
            attempt.productId === existing.checkout_product_id,
        ) ?? false,
        checkedAt,
      ],
    );
    if (!rows[0]) throw new BillingError(409, "This account is being deleted");
    return rows[0];
  }
  /**
   * The ledger fields a refresh depends on, read without a transaction or
   * lock. Always one row, so the erasure fence is seen before the ledger row
   * exists.
   */
  async function probe(userId: string): Promise<Probe> {
    const { rows } = await pool.query<Probe>(
      `SELECT b.user_id IS NOT NULL AS present,
        b.access_granted, b.checked_at, b.valid_until, b.deleted_at,
        b.product_ids, b.checkout_attempt_id, b.checkout_product_id,
        EXISTS(SELECT 1 FROM billing_webhook_events WHERE user_id=$1 AND handled_at IS NULL) AS pending_webhook,
        EXISTS(SELECT 1 FROM account_deletions WHERE user_id=$1) AS deleting
      FROM (SELECT $1::text AS user_id) AS u LEFT JOIN billing_accounts AS b ON b.user_id=u.user_id`,
      [userId],
    );
    return rows[0]!;
  }
  /**
   * Reconciles without holding a pooled connection, transaction or lock while
   * the provider answers: read the ledger, ask the provider, then lock and
   * write only if nothing the snapshot depends on changed meanwhile. A ledger
   * that did change (a concurrent checkout, webhook flush or erasure) is
   * re-decided under the lock exactly as before, provider call included.
   * `allowReuse` is the authorization path's 30 s reuse; the full status
   * read always reconciles.
   */
  async function refresh(userId: string, before: Probe, allowReuse: boolean): Promise<Row> {
    const decideLocked = async (client: pg.PoolClient, row: Row) => {
      assertAvailable(row);
      if (allowReuse && isAccessReusable(row, Date.now())) {
        const pending = await client.query(
          "SELECT 1 FROM billing_webhook_events WHERE user_id=$1 AND handled_at IS NULL LIMIT 1",
          [userId],
        );
        if (pending.rows.length === 0) return row;
      }
      // A failed refresh cannot extend an old authorization lease.
      return reconcile(client, userId);
    };
    // Erasure answers from the lock without asking the provider, as before.
    if (before.deleted_at || before.deleting) return withAccount(userId, decideLocked);
    const state = await provider.state(userId, before.product_ids ?? []);
    // The lease evaluator and its successful check use the same API clock.
    const checkedAt = new Date();
    return withAccount(userId, async (client, row) => {
      assertAvailable(row);
      return isUnchangedSince(row, before)
        ? applySnapshot(client, userId, row, state, checkedAt)
        : decideLocked(client, row);
    });
  }
  /**
   * Per-user, in-process queue for refreshes. Concurrent requests for one
   * user used to queue on the advisory lock while each held a pooled
   * connection; they now queue here and take a connection only for their own
   * statements. The advisory lock still orders writers across processes.
   */
  const refreshQueue = new Map<string, Promise<void>>();
  async function oneAtATime<T>(userId: string, run: (waited: boolean) => Promise<T>): Promise<T> {
    const previous = refreshQueue.get(userId);
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    refreshQueue.set(userId, turn);
    try {
      if (previous) await previous;
      return await run(previous !== undefined);
    } finally {
      release();
      if (refreshQueue.get(userId) === turn) refreshQueue.delete(userId);
    }
  }
  function assertAvailable(row: Pick<Row, "deleted_at">) {
    if (row.deleted_at) throw new BillingError(409, "This account is being deleted");
  }
  return {
    initialize,
    async status(userId: string): Promise<AccountBillingStatus> {
      await initialize();
      const plans = await provider.plans().catch((error: unknown) => {
        if (error instanceof BillingCatalogUnavailableError) return [];
        throw error;
      });
      return oneAtATime(userId, async () =>
        serialize(await refresh(userId, await probe(userId), false), plans, provider.environment),
      );
    },
    async access(userId: string): Promise<BillingAccess> {
      // Authorization needs no customer, product or checkout payload. The
      // common case — a recent, unexpired grant with no pending webhook on a
      // live account — is answered by one read-only statement: no transaction,
      // lock or write. The erasure fence is read from account_deletions too,
      // because the locked path's upsert is what copies it into deleted_at.
      await initialize();
      const stored = await probe(userId);
      if (isProbeReusable(stored, Date.now())) return serializeAccess(stored);
      // Anything else re-decides under the same locks, tombstone check and
      // webhook freshness as the full ledger read.
      return oneAtATime(userId, async (waited) => {
        // A caller that queued behind another refresh sees its result first,
        // as it did when it waited on the row lock.
        const current = waited ? await probe(userId) : stored;
        if (waited && isProbeReusable(current, Date.now())) return serializeAccess(current);
        return serializeAccess(await refresh(userId, current, true));
      });
    },
    /**
     * The stored entitlement as last reconciled, with no provider call and no
     * row lock — for anonymous reads such as public profile pages. `null`
     * when the account has no ledger row or is being deleted.
     */
    async storedAccess(userId: string): Promise<StoredBillingAccess | null> {
      await initialize();
      const { rows } = await pool.query<Pick<Row, "access_granted" | "valid_until" | "deleted_at">>(
        "SELECT access_granted, valid_until, deleted_at FROM billing_accounts WHERE user_id=$1",
        [userId],
      );
      const row = rows[0];
      if (!row || row.deleted_at) return null;
      return {
        accessGranted: row.access_granted,
        validUntil: row.valid_until?.toISOString() ?? null,
      };
    },
    async checkout(
      userId: string,
      email: string,
      interval: AccountBillingInterval,
      ip?: string,
    ): Promise<AccountBillingRedirect> {
      await initialize();
      await provider.plans();
      const prepared = await withAccount(userId, async (client, row) => {
        assertAvailable(row);
        const current = await reconcile(client, userId);
        if (current.has_subscription || current.access_granted)
          throw new BillingError(409, "Manage your existing subscription instead");
        if (current.checkout_attempt_id) {
          if (!current.checkout_interval || !current.checkout_product_id)
            throw new BillingError(409, "A checkout for another plan is still being verified");
          const found = await provider.recoverCheckout(
            userId,
            current.checkout_attempt_id,
            current.checkout_product_id,
            current.checkout_id ?? undefined,
          );
          if (!found)
            throw new BillingError(
              409,
              "Your earlier checkout is still being verified. Try again later; do not start another purchase",
            );
          if (found.status === "succeeded")
            throw new BillingError(
              409,
              "Your payment is being synchronized. Refresh the subscription status",
            );
          if (found.status === "open" || found.status === "confirmed") {
            if (current.checkout_interval !== interval)
              throw new BillingError(409, "A checkout for another plan is still being verified");
            if (found.status === "open" && new Date(found.expiresAt) <= new Date())
              throw new BillingError(409, "Your earlier checkout is still being verified");
            await client.query(
              "UPDATE billing_accounts SET checkout_id=$2,checkout_url=$3,checkout_expires_at=$4 WHERE user_id=$1 AND checkout_attempt_id=$5",
              [userId, found.checkoutId, found.url, found.expiresAt, current.checkout_attempt_id],
            );
            return { kind: "existing" as const, url: found.url };
          }
          // Only a fresh, known terminal vendor state authorizes a new POST.
          if (found.status !== "failed" && found.status !== "expired")
            throw new BillingError(409, "Your earlier checkout is still being verified");
        } else if (current.checkout_url) {
          throw new BillingError(
            409,
            "An earlier checkout requires verification before another purchase",
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
      if (prepared.kind === "existing")
        return { url: prepared.url, environment: provider.environment };
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
          "The checkout could not validate your account details. Check your account information before trying again",
        );
      }
      return withAccount(userId, async (client, row) => {
        assertAvailable(row);
        if (row.checkout_attempt_id !== prepared.attemptId)
          throw new BillingError(409, "Billing changed. Refresh the subscription status");
        await client.query(
          "UPDATE billing_accounts SET checkout_url=$2,checkout_expires_at=$3,checkout_id=$5 WHERE user_id=$1 AND checkout_attempt_id=$4",
          [userId, checkout.url, checkout.expiresAt, prepared.attemptId, checkout.checkoutId],
        );
        return { url: checkout.url, environment: provider.environment };
      });
    },
    async portal(userId: string): Promise<AccountBillingRedirect> {
      return withAccount(userId, async (client, row) => {
        assertAvailable(row);
        const current = await reconcile(client, userId);
        if (!current.customer_id)
          throw new BillingError(409, "No billing customer exists for this account");
        return { url: await provider.portal(userId), environment: provider.environment };
      });
    },
    async webhook(body: string, headers: Record<string, string>) {
      await initialize();
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
      await initialize();
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
          console.warn("[api] Billing reconciliation remains queued");
        }
      }
      await pool.query(
        "DELETE FROM billing_webhook_events WHERE handled_at < now()-interval '30 days'",
      );
    },
    async cleanupDeletedAccount(userId: string) {
      await withAccount(userId, async (client, row) => {
        if (!row.deleted_at) throw new BillingError(409, "Account erasure was not requested");
        if (row.checkout_attempt_id) {
          if (!row.checkout_product_id)
            throw new BillingError(
              409,
              "An earlier checkout is awaiting verification before erasure",
            );
          const checkout = await provider.recoverCheckout(
            userId,
            row.checkout_attempt_id,
            row.checkout_product_id,
            row.checkout_id ?? undefined,
          );
          if (checkout?.status !== "failed" && checkout?.status !== "expired") {
            const state = await provider.state(userId, row.product_ids);
            if (
              !state?.settledCheckoutAttempts.some(
                (attempt) =>
                  attempt.attemptId === row.checkout_attempt_id &&
                  attempt.productId === row.checkout_product_id,
              )
            )
              throw new BillingError(
                409,
                "An earlier checkout is awaiting verification before erasure",
              );
          }
        } else if (row.checkout_url) {
          throw new BillingError(
            409,
            "An earlier checkout is awaiting verification before erasure",
          );
        }
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
