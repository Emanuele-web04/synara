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
 * RuntimeInstanceUnknownError - An operation referenced an instance id the
 * provider has no record of (never provisioned, or already destroyed).
 */
export class RuntimeInstanceUnknownError extends Schema.TaggedErrorClass<RuntimeInstanceUnknownError>()(
  "RuntimeInstanceUnknownError",
  {
    instanceId: Schema.String,
  },
) {
  override get message(): string {
    return `No execution-runtime instance: ${this.instanceId}`;
  }
}

/**
 * RuntimeGitFailedError - A git operation routed through a runtime's exec
 * channel failed. Detail is redacted of credential material before it reaches a
 * log or a caller (no tokenized remote URLs, no leaked secrets).
 */
export class RuntimeGitFailedError extends Schema.TaggedErrorClass<RuntimeGitFailedError>()(
  "RuntimeGitFailedError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Runtime git ${this.operation} failed: ${this.detail}`;
  }
}

/**
 * RuntimeRemoteOperationFailedError - A remote provider's lifecycle, exec, file,
 * port, snapshot, or timeout operation failed. Provider-neutral at the
 * `ExecutionRuntimeService` seam: a concrete adapter (Vercel, Daytona, ...) maps
 * its own SDK/HTTP failure into this tagged error. The detail is redacted of
 * credential material before it is constructed.
 */
export class RuntimeRemoteOperationFailedError extends Schema.TaggedErrorClass<RuntimeRemoteOperationFailedError>()(
  "RuntimeRemoteOperationFailedError",
  {
    provider: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Runtime ${this.provider} ${this.operation} failed: ${this.detail}`;
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
