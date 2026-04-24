import { Schema } from "effect";

/**
 * GitCommandError - Git command execution failed.
 */
export class GitCommandError extends Schema.TaggedErrorClass<GitCommandError>()("GitCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `Git command failed in ${this.operation}: ${this.command} (${this.cwd}) - ${this.detail}`;
  }
}

/**
 * GitCheckoutDirtyWorktreeError - Checkout would overwrite local files.
 */
export class GitCheckoutDirtyWorktreeError extends Schema.TaggedErrorClass<GitCheckoutDirtyWorktreeError>()(
  "GitCheckoutDirtyWorktreeError",
  {
    branch: Schema.String,
    cwd: Schema.String,
    conflictingFiles: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const fileList = this.conflictingFiles.map((file) => `  - ${file}`).join("\n");
    return `Uncommitted changes block checkout to ${this.branch}:\n${fileList}`;
  }
}

/**
 * GitHubCliError - GitHub CLI execution or authentication failed.
 */
export class GitHubCliError extends Schema.TaggedErrorClass<GitHubCliError>()("GitHubCliError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `GitHub CLI failed in ${this.operation}: ${this.detail}`;
  }
}

/**
 * TextGenerationError - Commit or PR text generation failed.
 */
export class TextGenerationError extends Schema.TaggedErrorClass<TextGenerationError>()(
  "TextGenerationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Text generation failed in ${this.operation}: ${this.detail}`;
  }
}

/**
 * GitManagerError - Stacked Git workflow orchestration failed.
 */
export class GitManagerError extends Schema.TaggedErrorClass<GitManagerError>()("GitManagerError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `Git manager failed in ${this.operation}: ${this.detail}`;
  }
}

/**
 * GitManagerServiceError - Errors emitted by stacked Git workflow orchestration.
 */
export type GitManagerServiceError =
  | GitManagerError
  | GitCommandError
  | GitCheckoutDirtyWorktreeError
  | GitHubCliError
  | TextGenerationError;
