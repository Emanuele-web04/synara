/**
 * GitHubCli - Effect service contract for `gh` process interactions.
 *
 * Provides thin command execution helpers used by Git workflow orchestration.
 *
 * @module GitHubCli
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type {
  GitHubInboxState,
  GitHubInboxSort,
  GitHubIssueState,
  GitHubIssueStateReason,
  GitPullRequestCheck,
  GitPullRequestComment,
  PullRequestActor,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestLabel,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestStack,
  PullRequestStackSummary,
  PullRequestState,
  WorkItemSearchResult,
} from "@synara/contracts";

import type { ProcessRunResult } from "../../processRunner";
import type { GitHubCliError } from "../Errors.ts";

/**
 * Field list for `gh pr view/list --json` calls that decode into
 * {@link GitHubPullRequestSummary} — one source so call sites and tests cannot drift.
 *
 * Note: `mergeable` is computed lazily by GitHub (it answers UNKNOWN while recomputing),
 * so list calls may pay a small extra API cost for it. The remote-status cache bounds
 * that cost; if status polling ever feels slow, this field is the first suspect.
 */
export const PULL_REQUEST_SUMMARY_JSON_FIELDS =
  "number,title,url,baseRefName,headRefName,state,mergedAt,isDraft,mergeable,additions,deletions,changedFiles,isCrossRepository,headRepository,headRepositoryOwner,updatedAt";

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly isDraft?: boolean;
  readonly mergeability?: "mergeable" | "conflicting" | "unknown";
  readonly additions?: number | null;
  readonly deletions?: number | null;
  readonly changedFiles?: number | null;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
  /** ISO timestamp of the last PR update; used to rank multiple PRs for one branch. */
  readonly updatedAt?: string | null;
}

export interface GitHubRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export interface GitHubPullRequestReviewCommentsResult {
  readonly comments: ReadonlyArray<GitPullRequestComment>;
  readonly truncated: boolean;
}

export interface GitHubPullRequestListItem {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewDecision: string | null;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly mergeability: "mergeable" | "conflicting" | "unknown";
  readonly stack: PullRequestStackSummary | null;
}

/** A pull request row as the inbox query returns it: the list item plus fields GraphQL includes
 * at no extra cost. */
export interface GitHubInboxPullRequest extends GitHubPullRequestListItem {
  readonly commentCount: number;
  readonly assignees: ReadonlyArray<PullRequestActor>;
}

export interface GitHubInboxIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly state: GitHubIssueState;
  readonly stateReason: GitHubIssueStateReason | null;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly assignees: ReadonlyArray<PullRequestActor>;
  readonly commentCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export type GitHubInboxRemoteItem =
  | { readonly kind: "pullRequest"; readonly item: GitHubInboxPullRequest }
  | { readonly kind: "issue"; readonly item: GitHubInboxIssue };

/** GitHub's GraphQL budget as reported by the `rateLimit` field of the same request. */
export interface GitHubGraphQlRateLimit {
  readonly cost: number;
  readonly remaining: number;
  readonly resetAt: string;
}

/**
 * Everything the inbox needs from one repository and state: `listRepositoryInbox` and
 * `listRepositoryInboxInvolvement` merged by the snapshot store. Items that involve the viewer
 * but fall outside the 50 most recently updated come from the involvement search, so
 * `pullRequests`/`issues` may hold more than 50 rows.
 */
export interface GitHubRepositoryInboxSnapshot {
  readonly viewer: string;
  readonly pullRequests: ReadonlyArray<GitHubInboxPullRequest>;
  readonly issues: ReadonlyArray<GitHubInboxIssue>;
  /** More pull requests or issues match the state than the repository lists returned. */
  readonly truncatedPullRequests: boolean;
  readonly truncatedIssues: boolean;
  /** GitHub's own counts for the state, which can exceed the rows returned. */
  readonly totalPullRequests: number;
  readonly totalIssues: number;
  /** Numbers matched by `involves:@me` (author, assignee, mention, or commenter). */
  readonly involvedNumbers: ReadonlyArray<number>;
  /** Open pull requests where GitHub's search matches `review-requested:@me`, teams included.
   * Capped at the search page size; `reviewRequestedCount` is the uncapped total. */
  readonly reviewRequestedNumbers: ReadonlyArray<number>;
  readonly reviewRequestedCount: number;
  readonly rateLimit: GitHubGraphQlRateLimit | null;
}

/** The lists document alone, before the involvement search is merged in. */
export type GitHubRepositoryInboxLists = Omit<GitHubRepositoryInboxSnapshot, "involvedNumbers">;

/** The `involves:@me` search for one repository and state, with full row fields. */
export interface GitHubRepositoryInboxInvolvement {
  readonly items: ReadonlyArray<GitHubInboxRemoteItem>;
  /** Every matched number, including any whose node could not be decoded into `items`. */
  readonly involvedNumbers: ReadonlyArray<number>;
  readonly rateLimit: GitHubGraphQlRateLimit | null;
}

/** Result of the conditional REST request that tells whether a repository's issues or pull
 * requests changed since `etag` was taken. A 304 costs no rate-limit quota. */
export type GitHubRepositoryChangeProbe =
  | { readonly changed: false }
  | { readonly changed: true; readonly etag: string | null };

export type GitHubRepositoryInboxLookup =
  | { readonly _tag: "found"; readonly item: GitHubInboxRemoteItem }
  | { readonly _tag: "not-found" };

export interface GitHubIssueDetailData extends GitHubInboxIssue {
  readonly body: string;
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly commentsTruncated: boolean;
}

export interface GitHubPullRequestDetailData {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeable: string | null;
  readonly mergeability: "mergeable" | "conflicting" | "unknown";
  readonly mergeStateStatus: string | null;
  readonly reviewDecision: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly maintainerCanModify: boolean;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly commits: ReadonlyArray<PullRequestCommit>;
}

/**
 * GitHubCliShape - Service API for executing GitHub CLI commands.
 */
export interface GitHubCliShape {
  /**
   * Run a background read through the server-wide GitHub read queue. Fails fast with a
   * `rate-limited` error while GitHub is limiting the account. User-initiated mutations and the
   * reads they depend on call the methods below directly instead.
   */
  readonly withRead: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | GitHubCliError, R>;

  /**
   * Execute a GitHub CLI command and return full process output.
   */
  readonly execute: (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number;
    readonly maxBufferBytes?: number;
    readonly outputMode?: "error" | "truncate";
    readonly allowNonZeroExit?: boolean;
    /** Piped to the child's stdin — for payloads that must never appear in argv. */
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly onStdoutChunk?: (chunk: string) => void;
    readonly onStderrChunk?: (chunk: string) => void;
  }) => Effect.Effect<ProcessRunResult, GitHubCliError>;

  readonly getViewerLogin: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string, GitHubCliError>;

  /**
   * Read a repository's first 50 pull requests and issues for one state and sort, the
   * review-requested numbers and count, and the GraphQL budget in one `gh api graphql` call.
   * A full inbox read sends it together with `listRepositoryInboxInvolvement`.
   */
  readonly listRepositoryInbox: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly state: GitHubInboxState;
    readonly sort?: GitHubInboxSort;
  }) => Effect.Effect<GitHubRepositoryInboxLists, GitHubCliError>;

  /**
   * Read the items matching `involves:@me` for one repository and state (first 50, full row
   * fields) and the GraphQL budget in one `gh api graphql` call.
   */
  readonly listRepositoryInboxInvolvement: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly state: GitHubInboxState;
    readonly sort?: GitHubInboxSort;
  }) => Effect.Effect<GitHubRepositoryInboxInvolvement, GitHubCliError>;

  /**
   * Conditional REST request for the repository's most recently updated issue or pull request.
   * Pass the ETag of a previous probe; with no ETag it always reports a change and returns one.
   */
  readonly probeRepositoryInboxChanges: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly etag: string | null;
  }) => Effect.Effect<GitHubRepositoryChangeProbe, GitHubCliError>;

  /**
   * Read specific pull requests or issues by number in one GraphQL call. Used to restore pinned
   * items that fall outside the capped inbox lists. Only GitHub's per-number NOT_FOUND answer
   * becomes `not-found`; any other failure fails the whole call.
   */
  readonly getRepositoryInboxItems: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly numbers: ReadonlyArray<number>;
  }) => Effect.Effect<ReadonlyMap<number, GitHubRepositoryInboxLookup>, GitHubCliError>;

  readonly getIssueDetail: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
  }) => Effect.Effect<GitHubIssueDetailData, GitHubCliError>;

  /** Post a comment on an issue as the authenticated gh user. */
  readonly commentOnIssue: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
    readonly body: string;
  }) => Effect.Effect<void, GitHubCliError>;

  readonly getPullRequestDetail: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
  }) => Effect.Effect<GitHubPullRequestDetailData, GitHubCliError>;

  /** Read the selected PR's full GitHub stack, or null for a standalone pull request. */
  readonly getPullRequestStack: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
  }) => Effect.Effect<PullRequestStack | null, GitHubCliError>;

  readonly getRepositoryMergeCapabilities: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<PullRequestMergeCapabilities, GitHubCliError>;

  readonly getPullRequestDiff: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
  }) => Effect.Effect<{ readonly patch: string; readonly truncated: boolean }, GitHubCliError>;

  readonly runPullRequestAction: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
    readonly action: "merge" | "ready" | "draft" | "close" | "reopen";
    readonly mergeMethod?: PullRequestMergeMethod;
  }) => Effect.Effect<{ readonly mergeOutcome: "merged" | "enqueued" | null }, GitHubCliError>;

  /**
   * Post an issue comment on a pull request as the authenticated gh user.
   */
  readonly commentOnPullRequest: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
    readonly body: string;
  }) => Effect.Effect<void, GitHubCliError>;

  /**
   * List open pull requests for a head branch.
   */
  readonly listOpenPullRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

  /**
   * List pull requests for a head branch in any state (open, closed, merged).
   * Used to resolve the branch's most relevant PR when no open PR exists.
   */
  readonly listPullRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

  /**
   * Resolve a pull request by URL, number, or branch-ish identifier.
   */
  readonly getPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
    /** Gate cache misses for polling; mutation-required lookups remain ungated. */
    readonly background?: boolean;
  }) => Effect.Effect<GitHubPullRequestSummary, GitHubCliError>;

  /**
   * Resolve a pull request together with its CI checks (check runs + commit statuses)
   * in a single `gh pr view` call, so snapshot polling pays one process/API round trip.
   */
  readonly getPullRequestWithChecks: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<
    {
      readonly summary: GitHubPullRequestSummary;
      readonly checks: ReadonlyArray<GitPullRequestCheck>;
      /** Commit the checks ran against; null when `gh` did not report it. */
      readonly headSha: string | null;
    },
    GitHubCliError
  >;

  /**
   * List the root comments of unresolved review threads for a pull request.
   * Owner/repo are passed explicitly (parsed from the PR URL) so fork checkouts whose
   * remotes point at a different repository still query the repo that owns the PR.
   */
  readonly getPullRequestReviewComments: (input: {
    readonly cwd: string;
    readonly host: string;
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  }) => Effect.Effect<GitHubPullRequestReviewCommentsResult, GitHubCliError>;

  /**
   * Search open issues and pull requests for a repository. Empty query lists the most
   * recently updated open items. Returns availability metadata for unauthenticated gh.
   */
  readonly searchWorkItems: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly query?: string;
    readonly limit?: number;
  }) => Effect.Effect<WorkItemSearchResult, GitHubCliError>;

  /**
   * Resolve clone URLs for a GitHub repository.
   */
  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

  /**
   * Create a pull request from branch context and body file.
   */
  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly title: string;
    readonly bodyFile: string;
    readonly draft?: boolean;
  }) => Effect.Effect<void, GitHubCliError>;

  /**
   * Resolve repository default branch through GitHub metadata.
   */
  readonly getDefaultBranch: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string | null, GitHubCliError>;

  /**
   * Checkout a pull request into the current repository worktree.
   */
  readonly checkoutPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, GitHubCliError>;
}

/**
 * GitHubCli - Service tag for GitHub CLI process execution.
 */
export class GitHubCli extends ServiceMap.Service<GitHubCli, GitHubCliShape>()(
  "synara/git/Services/GitHubCli",
) {}
