import { setTimeout as delay } from "node:timers/promises";
import { AccountApiError } from "@synara/shared/account";
import type { HostAuthorizationSnapshot } from "@synara/contracts";

import { findAccountApiError, isRemoteAccessRefusal } from "../accountRefusal";
import { exponentialBackoffMs, jitterMs } from "../backoff";

export const REMOTE_AUTHORIZATION_LEASE_MS = 60_000;
export const REMOTE_REVOCATION_POLL_MS = 10_000;
/**
 * Retiring remote trust revokes every paired device, so one answer never does it:
 * the denial must repeat across polls and outlast a deploy or rollback window.
 */
export const REMOTE_PERMANENT_DENIAL_CONFIRMATIONS = 3;
export const REMOTE_PERMANENT_DENIAL_MS = 5 * 60_000;
/**
 * A refusal that keeps trust (no subscription, no remote enrollment) changes
 * only when the owner acts, so repeated refusals poll less often, up to this.
 * It also bounds how long a just-subscribed owner waits for remote access.
 * Ownership denials keep the normal cadence that their confirmation window counts.
 */
export const REMOTE_REFUSED_POLL_MAX_MS = 60_000;

/**
 * How long one snapshot request on the poll and admission paths may take. The
 * account client's general 15 s bound let one stalled request spend a quarter
 * of the lease, or hold a phone's connect for 15 s; a healthy request answers
 * in well under a second (p95 under 700 ms measured at the account API).
 */
export const REMOTE_AUTHORIZATION_ATTEMPT_TIMEOUT_MS = 5_000;

/**
 * Runs one snapshot request with {@link REMOTE_AUTHORIZATION_ATTEMPT_TIMEOUT_MS}
 * per attempt, retrying once at once when the attempt timed out or failed in
 * transport (a dropped or reset connection). Every answer the account service
 * gave, refusals, denials and 5xx included, is returned unretried, so the lease,
 * denial confirmation and backoff rules see exactly the answers they did before.
 */
export async function requestAuthorizationSnapshot<A>(
  attempt: (signal: AbortSignal) => Promise<A>,
  options: { readonly signal: AbortSignal; readonly attemptTimeoutMs?: number },
): Promise<A> {
  const timeoutMs = options.attemptTimeoutMs ?? REMOTE_AUTHORIZATION_ATTEMPT_TIMEOUT_MS;
  for (let attempts = 1; ; attempts++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await attempt(AbortSignal.any([options.signal, timeout]));
    } catch (error) {
      // The client reports an abort (its own or this attempt's) as a 408; any
      // other typed error is an answer, even one that landed as the bound elapsed.
      const answer = findAccountApiError(error);
      const unanswered = answer
        ? answer.status === 408 && timeout.aborted
        : timeout.aborted || error instanceof TypeError;
      if (attempts >= 2 || options.signal.aborted || !unanswered) throw error;
    }
  }
}

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

/**
 * Without open remote connections the lease is not kept renewed: admission
 * fetches a fresh snapshot instead, and this slower poll keeps tombstones,
 * ownership denials and discoverability from going stale.
 */
export const REMOTE_IDLE_POLL_MS = 5 * 60_000;

/**
 * A fresh lease gates all admission and closes existing streams during an API outage.
 * While remote connections are open the lease is renewed on the revocation cadence;
 * otherwise each admission waits on `ensureFresh` for a snapshot as fresh as that cadence.
 */
export function startRemoteAuthorization(options: {
  refresh: () => Promise<HostAuthorizationSnapshot>;
  apply: (snapshot: HostAuthorizationSnapshot) => Promise<void>;
  unavailable: (permanent: boolean) => Promise<void>;
  signal: AbortSignal;
  now?: () => number;
  pollIntervalMs?: number;
  refusedPollMaxMs?: number;
  /** Remote connections that a revocation must reach are open. Omitted means always. */
  active?: () => boolean;
  idlePollIntervalMs?: number;
  log?: (message: string) => void;
}) {
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? REMOTE_REVOCATION_POLL_MS;
  const refusedPollMaxMs = Math.max(
    pollIntervalMs,
    options.refusedPollMaxMs ?? REMOTE_REFUSED_POLL_MAX_MS,
  );
  const idlePollIntervalMs = Math.max(
    pollIntervalMs,
    options.idlePollIntervalMs ?? REMOTE_IDLE_POLL_MS,
  );
  const active = options.active ?? (() => true);
  // Consecutive refusals; any other answer restores the normal cadence.
  let refusals = 0;
  const log = options.log ?? (() => {});
  let validUntil = 0;
  let monotonicValidUntil = 0;
  let permanentlyDenied = false;
  let expired = true;
  let admitted = false;
  // A pause, failure or denial was logged; the next lease logs the recovery.
  let interrupted = false;
  let lastLeaseWasPaid = false;
  let lastFailure: string | undefined;
  let denial: { reason: string; since: number; count: number } | undefined;
  let checking: Promise<void> | undefined;
  let lastCheckStartedAt = Number.NEGATIVE_INFINITY;
  let lastCheckSettledAt = Number.NEGATIVE_INFINITY;
  let wakeSleep: AbortController | undefined;
  // A local event (this app revoked a device) asked for the next check now.
  let checkRequested = false;
  // Wall-clock adjustments cannot extend an authenticated lease during an outage.
  const available = () =>
    !options.signal.aborted &&
    !permanentlyDenied &&
    now() < validUntil &&
    performance.now() < monotonicValidUntil;
  const expiry = setInterval(() => {
    if (!expired && !available()) {
      expired = true;
      // An idle host lets its lease lapse on purpose; only connected work is paused.
      if (active()) {
        interrupted = true;
        log("Remote authorization lease expired; remote connections are paused.");
      }
      void options.unavailable(false).catch(() => {});
    }
  }, 1_000);
  expiry.unref();
  const failed = (reason: string) => {
    interrupted = true;
    if (reason === lastFailure) return;
    lastFailure = reason;
    log(`Remote authorization check failed (${reason}); retrying.`);
  };
  // Ownership denials close admission at once but retire trust only once confirmed.
  const deny = async (reason: string) => {
    interrupted = true;
    const at = now();
    denial = denial
      ? { ...denial, reason, count: denial.count + 1 }
      : { reason, since: at, count: 1 };
    validUntil = 0;
    monotonicValidUntil = 0;
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
  // One snapshot request at a time, shared by the poll and every admission waiting on it.
  const check = (): Promise<void> => {
    if (checking) return checking;
    checkRequested = false;
    lastCheckStartedAt = performance.now();
    checking = (async () => {
      let refused = false;
      try {
        const snapshot = await options.refresh();
        if (options.signal.aborted) return;
        await options.apply(snapshot);
        if (options.signal.aborted) return;
        if (!snapshot.ownerInOrg) {
          await deny("owner_not_in_org");
        } else {
          if (admitted && interrupted) log("Remote authorization restored.");
          admitted = true;
          interrupted = false;
          lastFailure = undefined;
          denial = undefined;
          validUntil = now() + REMOTE_AUTHORIZATION_LEASE_MS;
          monotonicValidUntil = performance.now() + REMOTE_AUTHORIZATION_LEASE_MS;
          lastLeaseWasPaid = snapshot.remoteBillingEnforced === true;
          expired = false;
        }
      } catch (error) {
        if (options.signal.aborted) return;
        const unverifiedPaidCutover =
          error instanceof AccountApiError &&
          error.status === 503 &&
          error.code === "billing_unavailable" &&
          !lastLeaseWasPaid;
        // Enrollment replies reuse the ownership code. Deny immediately,
        // but keep checking: enabling access must not require new device trust.
        if (isRemoteAccessRefusal(error) || unverifiedPaidCutover) {
          // Only an authenticated, linked host gets this far.
          denial = undefined;
          refused = !unverifiedPaidCutover;
          failed(
            error instanceof AccountApiError && error.code === "subscription_required"
              ? "the host owner's remote subscription is required"
              : unverifiedPaidCutover
                ? "a paid remote authorization has not been confirmed"
                : "remote access is not enabled for this account",
          );
          validUntil = 0;
          monotonicValidUntil = 0;
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
      } finally {
        refusals = refused ? refusals + 1 : 0;
      }
    })().finally(() => {
      checking = undefined;
      lastCheckSettledAt = performance.now();
    });
    return checking;
  };
  const interval = () =>
    checkRequested
      ? 0
      : !active()
        ? idlePollIntervalMs
        : refusals > 0
          ? exponentialBackoffMs(refusals, pollIntervalMs, refusedPollMaxMs)
          : pollIntervalMs;
  // Sleeps one jittered interval after the last check; `wake` re-reads the
  // interval, so a connection opening on an idle host is checked promptly.
  const sleepUntilDue = async () => {
    const spread = jitterMs(1);
    for (;;) {
      const wait = lastCheckSettledAt + interval() * spread - performance.now();
      if (wait <= 0 || options.signal.aborted) return;
      const wake = new AbortController();
      wakeSleep = wake;
      await delay(wait, undefined, {
        signal: AbortSignal.any([options.signal, wake.signal]),
      }).catch(() => {});
      wakeSleep = undefined;
      if (!wake.signal.aborted) return;
    }
  };
  const done = (async () => {
    try {
      while (!options.signal.aborted) {
        await check();
        if (permanentlyDenied || options.signal.aborted) break;
        await sleepUntilDue();
      }
    } finally {
      clearInterval(expiry);
    }
  })();
  void done.catch(() => {
    validUntil = 0;
    monotonicValidUntil = 0;
    void options.unavailable(false).catch(() => {});
  });
  return {
    available,
    paidAvailable: () => lastLeaseWasPaid && available(),
    done,
    /**
     * Admission waits here first. Within one poll interval of the last check it
     * decides on that answer, so on-demand checks never outpace the old poll.
     */
    ensureFresh: async (): Promise<void> => {
      if (options.signal.aborted || permanentlyDenied) return;
      if (checking) await checking.catch(() => {});
      else if (performance.now() - lastCheckStartedAt >= pollIntervalMs)
        await check().catch(() => {});
    },
    /** Re-reads the cadence now, for example when a remote connection opens. */
    wake: () => wakeSleep?.abort(),
    /** Checks as soon as any check in flight settles. */
    checkSoon: () => {
      checkRequested = true;
      wakeSleep?.abort();
    },
  };
}
