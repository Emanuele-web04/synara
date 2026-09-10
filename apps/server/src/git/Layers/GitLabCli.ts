/**
 * GitLabCliLive - `glab`-backed implementation of the host-neutral CLI contract.
 *
 * Every JSON payload comes from `glab api` (REST or GraphQL) with an explicit `--hostname`, so a
 * self-hosted instance is addressed the same way as gitlab.com. Mutations whose outcome matters
 * (merge) use REST; exit-code-only mutations use the `glab mr` porcelain.
 *
 * @module GitLabCliLive
 */
import { Effect, Layer, Schema } from "effect";
import {
  PositiveInt,
  TrimmedNonEmptyString,
  type GitPullRequestCheck,
  type GitPullRequestCheckStatus,
  type GitPullRequestComment,
  type PullRequestActor,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestCommit,
  type PullRequestLabel,
  type PullRequestMergeCapabilities,
} from "@synara/contracts";
import {
  gitlabAbsoluteUrl,
  gitlabMergeRequestUrl,
  parseGitLabMergeRequestUrl,
  parseGitLabRepositoryReference,
} from "@synara/shared/gitlabRepository";

import { runProcess } from "../../processRunner";
import { GitHostCliError } from "../Errors.ts";
import type {
  GitHostCliShape,
  GitHostPullRequestDetailData,
  GitHostPullRequestListBatch,
  GitHostPullRequestListItem,
  GitHostPullRequestSummary,
  GitHostRepositoryCloneUrls,
} from "../Services/GitHostCli.ts";
import { GitLabCli, type GitLabCliShape } from "../Services/GitLabCli.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const PULL_REQUEST_DIFF_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_LIST_LIMIT = 51;
const OPEN_PR_LOOKUP_LIMIT = 10;
const PIPELINE_JOB_PAGE_SIZE = 100;
const DETAIL_CONNECTION_LIMIT = 100;
const DISCUSSION_PAGE_SIZE = 50;
const DISCUSSION_PAGE_LIMIT = 5;
const REVIEW_COMMENT_LIMIT = 20;
// GitLab rebases asynchronously; poll `rebase_in_progress` for at most a minute.
const REBASE_POLL_LIMIT = 60;

type GitLabOperation =
  | "execute"
  | "stdout"
  | "getViewerLogin"
  | "listConfiguredHosts"
  | "listRepositoryPullRequests"
  | "getPullRequestListItem"
  | "listReviewRequestedPullRequestNumbers"
  | "getPullRequestDetail"
  | "getRepositoryMergeCapabilities"
  | "getPullRequestDiff"
  | "runPullRequestAction"
  | "commentOnPullRequest"
  | "listOpenPullRequests"
  | "listPullRequests"
  | "getPullRequest"
  | "getPullRequestWithChecks"
  | "getPullRequestReviewComments"
  | "getRepositoryCloneUrls"
  | "createPullRequest"
  | "getDefaultBranch"
  | "checkoutPullRequest"
  | "projectArgs";

const NOT_AUTHENTICATED_MARKERS = [
  "401",
  "unauthorized",
  "glab auth login",
  "no token",
  "not logged in",
  "invalid_token",
  "authentication",
] as const;

function normalizeGitLabCliError(
  operation: GitLabOperation,
  error: unknown,
  host?: string,
): GitHostCliError {
  if (!(error instanceof Error)) {
    return new GitHostCliError({
      host: "gitlab",
      operation,
      detail: "GitLab CLI command failed.",
      reason: "other",
      cause: error,
    });
  }

  if (error.message.includes("Command not found: glab")) {
    return new GitHostCliError({
      host: "gitlab",
      operation,
      detail: "GitLab CLI (`glab`) is required but not available on PATH.",
      reason: "not-installed",
      cause: error,
    });
  }

  const lower = error.message.toLowerCase();
  if (NOT_AUTHENTICATED_MARKERS.some((marker) => lower.includes(marker))) {
    const hostFlag = host ? ` --hostname ${host}` : "";
    return new GitHostCliError({
      host: "gitlab",
      operation,
      detail: `GitLab CLI is not authenticated. Run \`glab auth login${hostFlag}\` and retry.`,
      reason: "not-authenticated",
      cause: error,
    });
  }

  if (lower.includes("404") || lower.includes("not found") || lower.includes("no merge request")) {
    return new GitHostCliError({
      host: "gitlab",
      operation,
      detail: "Merge request not found. Check the MR number or URL and try again.",
      reason: "not-found",
      cause: error,
    });
  }

  return new GitHostCliError({
    host: "gitlab",
    operation,
    detail: `GitLab CLI command failed: ${error.message}`,
    reason: "other",
    cause: error,
  });
}

function notFound(operation: GitLabOperation, detail: string): GitHostCliError {
  return new GitHostCliError({ host: "gitlab", operation, detail, reason: "not-found" });
}

function otherError(operation: GitLabOperation, detail: string): GitHostCliError {
  return new GitHostCliError({ host: "gitlab", operation, detail, reason: "other" });
}

// GitLab reports `merged`/`closed`/`opened`/`locked`; a set `mergedAt` wins because a locked or
// reopened-then-merged MR can lag behind its state field.
function normalizeMergeRequestState(
  state: string | null | undefined,
  mergedAt: string | null | undefined,
): "open" | "closed" | "merged" {
  if (mergedAt || state?.toLowerCase() === "merged") return "merged";
  if (state?.toLowerCase() === "closed") return "closed";
  return "open";
}

function normalizeMergeability(input: {
  readonly conflicts?: boolean | null | undefined;
  readonly detailedMergeStatus?: string | null | undefined;
}): "mergeable" | "conflicting" | "unknown" {
  const status = input.detailedMergeStatus?.toUpperCase() ?? null;
  if (input.conflicts === true || status === "CONFLICT" || status === "BROKEN_STATUS") {
    return "conflicting";
  }
  // GitLab computes merge status lazily; `UNCHECKED`/`CHECKING` mean "ask again later".
  if (status === null || status === "UNCHECKED" || status === "CHECKING" || status === "PREPARING") {
    return "unknown";
  }
  return "mergeable";
}

// GitLab has no review-decision concept; the approval rule state is the closest equivalent.
function normalizeReviewDecision(input: {
  readonly approved?: boolean | null | undefined;
  readonly approvalsRequired?: number | null | undefined;
}): string | null {
  if (input.approved === true) return "APPROVED";
  if ((input.approvalsRequired ?? 0) > 0) return "REVIEW_REQUIRED";
  return null;
}

function normalizePipelineJobStatus(
  status: string | null | undefined,
  allowFailure: boolean | null | undefined,
): GitPullRequestCheckStatus {
  switch (status?.toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "FAILED":
      // An `allow_failure` job that failed does not gate the pipeline, so it is not a failure.
      return allowFailure === true ? "neutral" : "failure";
    case "CANCELED":
    case "CANCELING":
      return "cancelled";
    case "SKIPPED":
    case "MANUAL":
      return "skipped";
    default:
      return "pending";
  }
}

const RawGraphQlErrorSchema = Schema.Struct({
  errors: Schema.optional(
    Schema.NullOr(
      Schema.Array(Schema.Struct({ message: Schema.optional(Schema.NullOr(Schema.String)) })),
    ),
  ),
});

function graphQlErrorDetail(decoded: unknown): string | null {
  if (!decoded || typeof decoded !== "object" || !("errors" in decoded)) return null;
  const errors = decoded.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const messages = errors.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || !("message" in entry)) return [];
    const message = typeof entry.message === "string" ? entry.message.trim() : "";
    return message.length > 0 ? [message] : [];
  });
  return messages.length > 0 ? messages.join("; ") : "GitLab GraphQL request failed.";
}

interface GitLabProjectArgs {
  readonly host: string;
  readonly fullPath: string;
  /** REST path prefix; GitLab requires the whole project path to be URL-encoded. */
  readonly apiPrefix: string;
  /** Value for the `glab mr -R` flag, which takes a project URL. */
  readonly repoFlag: string;
}

const RawUserSchema = Schema.Struct({
  username: TrimmedNonEmptyString,
});

const RawGraphQlActorSchema = Schema.Struct({
  username: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
  webUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawGraphQlLabelSchema = Schema.Struct({
  title: TrimmedNonEmptyString,
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawDiffStatsSummarySchema = Schema.Struct({
  additions: Schema.optional(Schema.NullOr(Schema.Number)),
  deletions: Schema.optional(Schema.NullOr(Schema.Number)),
  fileCount: Schema.optional(Schema.NullOr(Schema.Number)),
});

const RawGraphQlMergeRequestListNodeSchema = Schema.Struct({
  iid: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  webUrl: TrimmedNonEmptyString,
  author: Schema.optional(Schema.NullOr(RawGraphQlActorSchema)),
  sourceBranch: TrimmedNonEmptyString,
  targetBranch: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  conflicts: Schema.optional(Schema.NullOr(Schema.Boolean)),
  detailedMergeStatus: Schema.optional(Schema.NullOr(Schema.String)),
  approved: Schema.optional(Schema.NullOr(Schema.Boolean)),
  approvalsRequired: Schema.optional(Schema.NullOr(Schema.Number)),
  diffStatsSummary: Schema.optional(Schema.NullOr(RawDiffStatsSummarySchema)),
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  reviewers: Schema.optional(
    Schema.NullOr(Schema.Struct({ nodes: Schema.Array(RawGraphQlActorSchema) })),
  ),
  labels: Schema.optional(
    Schema.NullOr(Schema.Struct({ nodes: Schema.Array(RawGraphQlLabelSchema) })),
  ),
});

const RawGraphQlMergeRequestListResponseSchema = Schema.Struct({
  ...RawGraphQlErrorSchema.fields,
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        project: Schema.NullOr(
          Schema.Struct({
            mergeRequests: Schema.NullOr(
              Schema.Struct({
                nodes: Schema.Array(Schema.Unknown),
              }),
            ),
          }),
        ),
      }),
    ),
  ),
});

const RawGraphQlSingleMergeRequestResponseSchema = Schema.Struct({
  ...RawGraphQlErrorSchema.fields,
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        project: Schema.NullOr(
          Schema.Struct({
            mergeRequest: Schema.NullOr(Schema.Unknown),
          }),
        ),
      }),
    ),
  ),
});

const RawGraphQlNumbersResponseSchema = Schema.Struct({
  ...RawGraphQlErrorSchema.fields,
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        project: Schema.NullOr(
          Schema.Struct({
            mergeRequests: Schema.NullOr(
              Schema.Struct({
                nodes: Schema.Array(Schema.Struct({ iid: TrimmedNonEmptyString })),
              }),
            ),
          }),
        ),
      }),
    ),
  ),
});

const RawGraphQlJobSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  allowFailure: Schema.optional(Schema.NullOr(Schema.Boolean)),
  startedAt: Schema.optional(Schema.NullOr(Schema.String)),
  finishedAt: Schema.optional(Schema.NullOr(Schema.String)),
  detailedStatus: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        label: Schema.optional(Schema.NullOr(Schema.String)),
        detailsPath: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const RawGraphQlNoteSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  system: Schema.optional(Schema.NullOr(Schema.Boolean)),
  createdAt: TrimmedNonEmptyString,
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawGraphQlActorSchema)),
  position: Schema.optional(
    Schema.NullOr(Schema.Struct({ filePath: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

const RawGraphQlCommitSchema = Schema.Struct({
  sha: TrimmedNonEmptyString,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.optional(Schema.NullOr(Schema.String)),
  committedDate: TrimmedNonEmptyString,
  webUrl: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawGraphQlActorSchema)),
  authorName: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawGraphQlMergeRequestDetailNodeSchema = Schema.Struct({
  ...RawGraphQlMergeRequestListNodeSchema.fields,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  allowCollaboration: Schema.optional(Schema.NullOr(Schema.Boolean)),
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  headPipeline: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        status: Schema.optional(Schema.NullOr(Schema.String)),
        jobs: Schema.optional(
          Schema.NullOr(Schema.Struct({ nodes: Schema.Array(RawGraphQlJobSchema) })),
        ),
      }),
    ),
  ),
  notes: Schema.optional(
    Schema.NullOr(Schema.Struct({ nodes: Schema.Array(RawGraphQlNoteSchema) })),
  ),
  commits: Schema.optional(
    Schema.NullOr(Schema.Struct({ nodes: Schema.Array(RawGraphQlCommitSchema) })),
  ),
});

// REST merge-request shape used by `glab mr view/list -F json` and `projects/:id/merge_requests`.
const RawRestMergeRequestSchema = Schema.Struct({
  iid: PositiveInt,
  title: TrimmedNonEmptyString,
  web_url: TrimmedNonEmptyString,
  source_branch: TrimmedNonEmptyString,
  target_branch: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  has_conflicts: Schema.optional(Schema.NullOr(Schema.Boolean)),
  detailed_merge_status: Schema.optional(Schema.NullOr(Schema.String)),
  changes_count: Schema.optional(Schema.NullOr(Schema.String)),
  source_project_id: Schema.optional(Schema.NullOr(Schema.Number)),
  target_project_id: Schema.optional(Schema.NullOr(Schema.Number)),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  merge_when_pipeline_succeeds: Schema.optional(Schema.NullOr(Schema.Boolean)),
  merge_error: Schema.optional(Schema.NullOr(Schema.String)),
  rebase_in_progress: Schema.optional(Schema.NullOr(Schema.Boolean)),
  head_pipeline: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.Number,
        status: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const RawRestProjectSchema = Schema.Struct({
  path_with_namespace: TrimmedNonEmptyString,
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
  ssh_url_to_repo: TrimmedNonEmptyString,
  http_url_to_repo: TrimmedNonEmptyString,
  merge_method: Schema.optional(Schema.NullOr(Schema.String)),
  squash_option: Schema.optional(Schema.NullOr(Schema.String)),
  remove_source_branch_after_merge: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const RawRestJobSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  allow_failure: Schema.optional(Schema.NullOr(Schema.Boolean)),
  web_url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawRestDiscussionSchema = Schema.Struct({
  notes: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          id: Schema.Number,
          body: Schema.optional(Schema.NullOr(Schema.String)),
          system: Schema.optional(Schema.NullOr(Schema.Boolean)),
          resolvable: Schema.optional(Schema.NullOr(Schema.Boolean)),
          resolved: Schema.optional(Schema.NullOr(Schema.Boolean)),
          created_at: Schema.optional(Schema.NullOr(Schema.String)),
          author: Schema.optional(Schema.NullOr(RawUserSchema)),
          position: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                new_path: Schema.optional(Schema.NullOr(Schema.String)),
                old_path: Schema.optional(Schema.NullOr(Schema.String)),
              }),
            ),
          ),
        }),
      ),
    ),
  ),
});

const decodeGraphQlListNode = Schema.decodeUnknownSync(RawGraphQlMergeRequestListNodeSchema);
const decodeGraphQlDetailNode = Schema.decodeUnknownSync(RawGraphQlMergeRequestDetailNodeSchema);

type GraphQlActor = Schema.Schema.Type<typeof RawGraphQlActorSchema>;
type GraphQlListNode = Schema.Schema.Type<typeof RawGraphQlMergeRequestListNodeSchema>;
type GraphQlDetailNode = Schema.Schema.Type<typeof RawGraphQlMergeRequestDetailNodeSchema>;
type RestMergeRequest = Schema.Schema.Type<typeof RawRestMergeRequestSchema>;

function normalizeActor(host: string, raw: GraphQlActor | null | undefined): PullRequestActor | null {
  const login = raw?.username?.trim() ?? "";
  if (login.length === 0) return null;
  return {
    login,
    name: raw?.name?.trim() || null,
    avatarUrl: gitlabAbsoluteUrl(host, raw?.avatarUrl),
    url: raw?.webUrl?.trim() || null,
  };
}

function normalizeLabels(
  raw: GraphQlListNode["labels"],
): ReadonlyArray<PullRequestLabel> {
  return (raw?.nodes ?? []).map((label) => ({
    name: label.title,
    color: label.color?.trim() || null,
  }));
}

function normalizeListNode(host: string, raw: GraphQlListNode): GitHostPullRequestListItem {
  return {
    number: Number(raw.iid),
    title: raw.title,
    url: raw.webUrl,
    author: normalizeActor(host, raw.author),
    headBranch: raw.sourceBranch,
    baseBranch: raw.targetBranch,
    state: normalizeMergeRequestState(raw.state, raw.mergedAt),
    isDraft: raw.draft === true,
    additions: Math.max(0, Math.trunc(raw.diffStatsSummary?.additions ?? 0)),
    deletions: Math.max(0, Math.trunc(raw.diffStatsSummary?.deletions ?? 0)),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    reviewDecision: normalizeReviewDecision({
      approved: raw.approved,
      approvalsRequired: raw.approvalsRequired,
    }),
    reviewRequestLogins: (raw.reviewers?.nodes ?? []).flatMap((reviewer) => {
      const login = reviewer.username?.trim() ?? "";
      return login.length > 0 ? [login] : [];
    }),
    labels: normalizeLabels(raw.labels),
    mergeability: normalizeMergeability({
      conflicts: raw.conflicts,
      detailedMergeStatus: raw.detailedMergeStatus,
    }),
    // GitLab has no stacked-MR concept, so no row ever carries stack metadata.
    stack: null,
  };
}

function normalizeDetailChecks(
  host: string,
  raw: GraphQlDetailNode["headPipeline"],
): ReadonlyArray<PullRequestCheck> {
  return (raw?.jobs?.nodes ?? []).flatMap((job) => {
    const name = job.name?.trim() ?? "";
    if (name.length === 0) return [];
    return [
      {
        name,
        status: normalizePipelineJobStatus(job.status, job.allowFailure),
        description: job.detailedStatus?.label?.trim() || null,
        url: gitlabAbsoluteUrl(host, job.detailedStatus?.detailsPath),
        startedAt: job.startedAt?.trim() || null,
        completedAt: job.finishedAt?.trim() || null,
      } satisfies PullRequestCheck,
    ];
  });
}

function normalizeDetailComments(
  host: string,
  raw: GraphQlDetailNode["notes"],
): ReadonlyArray<PullRequestComment> {
  return (raw?.nodes ?? []).flatMap((note) => {
    // System notes are activity-feed entries ("assigned to @x"), never human comments.
    if (note.system === true) return [];
    return [
      {
        id: note.id,
        kind: note.position ? ("review-comment" as const) : ("issue-comment" as const),
        author: normalizeActor(host, note.author),
        body: note.body ?? "",
        createdAt: note.createdAt,
        updatedAt: note.updatedAt?.trim() || null,
        url: note.url?.trim() || null,
        path: note.position?.filePath?.trim() || null,
        reviewState: null,
      } satisfies PullRequestComment,
    ];
  });
}

function normalizeDetailCommits(
  host: string,
  raw: GraphQlDetailNode["commits"],
): ReadonlyArray<PullRequestCommit> {
  return (raw?.nodes ?? []).map((commit) => {
    const message = commit.message ?? "";
    const headline = commit.title?.trim() || message.split("\n")[0]?.trim() || "";
    const author =
      normalizeActor(host, commit.author) ??
      (commit.authorName?.trim()
        ? {
            login: commit.authorName.trim(),
            name: commit.authorName.trim(),
            avatarUrl: null,
            url: null,
          }
        : null);
    return {
      oid: commit.sha,
      messageHeadline: headline,
      messageBody: message.split("\n").slice(1).join("\n").trim(),
      committedDate: commit.committedDate,
      authors: author ? [author] : [],
    } satisfies PullRequestCommit;
  });
}

function normalizeRestSummary(raw: RestMergeRequest): GitHostPullRequestSummary {
  // GitLab reports `changes_count` as a string, and as "N+" once the diff is truncated.
  const changedFiles = Number(raw.changes_count);
  return {
    number: raw.iid,
    title: raw.title,
    url: raw.web_url,
    baseRefName: raw.target_branch,
    headRefName: raw.source_branch,
    state: normalizeMergeRequestState(raw.state, raw.merged_at),
    isDraft: raw.draft === true,
    mergeability: normalizeMergeability({
      conflicts: raw.has_conflicts,
      detailedMergeStatus: raw.detailed_merge_status,
    }),
    additions: null,
    deletions: null,
    changedFiles: Number.isSafeInteger(changedFiles) ? changedFiles : null,
    isCrossRepository:
      raw.source_project_id != null &&
      raw.target_project_id != null &&
      raw.source_project_id !== raw.target_project_id,
    updatedAt: raw.updated_at?.trim() || null,
  };
}

const MERGE_REQUEST_LIST_NODE_FIELDS = `
  iid
  title
  webUrl
  author { username name avatarUrl webUrl }
  sourceBranch
  targetBranch
  state
  draft
  conflicts
  detailedMergeStatus
  approved
  approvalsRequired
  diffStatsSummary { additions deletions fileCount }
  createdAt
  updatedAt
  mergedAt
  reviewers { nodes { username name avatarUrl webUrl } }
  labels { nodes { title color } }
`;

const MERGE_REQUEST_DETAIL_NODE_FIELDS = `
  ${MERGE_REQUEST_LIST_NODE_FIELDS}
  description
  allowCollaboration
  closedAt
  headPipeline {
    status
    jobs(first: ${DETAIL_CONNECTION_LIMIT}) {
      nodes { name status allowFailure startedAt finishedAt detailedStatus { label detailsPath } }
    }
  }
  notes(first: ${DETAIL_CONNECTION_LIMIT}) {
    nodes {
      id body system createdAt updatedAt url
      author { username name avatarUrl webUrl }
      position { filePath }
    }
  }
  commits(first: ${DETAIL_CONNECTION_LIMIT}) {
    nodes {
      sha title message committedDate webUrl authorName
      author { username name avatarUrl webUrl }
    }
  }
`;

const MERGE_REQUEST_DETAIL_QUERY = `query($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {${MERGE_REQUEST_DETAIL_NODE_FIELDS}}
  }
}`;

const MERGE_REQUEST_LIST_ITEM_QUERY = `query($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {${MERGE_REQUEST_LIST_NODE_FIELDS}}
  }
}`;

const REVIEW_REQUESTED_NUMBERS_QUERY = `query($fullPath: ID!, $viewer: String!, $first: Int!) {
  project(fullPath: $fullPath) {
    mergeRequests(state: opened, reviewerUsername: $viewer, first: $first, sort: UPDATED_DESC) {
      nodes { iid }
    }
  }
}`;

function mergeRequestListQuery(involvement: "authored" | "reviewing" | "all"): string {
  const involvementArg =
    involvement === "authored"
      ? ", authorUsername: $viewer"
      : involvement === "reviewing"
        ? ", reviewerUsername: $viewer"
        : "";
  const viewerParam = involvement === "all" ? "" : ", $viewer: String!";
  return `query($fullPath: ID!, $state: MergeRequestState!, $first: Int!${viewerParam}) {
  project(fullPath: $fullPath) {
    mergeRequests(state: $state, first: $first, sort: UPDATED_DESC${involvementArg}) {
      nodes {${MERGE_REQUEST_LIST_NODE_FIELDS}}
    }
  }
}`;
}

const GRAPHQL_MERGE_REQUEST_STATES = {
  open: "opened",
  closed: "closed",
  merged: "merged",
} as const;

export const makeGitLabCli = Effect.sync(() => {
  const execute: GitLabCliShape["execute"] = (input) =>
    Effect.tryPromise({
      try: (signal) =>
        runProcess("glab", input.args, {
          cwd: input.cwd,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal,
          // The host is always selected per call (`--hostname`/`-R`) so no ambient GITLAB_HOST
          // can redirect a command at a different instance than the caller asked for.
          env: {
            ...process.env,
            ...input.env,
            NO_COLOR: "1",
            GLAB_SEND_TELEMETRY: "0",
          },
          ...(input.maxBufferBytes !== undefined ? { maxBufferBytes: input.maxBufferBytes } : {}),
          ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
          ...(input.allowNonZeroExit !== undefined
            ? { allowNonZeroExit: input.allowNonZeroExit }
            : {}),
          ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
          ...(input.onStdoutChunk !== undefined ? { onStdoutChunk: input.onStdoutChunk } : {}),
          ...(input.onStderrChunk !== undefined ? { onStderrChunk: input.onStderrChunk } : {}),
        }),
      catch: (error) => normalizeGitLabCliError("execute", error),
    });

  const projectArgs = (
    repository: string,
    operation: GitLabOperation,
  ): Effect.Effect<GitLabProjectArgs, GitHostCliError> => {
    const parsed = parseGitLabRepositoryReference(repository);
    return parsed
      ? Effect.succeed({
          host: parsed.host,
          fullPath: parsed.fullPath,
          apiPrefix: `projects/${encodeURIComponent(parsed.fullPath)}`,
          repoFlag: `https://${parsed.host}/${parsed.fullPath}`,
        })
      : Effect.fail(otherError(operation, `Invalid GitLab project identity: ${repository}`));
  };

  const decodeJson = <S extends Schema.Top>(
    raw: string,
    schema: S,
    operation: GitLabOperation,
    invalidDetail: string,
  ): Effect.Effect<S["Type"], GitHostCliError, S["DecodingServices"]> =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
      Effect.mapError(
        (error) =>
          new GitHostCliError({
            host: "gitlab",
            operation,
            detail: error instanceof Error ? `${invalidDetail}: ${error.message}` : invalidDetail,
            cause: error,
          }),
      ),
    );

  const runRestJson = <S extends Schema.Top>(input: {
    readonly cwd: string;
    readonly host?: string;
    readonly endpoint: string;
    readonly schema: S;
    readonly operation: GitLabOperation;
    readonly invalidDetail: string;
    readonly method?: "PUT" | "POST" | "DELETE";
    readonly stdin?: string;
    readonly allowNonZeroExit?: boolean;
  }) =>
    execute({
      cwd: input.cwd,
      args: [
        "api",
        ...(input.host ? ["--hostname", input.host] : []),
        ...(input.method ? ["-X", input.method] : []),
        input.endpoint,
        ...(input.stdin !== undefined ? ["--input", "-"] : []),
      ],
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.allowNonZeroExit !== undefined
        ? { allowNonZeroExit: input.allowNonZeroExit }
        : {}),
    }).pipe(
      Effect.flatMap((result) =>
        decodeJson(result.stdout.trim(), input.schema, input.operation, input.invalidDetail),
      ),
    );

  const runGraphQl = <S extends Schema.Top>(input: {
    readonly cwd: string;
    readonly host: string;
    readonly query: string;
    readonly variables: Readonly<Record<string, string>>;
    readonly schema: S;
    readonly operation: GitLabOperation;
    readonly invalidDetail: string;
  }) =>
    execute({
      cwd: input.cwd,
      args: [
        "api",
        "--hostname",
        input.host,
        "graphql",
        "-f",
        `query=${input.query}`,
        ...Object.entries(input.variables).flatMap(([key, value]) => ["-f", `${key}=${value}`]),
      ],
    }).pipe(
      Effect.flatMap((result) =>
        decodeJson(result.stdout.trim(), input.schema, input.operation, input.invalidDetail),
      ),
      Effect.flatMap((decoded) => {
        const detail = graphQlErrorDetail(decoded);
        return detail ? Effect.fail(otherError(input.operation, detail)) : Effect.succeed(decoded);
      }),
    );

  const restMergeRequest = (input: {
    readonly cwd: string;
    readonly host: string;
    readonly apiPrefix: string;
    readonly number: number;
    readonly operation: GitLabOperation;
    readonly query?: string;
  }) =>
    runRestJson({
      cwd: input.cwd,
      host: input.host,
      endpoint: `${input.apiPrefix}/merge_requests/${input.number}${input.query ?? ""}`,
      schema: RawRestMergeRequestSchema,
      operation: input.operation,
      invalidDetail: "GitLab returned an invalid merge request payload.",
    });

  const runRebaseAndWait = (input: {
    readonly cwd: string;
    readonly host: string;
    readonly apiPrefix: string;
    readonly number: number;
  }) =>
    Effect.gen(function* () {
      yield* execute({
        cwd: input.cwd,
        args: [
          "api",
          "--hostname",
          input.host,
          "-X",
          "PUT",
          `${input.apiPrefix}/merge_requests/${input.number}/rebase`,
        ],
      });

      for (let poll = 0; poll < REBASE_POLL_LIMIT; poll += 1) {
        yield* Effect.sleep("1 second");
        const mergeRequest = yield* restMergeRequest({
          ...input,
          operation: "runPullRequestAction",
          query: "?include_rebase_in_progress=true",
        });
        if (mergeRequest.merge_error?.trim()) {
          return yield* Effect.fail(
            otherError("runPullRequestAction", mergeRequest.merge_error.trim()),
          );
        }
        if (mergeRequest.rebase_in_progress !== true) {
          return;
        }
      }

      return yield* Effect.fail(
        otherError("runPullRequestAction", "GitLab's rebase did not finish within one minute."),
      );
    });

  const PIPELINE_PENDING_STATUSES = new Set([
    "created",
    "waiting_for_resource",
    "preparing",
    "pending",
    "running",
    "scheduled",
  ]);

  const service = {
    execute,

    listConfiguredHosts: (input) =>
      execute({
        cwd: input.cwd,
        // Exit code is 1 whenever any configured host fails auth, and the host list is on stderr.
        args: ["auth", "status", "--all"],
        allowNonZeroExit: true,
      }).pipe(
        Effect.map((result) => {
          const hosts = new Set<string>();
          for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
            // Host headers are unindented lines carrying nothing but the hostname.
            if (line.length === 0 || /^\s/.test(line)) continue;
            const candidate = line.trim().toLowerCase();
            if (candidate.includes(".") && /^[a-z0-9.-]+$/.test(candidate)) {
              hosts.add(candidate);
            }
          }
          return [...hosts];
        }),
        Effect.catch((error) =>
          error.reason === "not-installed"
            ? Effect.fail(error)
            : Effect.succeed([] as ReadonlyArray<string>),
        ),
      ),

    getViewerLogin: (input) =>
      runRestJson({
        cwd: input.cwd,
        host: input.host,
        endpoint: "user",
        schema: RawUserSchema,
        operation: "getViewerLogin",
        invalidDetail: "GitLab CLI returned an invalid viewer payload.",
      }).pipe(Effect.map((user) => user.username)),

    listRepositoryPullRequests: (input) =>
      projectArgs(input.repository, "listRepositoryPullRequests").pipe(
        Effect.flatMap(({ host, fullPath }) =>
          runGraphQl({
            cwd: input.cwd,
            host,
            query: mergeRequestListQuery(input.involvement),
            variables: {
              fullPath,
              state: GRAPHQL_MERGE_REQUEST_STATES[input.state],
              first: String(input.limit ?? DEFAULT_LIST_LIMIT),
              ...(input.involvement === "all" ? {} : { viewer: input.viewer }),
            },
            schema: RawGraphQlMergeRequestListResponseSchema,
            operation: "listRepositoryPullRequests",
            invalidDetail: "GitLab returned an invalid merge request list payload.",
          }).pipe(
            Effect.map((decoded) => {
              const nodes = decoded.data?.project?.mergeRequests?.nodes ?? [];
              // One malformed MR must not hide the healthy ones in the same page.
              const entries = nodes.flatMap((node) => {
                try {
                  return [normalizeListNode(host, decodeGraphQlListNode(node))];
                } catch {
                  return [];
                }
              });
              return { entries, rawCount: nodes.length } satisfies GitHostPullRequestListBatch;
            }),
          ),
        ),
      ),

    getPullRequestListItem: (input) =>
      projectArgs(input.repository, "getPullRequestListItem").pipe(
        Effect.flatMap(({ host, fullPath }) =>
          runGraphQl({
            cwd: input.cwd,
            host,
            query: MERGE_REQUEST_LIST_ITEM_QUERY,
            variables: { fullPath, iid: String(input.number) },
            schema: RawGraphQlSingleMergeRequestResponseSchema,
            operation: "getPullRequestListItem",
            invalidDetail: "GitLab returned an invalid merge request payload.",
          }).pipe(
            Effect.flatMap((decoded) => {
              const node = decoded.data?.project?.mergeRequest ?? null;
              return node
                ? Effect.succeed(normalizeListNode(host, decodeGraphQlListNode(node)))
                : Effect.fail(
                    notFound(
                      "getPullRequestListItem",
                      `Merge request !${input.number} was not found in ${input.repository}.`,
                    ),
                  );
            }),
          ),
        ),
      ),

    listReviewRequestedPullRequestNumbers: (input) =>
      projectArgs(input.repository, "listReviewRequestedPullRequestNumbers").pipe(
        Effect.flatMap(({ host, fullPath }) =>
          runGraphQl({
            cwd: input.cwd,
            host,
            query: REVIEW_REQUESTED_NUMBERS_QUERY,
            variables: {
              fullPath,
              viewer: input.viewer,
              first: String(input.limit ?? DEFAULT_LIST_LIMIT),
            },
            schema: RawGraphQlNumbersResponseSchema,
            operation: "listReviewRequestedPullRequestNumbers",
            invalidDetail: "GitLab returned an invalid review-requested list payload.",
          }).pipe(
            Effect.map((decoded) =>
              (decoded.data?.project?.mergeRequests?.nodes ?? []).flatMap((node) => {
                const number = Number(node.iid);
                return Number.isSafeInteger(number) && number > 0 ? [number] : [];
              }),
            ),
          ),
        ),
      ),

    getPullRequestDetail: (input) =>
      projectArgs(input.repository, "getPullRequestDetail").pipe(
        Effect.flatMap(({ host, fullPath }) =>
          runGraphQl({
            cwd: input.cwd,
            host,
            query: MERGE_REQUEST_DETAIL_QUERY,
            variables: { fullPath, iid: String(input.number) },
            schema: RawGraphQlSingleMergeRequestResponseSchema,
            operation: "getPullRequestDetail",
            invalidDetail: "GitLab returned an invalid merge request detail payload.",
          }).pipe(
            Effect.flatMap((decoded) => {
              const node = decoded.data?.project?.mergeRequest ?? null;
              if (!node) {
                return Effect.fail(
                  notFound(
                    "getPullRequestDetail",
                    `Merge request !${input.number} was not found in ${input.repository}.`,
                  ),
                );
              }
              const raw = decodeGraphQlDetailNode(node);
              const listItem = normalizeListNode(host, raw);
              return Effect.succeed({
                number: listItem.number,
                title: listItem.title,
                body: raw.description ?? "",
                url: listItem.url,
                author: listItem.author,
                state: listItem.state,
                isDraft: listItem.isDraft,
                mergeable: raw.detailedMergeStatus?.trim() || null,
                mergeability: listItem.mergeability,
                mergeStateStatus: raw.detailedMergeStatus?.trim() || null,
                reviewDecision: listItem.reviewDecision,
                additions: listItem.additions,
                deletions: listItem.deletions,
                changedFiles: Math.max(0, Math.trunc(raw.diffStatsSummary?.fileCount ?? 0)),
                headBranch: listItem.headBranch,
                baseBranch: listItem.baseBranch,
                createdAt: listItem.createdAt,
                updatedAt: listItem.updatedAt,
                mergedAt: raw.mergedAt?.trim() || null,
                closedAt: raw.closedAt?.trim() || null,
                maintainerCanModify: raw.allowCollaboration === true,
                reviewers: (raw.reviewers?.nodes ?? []).flatMap((reviewer) => {
                  const actor = normalizeActor(host, reviewer);
                  return actor ? [actor] : [];
                }),
                labels: listItem.labels,
                checks: normalizeDetailChecks(host, raw.headPipeline),
                comments: normalizeDetailComments(host, raw.notes),
                commits: normalizeDetailCommits(host, raw.commits),
              } satisfies GitHostPullRequestDetailData);
            }),
          ),
        ),
      ),

    // GitLab has no stacked-merge-request concept, so there is never a stack to report.
    getPullRequestStack: () => Effect.succeed(null),

    getRepositoryMergeCapabilities: (input) =>
      projectArgs(input.repository, "getRepositoryMergeCapabilities").pipe(
        Effect.flatMap(({ host, apiPrefix }) =>
          runRestJson({
            cwd: input.cwd,
            host,
            endpoint: apiPrefix,
            schema: RawRestProjectSchema,
            operation: "getRepositoryMergeCapabilities",
            invalidDetail: "GitLab returned an invalid project payload.",
          }),
        ),
        Effect.map((project) => {
          const mergeMethod = project.merge_method ?? "merge";
          const squashOption = project.squash_option ?? "default_off";
          return {
            merge: mergeMethod !== "ff" && squashOption !== "always",
            squash: squashOption !== "never",
            rebase:
              (mergeMethod === "ff" || mergeMethod === "rebase_merge") && squashOption !== "always",
            deleteBranchOnMerge: project.remove_source_branch_after_merge === true,
          } satisfies PullRequestMergeCapabilities;
        }),
      ),

    getPullRequestDiff: (input) =>
      projectArgs(input.repository, "getPullRequestDiff").pipe(
        Effect.flatMap(({ repoFlag }) =>
          execute({
            cwd: input.cwd,
            args: ["mr", "diff", String(input.number), "-R", repoFlag, "--raw"],
            maxBufferBytes: PULL_REQUEST_DIFF_MAX_BYTES,
            outputMode: "truncate",
          }),
        ),
        Effect.map((result) => ({
          patch: result.stdout,
          truncated: result.stdoutTruncated === true,
        })),
      ),

    runPullRequestAction: (input) =>
      projectArgs(input.repository, "runPullRequestAction").pipe(
        Effect.flatMap(({ host, apiPrefix, repoFlag }) =>
          Effect.gen(function* () {
            const number = String(input.number);
            if (input.action !== "merge") {
              const args =
                input.action === "close"
                  ? ["mr", "close", number, "-R", repoFlag]
                  : input.action === "reopen"
                    ? ["mr", "reopen", number, "-R", repoFlag]
                    : [
                        "mr",
                        "update",
                        number,
                        "-R",
                        repoFlag,
                        input.action === "ready" ? "--ready" : "--draft",
                      ];
              yield* execute({ cwd: input.cwd, args });
              return { mergeOutcome: null };
            }

            if (input.mergeMethod === "rebase") {
              yield* runRebaseAndWait({ cwd: input.cwd, host, apiPrefix, number: input.number });
            }

            const before = yield* restMergeRequest({
              cwd: input.cwd,
              host,
              apiPrefix,
              number: input.number,
              operation: "runPullRequestAction",
            });
            // A pipeline still in flight makes an immediate merge impossible; GitLab's equivalent
            // of GitHub's merge queue is "merge when pipeline succeeds".
            const enqueue = PIPELINE_PENDING_STATUSES.has(
              before.head_pipeline?.status?.toLowerCase() ?? "",
            );
            const merged = yield* runRestJson({
              cwd: input.cwd,
              host,
              endpoint: `${apiPrefix}/merge_requests/${input.number}/merge`,
              method: "PUT",
              stdin: JSON.stringify({
                squash: input.mergeMethod === "squash",
                ...(enqueue ? { merge_when_pipeline_succeeds: true } : {}),
              }),
              schema: RawRestMergeRequestSchema,
              operation: "runPullRequestAction",
              invalidDetail:
                "GitLab refused the merge (draft, conflicts, unresolved discussions, failing pipeline, or missing approvals).",
            });

            if (normalizeMergeRequestState(merged.state, merged.merged_at) === "merged") {
              return { mergeOutcome: "merged" as const };
            }
            if (merged.merge_when_pipeline_succeeds === true) {
              return { mergeOutcome: "enqueued" as const };
            }
            return yield* Effect.fail(
              otherError(
                "runPullRequestAction",
                `GitLab did not merge the merge request: ${merged.detailed_merge_status ?? merged.state ?? "unknown state"}`,
              ),
            );
          }),
        ),
      ),

    commentOnPullRequest: (input) =>
      projectArgs(input.repository, "commentOnPullRequest").pipe(
        Effect.flatMap(({ host, apiPrefix }) =>
          execute({
            cwd: input.cwd,
            // The body rides stdin so a comment can never leak into the process table.
            args: [
              "api",
              "--hostname",
              host,
              "-X",
              "POST",
              `${apiPrefix}/merge_requests/${input.number}/notes`,
              "--input",
              "-",
            ],
            stdin: JSON.stringify({ body: input.body }),
          }),
        ),
        Effect.asVoid,
      ),

    listOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "mr",
          "list",
          "-F",
          "json",
          "--source-branch",
          stripSelectorPrefix(input.headSelector),
          "--per-page",
          String(input.limit ?? OPEN_PR_LOOKUP_LIMIT),
        ],
      }).pipe(Effect.flatMap((result) => decodeMergeRequestList(result.stdout))),

    listPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "mr",
          "list",
          "-F",
          "json",
          "--all",
          "--source-branch",
          stripSelectorPrefix(input.headSelector),
          "--per-page",
          String(input.limit ?? OPEN_PR_LOOKUP_LIMIT),
        ],
      }).pipe(Effect.flatMap((result) => decodeMergeRequestList(result.stdout))),

    getPullRequest: (input) =>
      resolveMergeRequest(input).pipe(Effect.map(normalizeRestSummary)),

    getPullRequestWithChecks: (input) =>
      resolveMergeRequest(input).pipe(
        Effect.flatMap((mergeRequest) => {
          const pipelineId = mergeRequest.head_pipeline?.id;
          if (pipelineId === undefined) {
            return Effect.succeed({
              summary: normalizeRestSummary(mergeRequest),
              checks: [] as ReadonlyArray<GitPullRequestCheck>,
            });
          }
          const parsed = parseGitLabMergeRequestUrl(mergeRequest.web_url);
          const project = parsed ? parseGitLabRepositoryReference(parsed.reference) : null;
          return runRestJson({
            cwd: input.cwd,
            ...(project ? { host: project.host } : {}),
            endpoint: project
              ? `projects/${encodeURIComponent(project.fullPath)}/pipelines/${pipelineId}/jobs?per_page=${PIPELINE_JOB_PAGE_SIZE}`
              : `projects/:id/pipelines/${pipelineId}/jobs?per_page=${PIPELINE_JOB_PAGE_SIZE}`,
            schema: Schema.Array(RawRestJobSchema),
            operation: "getPullRequestWithChecks",
            invalidDetail: "GitLab returned an invalid pipeline jobs payload.",
          }).pipe(
            Effect.map((jobs) => ({
              summary: normalizeRestSummary(mergeRequest),
              checks: jobs.flatMap((job) => {
                const name = job.name?.trim() ?? "";
                return name.length > 0
                  ? [
                      {
                        name,
                        status: normalizePipelineJobStatus(job.status, job.allow_failure),
                        url: job.web_url?.trim() || null,
                      } satisfies GitPullRequestCheck,
                    ]
                  : [];
              }),
            })),
            // A pipeline can disappear between the two calls; the summary is still usable.
            Effect.catch(() =>
              Effect.succeed({
                summary: normalizeRestSummary(mergeRequest),
                checks: [] as ReadonlyArray<GitPullRequestCheck>,
              }),
            ),
          );
        }),
      ),

    getPullRequestReviewComments: (input) =>
      projectArgs(input.repository, "getPullRequestReviewComments").pipe(
        Effect.flatMap(({ host, apiPrefix }) =>
          Effect.gen(function* () {
            const comments: GitPullRequestComment[] = [];
            let truncated = false;

            for (let page = 1; page <= DISCUSSION_PAGE_LIMIT; page += 1) {
              const discussions = yield* runRestJson({
                cwd: input.cwd,
                host,
                endpoint: `${apiPrefix}/merge_requests/${input.number}/discussions?per_page=${DISCUSSION_PAGE_SIZE}&page=${page}`,
                schema: Schema.Array(RawRestDiscussionSchema),
                operation: "getPullRequestReviewComments",
                invalidDetail: "GitLab returned an invalid discussions payload.",
              });

              for (const discussion of discussions) {
                const root = discussion.notes?.[0];
                // Only diff-anchored discussions are resolvable; an unresolved one is the
                // GitLab equivalent of GitHub's unresolved review thread.
                if (!root || root.resolvable !== true || root.resolved === true) continue;
                if (comments.length >= REVIEW_COMMENT_LIMIT) {
                  truncated = true;
                  break;
                }
                comments.push({
                  id: String(root.id),
                  author: root.author?.username ?? null,
                  body: root.body ?? "",
                  path: root.position?.new_path?.trim() || root.position?.old_path?.trim() || null,
                  url: `${gitlabMergeRequestUrl(input.repository, input.number) ?? ""}#note_${root.id}`,
                  createdAt: root.created_at?.trim() || null,
                });
              }

              if (truncated || discussions.length < DISCUSSION_PAGE_SIZE) {
                truncated = truncated || discussions.length === DISCUSSION_PAGE_SIZE;
                break;
              }
              if (page === DISCUSSION_PAGE_LIMIT) {
                truncated = true;
              }
            }

            return { comments, truncated };
          }),
        ),
      ),

    getRepositoryCloneUrls: (input) =>
      projectArgs(input.repository, "getRepositoryCloneUrls").pipe(
        Effect.flatMap(({ host, apiPrefix }) =>
          runRestJson({
            cwd: input.cwd,
            host,
            endpoint: apiPrefix,
            schema: RawRestProjectSchema,
            operation: "getRepositoryCloneUrls",
            invalidDetail: "GitLab returned an invalid project payload.",
          }),
        ),
        Effect.map(
          (project) =>
            ({
              nameWithOwner: project.path_with_namespace,
              url: project.http_url_to_repo,
              sshUrl: project.ssh_url_to_repo,
            }) satisfies GitHostRepositoryCloneUrls,
        ),
      ),

    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "mr",
          "create",
          "--source-branch",
          stripSelectorPrefix(input.headSelector),
          "--target-branch",
          input.baseBranch,
          "--title",
          input.title,
          "--description-file",
          input.bodyFile,
          "--yes",
          "--no-editor",
          ...(input.draft ? ["--draft"] : []),
        ],
        // No prompt can block: every required answer is on the command line.
        stdin: "",
      }).pipe(Effect.asVoid),

    getDefaultBranch: (input) =>
      execute({ cwd: input.cwd, args: ["repo", "view", "-F", "json"] }).pipe(
        Effect.flatMap((result) =>
          decodeJson(
            result.stdout.trim(),
            RawRestProjectSchema,
            "getDefaultBranch",
            "GitLab returned an invalid project payload.",
          ),
        ),
        Effect.map((project) => project.default_branch?.trim() || null),
      ),

    checkoutPullRequest: (input) => {
      const parsed = parseGitLabMergeRequestUrl(input.reference);
      const project = parsed ? parseGitLabRepositoryReference(parsed.reference) : null;
      return execute({
        cwd: input.cwd,
        args: [
          "mr",
          "checkout",
          parsed ? String(parsed.number) : input.reference,
          ...(project ? ["-R", `https://${project.host}/${project.fullPath}`] : []),
          ...(input.force ? ["--force"] : []),
        ],
      }).pipe(Effect.asVoid);
    },
  } satisfies GitLabCliShape;

  // Head selectors may still carry a GitHub-style `owner:`/`remote:` prefix when a workspace's
  // host was misdetected; GitLab only ever accepts the bare branch name.
  function stripSelectorPrefix(headSelector: string): string {
    const separator = headSelector.lastIndexOf(":");
    return separator >= 0 ? headSelector.slice(separator + 1) : headSelector;
  }

  function decodeMergeRequestList(
    raw: string,
  ): Effect.Effect<ReadonlyArray<GitHostPullRequestSummary>, GitHostCliError> {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return Effect.succeed([]);
    }
    return decodeJson(
      trimmed,
      Schema.Array(Schema.Unknown),
      "listPullRequests",
      "GitLab CLI returned invalid MR list JSON.",
    ).pipe(
      Effect.map((entries) =>
        entries.flatMap((entry) => {
          try {
            return [normalizeRestSummary(decodeRestMergeRequest(entry))];
          } catch {
            return [];
          }
        }),
      ),
    );
  }

  function resolveMergeRequest(input: { readonly cwd: string; readonly reference: string }) {
    const parsed = parseGitLabMergeRequestUrl(input.reference);
    const project = parsed ? parseGitLabRepositoryReference(parsed.reference) : null;
    return execute({
      cwd: input.cwd,
      args: [
        "mr",
        "view",
        parsed ? String(parsed.number) : input.reference,
        ...(project ? ["-R", `https://${project.host}/${project.fullPath}`] : []),
        "-F",
        "json",
      ],
    }).pipe(
      Effect.flatMap((result) =>
        decodeJson(
          result.stdout.trim(),
          RawRestMergeRequestSchema,
          "getPullRequest",
          "GitLab returned an invalid merge request payload.",
        ),
      ),
    );
  }

  return service;
});

const decodeRestMergeRequest = Schema.decodeUnknownSync(RawRestMergeRequestSchema);

export const GitLabCliLive = Layer.effect(GitLabCli, makeGitLabCli);
