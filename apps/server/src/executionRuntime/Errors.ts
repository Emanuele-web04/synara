import { Schema } from "effect";

/**
 * RuntimeProviderUnsupportedError - No descriptor registered for a provider.
 */
export class RuntimeProviderUnsupportedError extends Schema.TaggedErrorClass<RuntimeProviderUnsupportedError>()(
  "RuntimeProviderUnsupportedError",
  {
    provider: Schema.String,
  },
) {
  override get message(): string {
    return `No execution-runtime provider registered: ${this.provider}`;
  }
}

/**
 * RuntimePlanRejectedError - A `RuntimePlan` failed validation against the
 * resolved provider descriptor before any provisioning. Carries every reason so
 * callers can surface all violations at once.
 */
export class RuntimePlanRejectedError extends Schema.TaggedErrorClass<RuntimePlanRejectedError>()(
  "RuntimePlanRejectedError",
  {
    provider: Schema.String,
    targetKind: Schema.String,
    reasons: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Execution-runtime plan rejected (${this.provider}/${this.targetKind}): ${this.reasons.join("; ")}`;
  }
}
