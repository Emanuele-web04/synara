// Provider adapters classify terminal refusals; orchestration owns recovery timing.
import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString, TurnId } from "./baseSchemas";
import { ProviderInstanceId } from "./providerInstance";

export const ProviderUsageLimit = Schema.Struct({
  resetAt: Schema.NullOr(IsoDateTime),
});
export type ProviderUsageLimit = typeof ProviderUsageLimit.Type;

export const UsageLimitRecovery = Schema.Struct({
  id: TrimmedNonEmptyString,
  turnId: TurnId,
  resetAt: IsoDateTime,
  autoResume: Schema.Literal(true),
  state: Schema.optional(Schema.Literals(["waiting", "resuming"])),
  resumedTurnId: Schema.optional(TurnId),
  provider: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  // Opaque, non-secret fingerprint of the account and launch configuration.
  bindingKey: TrimmedNonEmptyString,
  policyEpoch: NonNegativeInt,
  goalStartedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  goalPausedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type UsageLimitRecovery = typeof UsageLimitRecovery.Type;

export const UsageLimitRecoverySource = Schema.Struct({
  turnId: TurnId,
  bindingKey: TrimmedNonEmptyString,
  policyEpoch: NonNegativeInt,
});
export type UsageLimitRecoverySource = typeof UsageLimitRecoverySource.Type;

export const UsageLimitRecoveryFields = {
  usageLimitRecoverySource: Schema.optional(Schema.NullOr(UsageLimitRecoverySource)),
  usageLimitRecovery: Schema.optional(Schema.NullOr(UsageLimitRecovery)),
  // A Stop before terminal failure must prevent that same turn arming later.
  usageLimitRecoveryCancelledTurnId: Schema.optional(Schema.NullOr(TurnId)),
  usageLimitRecoveryCancelledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  usageLimitRecoveryLastResetAt: Schema.optional(Schema.NullOr(IsoDateTime)),
};
