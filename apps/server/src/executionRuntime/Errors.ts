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
 * MissingCredentialsError - A non-`fake` remote provider was asked to provision
 * but has no usable credentials configured (none in Settings, the secret store,
 * or the environment). Raised at the create boundary before any provider call, so
 * a misconfigured provider fails fast and clearly rather than silently falling
 * back to the fake client or erroring deep inside an adapter. Carries the thread
 * and provider so the surface can point the user at the right Settings panel.
 */
export class MissingCredentialsError extends Schema.TaggedErrorClass<MissingCredentialsError>()(
  "MissingCredentialsError",
  {
    threadId: Schema.String,
    provider: Schema.String,
  },
) {
  override get message(): string {
    return `No credentials configured for runtime provider ${this.provider} (thread ${this.threadId})`;
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

/**
 * CloudflareBridgeError - A call to the Cloudflare Runtime Bridge failed
 * (transport error, non-2xx response, or a malformed body). `operation` names
 * the bridge route so the adapter can surface a provider-agnostic
 * `RuntimeProvisionFailedError` without leaking HTTP specifics upward. `detail`
 * is already redacted of any bearer token before construction.
 */
export class CloudflareBridgeError extends Schema.TaggedErrorClass<CloudflareBridgeError>()(
  "CloudflareBridgeError",
  {
    operation: Schema.String,
    status: Schema.NullOr(Schema.Int),
    detail: Schema.String,
  },
) {
  override get message(): string {
    const code = this.status === null ? "transport" : `status ${this.status}`;
    return `Cloudflare bridge ${this.operation} failed (${code}): ${this.detail}`;
  }
}
