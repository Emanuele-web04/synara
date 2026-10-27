import { setTimeout as delay } from "node:timers/promises";
import { AccountApiError } from "@synara/shared/account";
import type { HostAuthorizationSnapshot } from "@synara/contracts";

export const REMOTE_AUTHORIZATION_LEASE_MS = 60_000;
export const REMOTE_REVOCATION_POLL_MS = 10_000;
/**
 * Retiring remote trust revokes every paired device, so one answer never does it:
 * the denial must repeat across polls and outlast a deploy or rollback window.
 */
export const REMOTE_PERMANENT_DENIAL_CONFIRMATIONS = 3;
export const REMOTE_PERMANENT_DENIAL_MS = 5 * 60_000;

/** Answers that mean the host no longer belongs to its owner: unlinked, deleted or handed over. */
const OWNERSHIP_DENIAL_CODES: ReadonlySet<string> = new Set([
  "host_not_linked",
  "host_not_found",
  "not_host_owner",
]);

function describeFailure(error: unknown): string {
  if (error instanceof AccountApiError) return `${error.status} ${error.code}`;
  return error instanceof Error ? error.name : "unknown error";
}

/** A fresh lease gates all admission and closes existing streams during an API outage. */
export function startRemoteAuthorization(options: {
  refresh: () => Promise<HostAuthorizationSnapshot>;
  apply: (snapshot: HostAuthorizationSnapshot) => Promise<void>;
  unavailable: (permanent: boolean) => Promise<void>;
  signal: AbortSignal;
  now?: () => number;
  pollIntervalMs?: number;
  log?: (message: string) => void;
}) {
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? REMOTE_REVOCATION_POLL_MS;
  const log = options.log ?? (() => {});
  let validUntil = 0;
  let permanentlyDenied = false;
  let expired = true;
  let admitted = false;
  let lastLeaseWasPaid = false;
  let lastFailure: string | undefined;
  let denial: { reason: string; since: number; count: number } | undefined;
  const available = () => !options.signal.aborted && !permanentlyDenied && now() < validUntil;
  const expiry = setInterval(() => {
    if (!expired && !available()) {
      expired = true;
      log("Remote authorization lease expired; remote connections are paused.");
      void options.unavailable(false).catch(() => {});
    }
  }, 1_000);
  expiry.unref();
  const failed = (reason: string) => {
    if (reason === lastFailure) return;
    lastFailure = reason;
    log(`Remote authorization check failed (${reason}); retrying.`);
  };
  // Ownership denials close admission at once but retire trust only once confirmed.
  const deny = async (reason: string) => {
    const at = now();
    denial = denial
      ? { ...denial, reason, count: denial.count + 1 }
      : { reason, since: at, count: 1 };
    validUntil = 0;
    expired = true;
    if (
      denial.count < REMOTE_PERMANENT_DENIAL_CONFIRMATIONS ||
      at - denial.since < REMOTE_PERMANENT_DENIAL_MS
    ) {
      if (denial.count === 1)
        log(`Account service denied this host (${reason}); remote connections are paused.`);
      await options.unavailable(false);
      return;
    }
    permanentlyDenied = true;
    log(
      `Account service kept denying this host (${reason}); remote access is off and paired devices must pair again.`,
    );
    await options.unavailable(true);
  };
  const done = (async () => {
    try {
      while (!options.signal.aborted) {
        try {
          const snapshot = await options.refresh();
          if (options.signal.aborted) break;
          await options.apply(snapshot);
          if (options.signal.aborted) break;
          if (!snapshot.ownerInOrg) {
            await deny("owner_not_in_org");
          } else {
            if (admitted && (expired || lastFailure)) log("Remote authorization restored.");
            admitted = true;
            lastFailure = undefined;
            denial = undefined;
            validUntil = now() + REMOTE_AUTHORIZATION_LEASE_MS;
            lastLeaseWasPaid = snapshot.remoteBillingEnforced === true;
            expired = false;
          }
        } catch (error) {
          if (options.signal.aborted) break;
          // Enrollment replies reuse the ownership code. Deny immediately,
          // but keep checking: enabling access must not require new device trust.
          const enrollmentUnavailable =
            error instanceof AccountApiError &&
            error.status === 403 &&
            error.code === "not_host_owner" &&
            error.message === "Remote test access is not enabled for this account";
          const subscriptionRequired =
            error instanceof AccountApiError &&
            error.status === 403 &&
            error.code === "subscription_required";
          const unverifiedPaidCutover =
            error instanceof AccountApiError &&
            error.status === 503 &&
            error.code === "billing_unavailable" &&
            !lastLeaseWasPaid;
          if (enrollmentUnavailable || subscriptionRequired || unverifiedPaidCutover) {
            // Only an authenticated, linked host gets this far.
            denial = undefined;
            failed(
              subscriptionRequired
                ? "the host owner's remote subscription is required"
                : unverifiedPaidCutover
                  ? "a paid remote authorization has not been confirmed"
                  : "remote access is not enabled for this account",
            );
            validUntil = 0;
            expired = true;
            await options.unavailable(false);
          } else if (
            error instanceof AccountApiError &&
            [401, 403, 404].includes(error.status) &&
            OWNERSHIP_DENIAL_CODES.has(error.code)
          ) {
            await deny(error.code);
          } else {
            // A stale or rejected proof, an outage or a proxy page only lets the lease lapse.
            failed(describeFailure(error));
          }
        }
        if (permanentlyDenied) break;
        await delay(pollIntervalMs * (0.9 + Math.random() * 0.2), undefined, {
          signal: options.signal,
        }).catch(() => {});
      }
    } finally {
      clearInterval(expiry);
    }
  })();
  void done.catch(() => {
    validUntil = 0;
    void options.unavailable(false).catch(() => {});
  });
  return { available, paidAvailable: () => lastLeaseWasPaid && available(), done };
}
