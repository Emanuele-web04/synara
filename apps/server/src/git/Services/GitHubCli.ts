import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type {
  GitPullRequestCheck,
  GitPullRequestComment,
  PullRequestActor,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestInvolvement,
  PullRequestLabel,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestStack,
  PullRequestStackSummary,
  PullRequestState,
} from "@synara/contracts";

import type { ProcessRunResult } from "../../processRunner";
import type { GitHubCliError } from "../Errors.ts";

/** `mergeable` is lazily computed by GitHub (UNKNOWN while recomputing) so list calls pay extra API cost — the remote-status cache bounds it */
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
  /** used to rank multiple PRs for one branch */
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

/** retains raw array cardinality before malformed entries are dropped */
export interface GitHubPullRequestListBatch {
  readonly entries: ReadonlyArray<GitHubPullRequestListItem>;
  readonly rawCount: number;
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

export interface GitHubCliShape {
  readonly execute: (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number;
    readonly maxBufferBytes?: number;
    readonly outputMode?: "error" | "truncate";
    readonly allowNonZeroExit?: boolean;
    /** stdin pipe for payloads that must never appear in argv */
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly onStdoutChunk?: (chunk: string) => void;
    readonly onStderrChunk?: (chunk: string) => void;
  }) => Effect.Effect<ProcessRunResult, GitHubCliError>;

  readonly getViewerLogin: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string, GitHubCliError>;

  readonly listRepositoryPullRequests: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly state: PullRequestState;
    readonly involvement: PullRequestInvolvement;
    readonly viewer: string;
    readonly limit?: number;
  }) => Effect.Effect<GitHubPullRequestListBatch, GitHubCliError>;

  /** restore pinned PRs that fall outside the capped list results */
  readonly getPullRequestListItem: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
  }) => Effect.Effect<GitHubPullRequestListItem, GitHubCliError>;

  /** authoritative search includes team requests the viewer belongs to; used sparingly for pinned PRs beyond the cap */
  readonly listReviewRequestedPullRequestNumbers: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly viewer: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<number>, GitHubCliError>;

  readonly getPullRequestDetail: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
  }) => Effect.Effect<GitHubPullRequestDetailData, GitHubCliError>;

  /** null for a standalone pull request */
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

  readonly commentOnPullRequest: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
    readonly body: string;
  }) => Effect.Effect<void, GitHubCliError>;

  readonly listOpenPullRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

  /** resolve the most relevant PR when no open PR exists */
  readonly listPullRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

  readonly getPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<GitHubPullRequestSummary, GitHubCliError>;

  /** checks ride the same `gh pr view` call so polling pays one round trip */
  readonly getPullRequestWithChecks: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<
    {
      readonly summary: GitHubPullRequestSummary;
      readonly checks: ReadonlyArray<GitPullRequestCheck>;
    },
    GitHubCliError
  >;

  /** owner/repo passed explicitly so fork checkouts still query the repo that owns the PR */
  readonly getPullRequestReviewComments: (input: {
    readonly cwd: string;
    readonly host: string;
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  }) => Effect.Effect<GitHubPullRequestReviewCommentsResult, GitHubCliError>;

  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly title: string;
    readonly bodyFile: string;
    readonly draft?: boolean;
  }) => Effect.Effect<void, GitHubCliError>;

  readonly getDefaultBranch: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string | null, GitHubCliError>;

  readonly checkoutPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, GitHubCliError>;
}

export class GitHubCli extends ServiceMap.Service<GitHubCli, GitHubCliShape>()(
  "synara/git/Services/GitHubCli",
) {}
