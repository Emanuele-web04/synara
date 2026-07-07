import { Schema } from "effect";

import { t } from "../i18n";

import type { CheckpointServiceError } from "../checkpointing/Errors.ts";

/**
 * ProviderAdapterValidationError - Invalid adapter API input.
 */
export class ProviderAdapterValidationError extends Schema.TaggedErrorClass<ProviderAdapterValidationError>()(
  "ProviderAdapterValidationError",
  {
    provider: Schema.String,
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return t("errors.providerAdapter.validationFailed", {
      provider: this.provider,
      operation: this.operation,
      issue: this.issue,
    });
  }
}

/**
 * ProviderAdapterSessionNotFoundError - Adapter-owned session id is unknown.
 */
export class ProviderAdapterSessionNotFoundError extends Schema.TaggedErrorClass<ProviderAdapterSessionNotFoundError>()(
  "ProviderAdapterSessionNotFoundError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return t("errors.providerAdapter.unknownThread", {
      provider: this.provider,
      threadId: this.threadId,
    });
  }
}

/**
 * ProviderAdapterSessionClosedError - Adapter session exists but is closed.
 */
export class ProviderAdapterSessionClosedError extends Schema.TaggedErrorClass<ProviderAdapterSessionClosedError>()(
  "ProviderAdapterSessionClosedError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return t("errors.providerAdapter.threadClosed", {
      provider: this.provider,
      threadId: this.threadId,
    });
  }
}

/**
 * ProviderAdapterRequestError - Provider protocol request failed or timed out.
 */
export class ProviderAdapterRequestError extends Schema.TaggedErrorClass<ProviderAdapterRequestError>()(
  "ProviderAdapterRequestError",
  {
    provider: Schema.String,
    method: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return t("errors.providerAdapter.requestFailed", {
      provider: this.provider,
      method: this.method,
      detail: this.detail,
    });
  }
}

/**
 * ProviderAdapterProcessError - Provider process lifecycle failure.
 */
export class ProviderAdapterProcessError extends Schema.TaggedErrorClass<ProviderAdapterProcessError>()(
  "ProviderAdapterProcessError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return t("errors.providerAdapter.processError", {
      provider: this.provider,
      threadId: this.threadId,
      detail: this.detail,
    });
  }
}

/**
 * ProviderValidationError - Invalid provider API input.
 */
export class ProviderValidationError extends Schema.TaggedErrorClass<ProviderValidationError>()(
  "ProviderValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return t("errors.provider.validationFailed", {
      operation: this.operation,
      issue: this.issue,
    });
  }
}

/**
 * ProviderUnsupportedError - Requested provider is not implemented.
 */
export class ProviderUnsupportedError extends Schema.TaggedErrorClass<ProviderUnsupportedError>()(
  "ProviderUnsupportedError",
  {
    provider: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return t("errors.provider.notImplemented", {
      provider: this.provider,
    });
  }
}

/**
 * ProviderSessionNotFoundError - Provider-facing session not found.
 */
export class ProviderSessionNotFoundError extends Schema.TaggedErrorClass<ProviderSessionNotFoundError>()(
  "ProviderSessionNotFoundError",
  {
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return t("errors.provider.unknownThread", {
      threadId: this.threadId,
    });
  }
}

/**
 * ProviderSessionDirectoryPersistenceError - Session directory persistence failure.
 */
export class ProviderSessionDirectoryPersistenceError extends Schema.TaggedErrorClass<ProviderSessionDirectoryPersistenceError>()(
  "ProviderSessionDirectoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return t("errors.provider.sessionDirectoryPersistenceError", {
      operation: this.operation,
      detail: this.detail,
    });
  }
}

export type ProviderAdapterError =
  | ProviderAdapterValidationError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterSessionClosedError
  | ProviderAdapterRequestError
  | ProviderAdapterProcessError;

export type ProviderServiceError =
  | ProviderValidationError
  | ProviderUnsupportedError
  | ProviderSessionNotFoundError
  | ProviderSessionDirectoryPersistenceError
  | ProviderAdapterError
  | CheckpointServiceError;
