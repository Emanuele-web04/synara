/**
 * GitHubCli - Effect service contract for `gh` process interactions.
 *
 * Provides thin command execution helpers used by Git workflow orchestration.
 *
 * @module GitHubCli
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProcessRunResult } from "../../processRunner";
import type { GitHubCliError } from "../Errors.ts";

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

export interface GitHubRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export type GitHubChecksStatus = "passing" | "failing" | "pending" | "none";

export interface GitHubReviewPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRepositoryOwnerLogin?: string;
  readonly author: string;
  readonly authorAvatarUrl?: string;
  readonly updatedAt: string;
  readonly state: "open" | "closed" | "merged";
  readonly reviewDecision: string | null;
  readonly isDraft: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly checksStatus: GitHubChecksStatus;
  readonly reviewRequests: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<string>;
}

export type GitHubReviewerState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING"
  | "REVIEW_REQUIRED";

export interface GitHubReviewer {
  readonly login: string;
  readonly avatarUrl?: string;
  readonly state: GitHubReviewerState;
}

export interface GitHubReviewLabel {
  readonly name: string;
  readonly color: string;
}

export interface GitHubReviewUserRef {
  readonly login: string;
  readonly avatarUrl?: string;
}

export interface GitHubReviewCommit {
  readonly oid: string;
  readonly abbreviatedOid: string;
  readonly messageHeadline: string;
  readonly messageBody?: string;
  readonly author: string;
  readonly authoredDate: string;
}

export type GitHubReviewCheckState =
  | "success"
  | "failure"
  | "pending"
  | "skipped"
  | "neutral"
  | "cancelled";

export interface GitHubReviewCheck {
  readonly name: string;
  readonly state: GitHubReviewCheckState;
  readonly workflow?: string;
  readonly description?: string;
  readonly url?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface GitHubReviewPullRequestDetail {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean;
  readonly author: string;
  readonly authorAvatarUrl?: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly commitsCount: number;
  readonly reviewDecision: string | null;
  readonly mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  readonly mergeStateStatus?: string;
  readonly checksStatus: GitHubChecksStatus;
  readonly milestone: string | null;
  readonly labels: ReadonlyArray<GitHubReviewLabel>;
  readonly assignees: ReadonlyArray<GitHubReviewUserRef>;
  readonly reviewers: ReadonlyArray<GitHubReviewer>;
}

export interface GitHubReviewPullRequestOverview {
  readonly detail: GitHubReviewPullRequestDetail;
  readonly commits: ReadonlyArray<GitHubReviewCommit>;
  readonly checks: ReadonlyArray<GitHubReviewCheck>;
}

export type GitHubReviewTimelineEvent =
  | {
      readonly kind: "comment";
      readonly id: string;
      readonly author: string;
      readonly authorAvatarUrl?: string;
      readonly body: string;
      readonly createdAt: string;
      readonly url?: string;
    }
  | {
      readonly kind: "review";
      readonly id: string;
      readonly author: string;
      readonly authorAvatarUrl?: string;
      readonly state: GitHubReviewerState;
      readonly body: string;
      readonly createdAt: string;
      readonly url?: string;
    }
  | {
      readonly kind: "commit";
      readonly oid: string;
      readonly abbreviatedOid: string;
      readonly messageHeadline: string;
      readonly author: string;
      readonly createdAt: string;
    };

export type GitHubReviewEvent = "approve" | "request_changes" | "comment";

export interface GitHubReviewInlineComment {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly body: string;
}

export interface GitHubCreateReviewResult {
  readonly url?: string;
  readonly reviewId?: number;
}

export interface GitHubAuthenticatedUser {
  readonly login: string;
  readonly avatarUrl?: string;
}

export interface GitHubReviewThreadComment {
  readonly author: string;
  readonly authorAvatarUrl?: string;
  readonly body: string;
  readonly createdAt: string;
  readonly url?: string;
}

export interface GitHubReviewThread {
  readonly id: string;
  readonly path?: string;
  readonly line?: number;
  readonly side?: "LEFT" | "RIGHT";
  readonly isResolved: boolean;
  readonly comments: ReadonlyArray<GitHubReviewThreadComment>;
}

export interface GitHubProjectSummary {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly url?: string;
  readonly ownerLogin: string;
}

export interface GitHubProjectStatusOption {
  readonly id: string;
  readonly name: string;
}

export interface GitHubProjectStatusField {
  readonly id: string;
  readonly name: string;
  readonly options: ReadonlyArray<GitHubProjectStatusOption>;
}

export interface GitHubProjectItem {
  readonly itemId: string;
  readonly statusName: string | null;
  readonly contentType: string;
  readonly number: number | null;
  readonly title: string;
  readonly url?: string;
  readonly author: string;
  readonly repositoryNameWithOwner?: string;
}

export interface GitHubProjectBoardData {
  readonly project: GitHubProjectSummary;
  readonly statusField: GitHubProjectStatusField | null;
  readonly items: ReadonlyArray<GitHubProjectItem>;
}

/**
 * GitHubCliShape - Service API for executing GitHub CLI commands.
 */
export interface GitHubCliShape {
  /**
   * Execute a GitHub CLI command and return full process output.
   */
  readonly execute: (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number;
    readonly stdin?: string;
  }) => Effect.Effect<ProcessRunResult, GitHubCliError>;

  /**
   * List open pull requests for a head branch.
   */
  readonly listOpenPullRequests: (input: {
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
  }) => Effect.Effect<GitHubPullRequestSummary, GitHubCliError>;

  /**
   * List repository pull requests filtered by state for the review surface.
   */
  readonly listRepositoryPullRequests: (input: {
    readonly cwd: string;
    readonly state: "open" | "closed" | "merged" | "all";
    readonly limit?: number;
    readonly search?: string;
    readonly author?: string;
    readonly reviewRequested?: string;
    readonly baseBranch?: string;
    readonly headBranch?: string;
    readonly label?: string;
  }) => Effect.Effect<ReadonlyArray<GitHubReviewPullRequest>, GitHubCliError>;

  /**
   * Load the full PR overview — detail, commits, and per-check status — from a
   * single `gh pr view` call for the review surface.
   */
  readonly getReviewPullRequestOverview: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<GitHubReviewPullRequestOverview, GitHubCliError>;

  /**
   * Load the PR conversation timeline (comments, reviews, commits) ordered
   * chronologically, from a single `gh pr view` call.
   */
  readonly getReviewConversation: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<ReadonlyArray<GitHubReviewTimelineEvent>, GitHubCliError>;

  /**
   * Resolve the authenticated GitHub user.
   */
  readonly getAuthenticatedUser: (input: {
    readonly cwd: string;
  }) => Effect.Effect<GitHubAuthenticatedUser, GitHubCliError>;

  /**
   * Read the unified diff for a pull request.
   */
  readonly getPullRequestDiff: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<string, GitHubCliError>;

  /**
   * Read the current head commit SHA for a pull request.
   */
  readonly getPullRequestHeadSha: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<string, GitHubCliError>;

  /**
   * Submit a verdict-only review (no inline comments).
   */
  readonly submitPullRequestReview: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly event: GitHubReviewEvent;
    readonly body?: string;
  }) => Effect.Effect<void, GitHubCliError>;

  /**
   * Create a review with inline comments through the REST reviews endpoint.
   */
  readonly createPullRequestReviewWithComments: (input: {
    readonly cwd: string;
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
    readonly event: GitHubReviewEvent;
    readonly commitId: string;
    readonly body?: string;
    readonly comments: ReadonlyArray<GitHubReviewInlineComment>;
  }) => Effect.Effect<GitHubCreateReviewResult, GitHubCliError>;

  /**
   * Read review threads (path/line/side/resolution/comments) for a pull request.
   */
  readonly getPullRequestThreads: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<ReadonlyArray<GitHubReviewThread>, GitHubCliError>;

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

  /**
   * Probe whether the gh token carries the `read:project` scope by running a
   * cheap `gh project list`; returns false on a missing-scope error.
   */
  readonly projectScopeAvailable: (input: {
    readonly cwd: string;
  }) => Effect.Effect<boolean, GitHubCliError>;

  /**
   * List Projects v2 boards for an owner (login or org); defaults to `@me`.
   */
  readonly listProjects: (input: {
    readonly cwd: string;
    readonly owner?: string;
  }) => Effect.Effect<ReadonlyArray<GitHubProjectSummary>, GitHubCliError>;

  /**
   * Load a Projects v2 board: summary, the single-select Status field, and items.
   */
  readonly getProjectBoard: (input: {
    readonly cwd: string;
    readonly owner: string;
    readonly number: number;
  }) => Effect.Effect<GitHubProjectBoardData, GitHubCliError>;

  /**
   * Set the single-select Status option for a project item (move the card).
   */
  readonly moveProjectCard: (input: {
    readonly cwd: string;
    readonly projectId: string;
    readonly itemId: string;
    readonly fieldId: string;
    readonly optionId: string;
  }) => Effect.Effect<void, GitHubCliError>;

  /**
   * Resolve the repository owner login for the current worktree.
   */
  readonly getRepositoryOwner: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string, GitHubCliError>;
}

/**
 * GitHubCli - Service tag for GitHub CLI process execution.
 */
export class GitHubCli extends ServiceMap.Service<GitHubCli, GitHubCliShape>()(
  "t3/git/Services/GitHubCli",
) {}
