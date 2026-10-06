import { Schema } from "effect";
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
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.turnCount}: ${this.detail}`;
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
    return `Checkpoint invariant violation in ${this.operation}: ${this.detail}`;
  }
}

/**
 * CheckpointCaptureBudgetExceededError - Advisory capture exceeded its resource policy.
 *
 * Intentionally excludes workspace paths and subprocess output so a skipped
 * pre-turn checkpoint can be logged without exposing filenames.
 */
export class CheckpointCaptureBudgetExceededError extends Schema.TaggedErrorClass<CheckpointCaptureBudgetExceededError>()(
  "CheckpointCaptureBudgetExceededError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["timeout", "unseeded-scan", "cooldown"]),
    timeoutMs: Schema.Number,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Checkpoint capture skipped (${this.reason}): ${this.detail}`;
  }
}

export type CheckpointStoreError =
  | GitCommandError
  | CheckpointCaptureBudgetExceededError
  | CheckpointInvariantError
  | CheckpointUnavailableError;

export type CheckpointServiceError = CheckpointStoreError | ProjectionRepositoryError;
