import type {
  GitHubInboxListInput,
  GitHubInboxListResult,
  GitHubIssueCommentInput,
  GitHubIssueCommentResult,
  GitHubIssueDetail,
  GitHubIssueDetailInput,
  OrchestrationProject,
} from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { GitHubRepositoryInventory } from "../../pullRequests/repositoryResolution";

/** Every repository the inbox needs is rate-limited and nothing is cached to show instead. */
export class GitHubInboxRateLimitedError extends Schema.TaggedErrorClass<GitHubInboxRateLimitedError>()(
  "GitHubInboxRateLimitedError",
  {
    retryAt: Schema.String,
  },
) {
  override get message(): string {
    return "GitHub rate limit reached. Code review will refresh after the limit resets.";
  }
}

/**
 * The pieces of the inbox that pull request detail and mutations share, so both paths use one
 * repository inventory cache, one GitHub read queue, and one snapshot store.
 */
export interface GitHubInboxSharedReads {
  readonly resolveProjectRepositories: (
    project: OrchestrationProject,
  ) => Effect.Effect<GitHubRepositoryInventory, unknown>;
  readonly withGitHubRead: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Called after any mutation on the repository so the next list reads it in full. */
  readonly invalidateRepository: (repository: string) => Effect.Effect<void>;
}

export interface GitHubInboxServiceShape extends GitHubInboxSharedReads {
  readonly list: (input: GitHubInboxListInput) => Effect.Effect<GitHubInboxListResult, unknown>;
  readonly issueDetail: (
    input: GitHubIssueDetailInput,
  ) => Effect.Effect<GitHubIssueDetail, unknown>;
  readonly issueComment: (
    input: GitHubIssueCommentInput,
  ) => Effect.Effect<GitHubIssueCommentResult, unknown>;
}

export class GitHubInboxService extends ServiceMap.Service<
  GitHubInboxService,
  GitHubInboxServiceShape
>()("synara/githubInbox/Services/GitHubInboxService") {}
