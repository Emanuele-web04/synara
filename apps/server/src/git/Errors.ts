import { Schema } from "effect";

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

export class GitHubCliError extends Schema.TaggedErrorClass<GitHubCliError>()("GitHubCliError", {
  operation: Schema.String,
  detail: Schema.String,
  reason: Schema.optional(Schema.Literals(["not-installed", "not-authenticated", "other"])),
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `GitHub CLI failed in ${this.operation}: ${this.detail}`;
  }
}

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

export class GitManagerError extends Schema.TaggedErrorClass<GitManagerError>()("GitManagerError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `Git manager failed in ${this.operation}: ${this.detail}`;
  }
}

export type GitManagerServiceError =
  | GitManagerError
  | GitCommandError
  | GitCheckoutDirtyWorktreeError
  | GitHubCliError
  | TextGenerationError;
