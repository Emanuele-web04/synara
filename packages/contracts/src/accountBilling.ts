import { Schema } from "effect";

/** Sandbox billing is separate from account ownership and device authorization. */
export const AccountBillingInterval = Schema.Literals(["month", "year"]);
export type AccountBillingInterval = typeof AccountBillingInterval.Type;
export const AccountBillingCheckoutRequest = Schema.Struct({
  interval: AccountBillingInterval,
});
export type AccountBillingCheckoutRequest = typeof AccountBillingCheckoutRequest.Type;
export const AccountBillingPlan = Schema.Struct({
  interval: AccountBillingInterval,
  /** Integer in the currency's smallest unit; never a formatted display price. */
  amountMinor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)),
});
export const AccountBillingStatus = Schema.Struct({
  provider: Schema.Literal("polar"),
  environment: Schema.Literal("sandbox"),
  available: Schema.Boolean,
  access: Schema.Literals(["none", "granted"]),
  subscriptionStatus: Schema.NullOr(Schema.String),
  validUntil: Schema.NullOr(Schema.String),
  cancelAtPeriodEnd: Schema.Boolean,
  checkedAt: Schema.NullOr(Schema.String),
  canCheckout: Schema.Boolean,
  canManage: Schema.Boolean,
  plans: Schema.Array(AccountBillingPlan),
});
export type AccountBillingStatus = typeof AccountBillingStatus.Type;
export const AccountBillingRedirect = Schema.Struct({
  url: Schema.String,
  environment: Schema.Literal("sandbox"),
});
export type AccountBillingRedirect = typeof AccountBillingRedirect.Type;
