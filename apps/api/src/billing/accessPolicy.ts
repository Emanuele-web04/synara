import type { AccountBillingStatus } from "@synara/contracts";

// Commercial checks are separate from host ownership, pairing and local agent access.
export const REMOTE_BILLING_MAX_STATUS_AGE_MS = 60_000;

export type RemoteBillingAccessDecision =
  | { readonly allowed: true; readonly reason: "allowed" }
  | {
      readonly allowed: false;
      readonly reason: "subscription_required" | "billing_unavailable";
    };

export interface RemoteBillingAccessInput {
  readonly enforcementEnabled?: boolean;
  /** Fresh server reconciliation, never an unverified client entitlement. */
  readonly status?:
    | Pick<AccountBillingStatus, "available" | "access" | "checkedAt" | "validUntil">
    | null
    | undefined;
  readonly nowMs?: number;
  /** May shorten the existing remote authorization window, never extend it. */
  readonly maxStatusAgeMs?: number;
}

/** Decide only new remote admission; callers retain all existing identity checks. */
export function decideRemoteBillingAccess(
  input: RemoteBillingAccessInput = {},
): RemoteBillingAccessDecision {
  if (input.enforcementEnabled !== true) return { allowed: true, reason: "allowed" };

  const { status } = input;
  const nowMs = input.nowMs ?? Date.now();
  const maxAgeMs = input.maxStatusAgeMs ?? REMOTE_BILLING_MAX_STATUS_AGE_MS;
  const checkedAtMs = status?.checkedAt ? Date.parse(status.checkedAt) : Number.NaN;
  if (
    status?.available !== true ||
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs <= 0 ||
    maxAgeMs > REMOTE_BILLING_MAX_STATUS_AGE_MS ||
    !Number.isFinite(checkedAtMs) ||
    checkedAtMs > nowMs ||
    nowMs - checkedAtMs >= maxAgeMs
  )
    return { allowed: false, reason: "billing_unavailable" };

  if (status.access !== "granted")
    return {
      allowed: false,
      reason: status.access === "none" ? "subscription_required" : "billing_unavailable",
    };

  // A granted past-due benefit may have no period end; its fresh check still expires.
  if (status.validUntil !== null) {
    const validUntilMs = Date.parse(status.validUntil);
    if (!Number.isFinite(validUntilMs) || validUntilMs <= nowMs)
      return { allowed: false, reason: "billing_unavailable" };
  }
  return { allowed: true, reason: "allowed" };
}

/** The ledger's last known entitlement for one account, read without a provider call. */
export interface StoredBillingAccess {
  readonly accessGranted: boolean;
  readonly validUntil: string | null;
}

/**
 * How long a granted entitlement keeps a profile visible past its stored period
 * end. A renewal's new period arrives by webhook after the old one ends, and the
 * page read never reconciles; without this, every paying subscriber's page would
 * 404 at each renewal until the sweep catches up. Revocation webhooks (refunds,
 * cancellations) clear the grant itself, so they still hide the page sooner.
 */
export const PROFILE_RENEWAL_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether an owner's public profile may be shown to anyone. Profile pages are
 * anonymous and rate-limited per viewer, so they must never drive Polar round
 * trips: this reads only the stored entitlement that Polar webhooks and
 * signed-in reconciles keep current. Missing, revoked, or unreadable
 * entitlement hides the profile, as does one past its period end plus
 * {@link PROFILE_RENEWAL_GRACE_MS}; a granted benefit without a period end stays
 * visible until a webhook or reconcile revokes it.
 */
export function isProfileBillingEntitled(input: {
  readonly enforcementEnabled?: boolean;
  readonly stored?: StoredBillingAccess | null | undefined;
  readonly nowMs?: number;
}): boolean {
  if (input.enforcementEnabled !== true) return true;
  const { stored } = input;
  if (stored?.accessGranted !== true) return false;
  if (stored.validUntil === null) return true;
  const validUntilMs = Date.parse(stored.validUntil);
  return (
    Number.isFinite(validUntilMs) &&
    validUntilMs + PROFILE_RENEWAL_GRACE_MS > (input.nowMs ?? Date.now())
  );
}
