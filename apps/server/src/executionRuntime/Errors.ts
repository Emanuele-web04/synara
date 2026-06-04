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

/**
 * RuntimeProvisionFailedError - Provisioning, exec, or recording a runtime
 * instance failed. Provider-agnostic at the orchestration seam: the reactor sees
 * only this tagged error, never a concrete provider's failure type.
 */
export class RuntimeProvisionFailedError extends Schema.TaggedErrorClass<RuntimeProvisionFailedError>()(
  "RuntimeProvisionFailedError",
  {
    threadId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Execution-runtime provisioning failed for thread ${this.threadId}: ${this.detail}`;
  }
}
