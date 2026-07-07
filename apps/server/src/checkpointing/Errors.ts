import { Schema } from "effect";

import { t } from "../i18n";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { GitCommandError } from "../git/Errors.ts";

/**
 * CheckpointUnavailableError - Expected checkpoint does not exist.
 */
export class CheckpointUnavailableError extends Schema.TaggedErrorClass<CheckpointUnavailableError>()(
  "CheckpointUnavailableError",
  {
    threadId: Schema.String,
    turnCount: Schema.Number,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return t("errors.checkpoint.unavailable", {
      threadId: this.threadId,
      turnCount: this.turnCount,
      detail: this.detail,
    });
  }
}

/**
 * CheckpointInvariantError - Inconsistent provider/filesystem/catalog state.
 */
export class CheckpointInvariantError extends Schema.TaggedErrorClass<CheckpointInvariantError>()(
  "CheckpointInvariantError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return t("errors.checkpoint.invariantViolation", {
      operation: this.operation,
      detail: this.detail,
    });
  }
}

export type CheckpointStoreError =
  | GitCommandError
  | CheckpointInvariantError
  | CheckpointUnavailableError;

export type CheckpointServiceError = CheckpointStoreError | ProjectionRepositoryError;
