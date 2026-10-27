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
