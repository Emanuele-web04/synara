import { Schema } from "effect";

import type { GitCommandError, GitHubCliError, TextGenerationError } from "../git/Errors.ts";

export class ReviewError extends Schema.TaggedErrorClass<ReviewError>()("ReviewError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `Review failed in ${this.operation}: ${this.detail}`;
  }
}

export type ReviewServiceError =
  | ReviewError
  | GitHubCliError
  | GitCommandError
  | TextGenerationError;
