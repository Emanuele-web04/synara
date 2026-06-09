import { Effect, Layer, Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import { parsePullRequestUrl } from "@t3tools/shared/git";

import { runProcess } from "../../processRunner";
import { GitHubCliError } from "../Errors.ts";
import {
  GitHubCli,
  type GitHubChecksStatus,
  type GitHubCreateReviewResult,
  type GitHubProjectBoardData,
  type GitHubProjectItem,
  type GitHubProjectStatusField,
  type GitHubProjectSummary,
  type GitHubRepositoryCloneUrls,
  type GitHubReviewCheck,
  type GitHubReviewCheckState,
  type GitHubReviewCommit,
  type GitHubReviewer,
  type GitHubReviewerState,
  type GitHubReviewEvent,
  type GitHubReviewPullRequestDetail,
  type GitHubReviewTimelineEvent,
  type GitHubReviewThread,
  type GitHubCliShape,
  type GitHubPullRequestSummary,
  type GitHubReviewPullRequest,
} from "../Services/GitHubCli.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_REVIEW_PULL_REQUEST_LIST_LIMIT = 50;
const DIFF_TIMEOUT_MS = 120_000;
const PROJECT_ITEM_LIMIT = 200;

const PROJECT_SCOPE_MISSING_DETAIL =
  "GitHub CLI token is missing the `read:project` scope. Run `gh auth refresh -s project` and retry.";

function isProjectScopeError(error: GitHubCliError): boolean {
  return error.detail === PROJECT_SCOPE_MISSING_DETAIL;
}

function camelCaseFieldName(name: string): string {
  const words = name
    .trim()
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return "";
  }
  return words
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join("");
}

function normalizeGitHubCliError(operation: "execute" | "stdout", error: unknown): GitHubCliError {
  if (error instanceof Error) {
    if (error.message.includes("Command not found: gh")) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI (`gh`) is required but not available on PATH.",
        cause: error,
      });
    }

    const lower = error.message.toLowerCase();
    if (lower.includes("missing required scopes") || lower.includes("read:project")) {
      return new GitHubCliError({
        operation,
        detail: PROJECT_SCOPE_MISSING_DETAIL,
        cause: error,
      });
    }

    if (
      lower.includes("authentication failed") ||
      lower.includes("not logged in") ||
      lower.includes("gh auth login") ||
      lower.includes("no oauth token")
    ) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
        cause: error,
      });
    }

    if (
      lower.includes("could not resolve to a pullrequest") ||
      lower.includes("repository.pullrequest") ||
      lower.includes("no pull requests found for branch") ||
      lower.includes("pull request not found")
    ) {
      return new GitHubCliError({
        operation,
        detail: "Pull request not found. Check the PR number or URL and try again.",
        cause: error,
      });
    }

    return new GitHubCliError({
      operation,
      detail: `GitHub CLI command failed: ${error.message}`,
      cause: error,
    });
  }

  return new GitHubCliError({
    operation,
    detail: "GitHub CLI command failed.",
    cause: error,
  });
}

function normalizePullRequestState(input: {
  state?: string | null | undefined;
  mergedAt?: string | null | undefined;
}): "open" | "closed" | "merged" {
  const mergedAt = input.mergedAt;
  const state = input.state;
  if ((typeof mergedAt === "string" && mergedAt.trim().length > 0) || state === "MERGED") {
    return "merged";
  }
  if (state === "CLOSED") {
    return "closed";
  }
  return "open";
}

const RawGitHubPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.String,
      }),
    ),
  ),
  headRepositoryOwner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.String,
      }),
    ),
  ),
});

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});

const RawStatusCheckRollupEntrySchema = Schema.Struct({
  __typename: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  workflowName: Schema.optional(Schema.NullOr(Schema.String)),
  detailsUrl: Schema.optional(Schema.NullOr(Schema.String)),
  targetUrl: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  startedAt: Schema.optional(Schema.NullOr(Schema.String)),
  completedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewRequestSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  slug: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewAuthorSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawGitHubReviewPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  url: Schema.String,
  baseRefName: Schema.String,
  headRefName: Schema.String,
  author: Schema.optional(Schema.NullOr(RawReviewAuthorSchema)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.Boolean),
  additions: Schema.optional(Schema.NullOr(Schema.Number)),
  deletions: Schema.optional(Schema.NullOr(Schema.Number)),
  statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Array(RawStatusCheckRollupEntrySchema))),
  reviewRequests: Schema.optional(Schema.NullOr(Schema.Array(RawReviewRequestSchema))),
});

const FAILING_CHECK_STATES = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

const PENDING_CHECK_STATES = new Set(["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED", "WAITING"]);

const SUCCESS_CHECK_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function rollupChecksStatus(
  entries: ReadonlyArray<Schema.Schema.Type<typeof RawStatusCheckRollupEntrySchema>>,
): GitHubChecksStatus {
  if (entries.length === 0) {
    return "none";
  }
  let pending = false;
  let success = false;
  for (const entry of entries) {
    const value = (entry.conclusion ?? entry.state ?? "").trim().toUpperCase();
    if (value.length === 0) {
      continue;
    }
    if (FAILING_CHECK_STATES.has(value)) {
      return "failing";
    }
    if (PENDING_CHECK_STATES.has(value)) {
      pending = true;
    } else if (SUCCESS_CHECK_STATES.has(value)) {
      success = true;
    }
  }
  if (pending) {
    return "pending";
  }
  if (success) {
    return "passing";
  }
  return "none";
}

function normalizeReviewRequests(
  requests: ReadonlyArray<Schema.Schema.Type<typeof RawReviewRequestSchema>>,
): ReadonlyArray<string> {
  return requests
    .map((request) => (request.login ?? request.name ?? request.slug ?? "").trim())
    .filter((value) => value.length > 0);
}

function nonNegativeInt(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizeAvatarUrl(value: string | null | undefined): string | undefined {
  const avatarUrl = (value ?? "").trim();
  return avatarUrl.length > 0 ? avatarUrl : undefined;
}

function normalizeReviewUserRef(
  raw:
    | Schema.Schema.Type<typeof RawReviewUserSchema>
    | Schema.Schema.Type<typeof RawReviewAuthorSchema>,
): { readonly login: string; readonly avatarUrl?: string } | null {
  const login = (raw.login ?? raw.name ?? "").trim();
  if (login.length === 0) {
    return null;
  }
  const avatarUrl = normalizeAvatarUrl(raw.avatarUrl);
  return { login, ...(avatarUrl ? { avatarUrl } : {}) };
}

function normalizeReviewPullRequest(
  raw: Schema.Schema.Type<typeof RawGitHubReviewPullRequestSchema>,
): GitHubReviewPullRequest {
  const author = raw.author?.login?.trim() ?? "";
  const authorAvatarUrl = normalizeAvatarUrl(raw.author?.avatarUrl);
  const reviewDecision = raw.reviewDecision?.trim() ?? "";
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    author,
    ...(authorAvatarUrl ? { authorAvatarUrl } : {}),
    updatedAt: raw.updatedAt ?? "",
    state: normalizePullRequestState(raw),
    reviewDecision: reviewDecision.length > 0 ? reviewDecision : null,
    isDraft: raw.isDraft ?? false,
    additions: nonNegativeInt(raw.additions),
    deletions: nonNegativeInt(raw.deletions),
    checksStatus: rollupChecksStatus(raw.statusCheckRollup ?? []),
    reviewRequests: normalizeReviewRequests(raw.reviewRequests ?? []),
  };
}

const RawReviewCommitAuthorSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewCommitSchema = Schema.Struct({
  oid: Schema.String,
  messageHeadline: Schema.optional(Schema.NullOr(Schema.String)),
  messageBody: Schema.optional(Schema.NullOr(Schema.String)),
  authoredDate: Schema.optional(Schema.NullOr(Schema.String)),
  committedDate: Schema.optional(Schema.NullOr(Schema.String)),
  authors: Schema.optional(Schema.NullOr(Schema.Array(RawReviewCommitAuthorSchema))),
});

const RawReviewLabelSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewUserSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewLatestReviewSchema = Schema.Struct({
  author: Schema.optional(Schema.NullOr(RawReviewAuthorSchema)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewMilestoneSchema = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawGitHubReviewDetailSchema = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  url: Schema.String,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.Boolean),
  author: Schema.optional(Schema.NullOr(RawReviewAuthorSchema)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  baseRefName: Schema.String,
  headRefName: Schema.String,
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  additions: Schema.optional(Schema.NullOr(Schema.Number)),
  deletions: Schema.optional(Schema.NullOr(Schema.Number)),
  changedFiles: Schema.optional(Schema.NullOr(Schema.Number)),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
  milestone: Schema.optional(Schema.NullOr(RawReviewMilestoneSchema)),
  labels: Schema.optional(Schema.NullOr(Schema.Array(RawReviewLabelSchema))),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(RawReviewUserSchema))),
  reviewRequests: Schema.optional(Schema.NullOr(Schema.Array(RawReviewRequestSchema))),
  latestReviews: Schema.optional(Schema.NullOr(Schema.Array(RawReviewLatestReviewSchema))),
  commits: Schema.optional(Schema.NullOr(Schema.Array(RawReviewCommitSchema))),
  statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Array(RawStatusCheckRollupEntrySchema))),
});

function mapReviewCheckState(
  entry: Schema.Schema.Type<typeof RawStatusCheckRollupEntrySchema>,
): GitHubReviewCheckState {
  const status = (entry.status ?? "").trim().toUpperCase();
  // CheckRun reports status (QUEUED/IN_PROGRESS/COMPLETED) + conclusion; a
  // non-completed run is still pending regardless of any conclusion field.
  if (status.length > 0 && status !== "COMPLETED") {
    return "pending";
  }
  const value =
    (entry.conclusion ?? "").trim().toUpperCase() || (entry.state ?? "").trim().toUpperCase();
  switch (value) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
    case "ACTION_REQUIRED":
      return "failure";
    case "CANCELLED":
      return "cancelled";
    case "SKIPPED":
      return "skipped";
    case "NEUTRAL":
      return "neutral";
    default:
      return "pending";
  }
}

function normalizeReviewChecks(
  entries: ReadonlyArray<Schema.Schema.Type<typeof RawStatusCheckRollupEntrySchema>>,
): ReadonlyArray<GitHubReviewCheck> {
  const checks: GitHubReviewCheck[] = [];
  for (const entry of entries) {
    const name = (entry.name ?? entry.context ?? "").trim();
    if (name.length === 0) {
      continue;
    }
    const url = (entry.detailsUrl ?? entry.targetUrl ?? "").trim();
    const workflow = (entry.workflowName ?? "").trim();
    const description = (entry.description ?? "").trim();
    const startedAt = (entry.startedAt ?? "").trim();
    const completedAt = (entry.completedAt ?? "").trim();
    checks.push({
      name,
      state: mapReviewCheckState(entry),
      ...(workflow.length > 0 ? { workflow } : {}),
      ...(description.length > 0 ? { description } : {}),
      ...(url.length > 0 ? { url } : {}),
      ...(startedAt.length > 0 ? { startedAt } : {}),
      ...(completedAt.length > 0 ? { completedAt } : {}),
    });
  }
  return checks;
}

function normalizeReviewCommit(
  raw: Schema.Schema.Type<typeof RawReviewCommitSchema>,
): GitHubReviewCommit {
  const author =
    (raw.authors ?? [])
      .map((entry) => (entry.login ?? entry.name ?? "").trim())
      .find((value) => value.length > 0) ?? "";
  const messageBody = (raw.messageBody ?? "").trim();
  return {
    oid: raw.oid,
    abbreviatedOid: raw.oid.slice(0, 7),
    messageHeadline: raw.messageHeadline ?? "",
    ...(messageBody.length > 0 ? { messageBody } : {}),
    author,
    authoredDate: raw.authoredDate ?? raw.committedDate ?? "",
  };
}

function normalizeReviewerState(value: string): GitHubReviewerState {
  switch (value.trim().toUpperCase()) {
    case "APPROVED":
      return "APPROVED";
    case "CHANGES_REQUESTED":
      return "CHANGES_REQUESTED";
    case "COMMENTED":
      return "COMMENTED";
    case "DISMISSED":
      return "DISMISSED";
    case "PENDING":
      return "PENDING";
    default:
      return "REVIEW_REQUIRED";
  }
}

function normalizeReviewers(
  latestReviews: ReadonlyArray<Schema.Schema.Type<typeof RawReviewLatestReviewSchema>>,
  reviewRequests: ReadonlyArray<Schema.Schema.Type<typeof RawReviewRequestSchema>>,
): ReadonlyArray<GitHubReviewer> {
  const byLogin = new Map<string, GitHubReviewer>();
  for (const review of latestReviews) {
    const login = (review.author?.login ?? "").trim();
    if (login.length === 0) {
      continue;
    }
    const avatarUrl = normalizeAvatarUrl(review.author?.avatarUrl);
    byLogin.set(login, {
      login,
      state: normalizeReviewerState(review.state ?? ""),
      ...(avatarUrl ? { avatarUrl } : {}),
    });
  }
  for (const request of reviewRequests) {
    const login = (request.login ?? request.name ?? request.slug ?? "").trim();
    if (login.length === 0 || byLogin.has(login)) {
      continue;
    }
    const avatarUrl = normalizeAvatarUrl(request.avatarUrl);
    byLogin.set(login, { login, state: "REVIEW_REQUIRED", ...(avatarUrl ? { avatarUrl } : {}) });
  }
  return [...byLogin.values()];
}

function normalizeReviewMergeable(
  value: string | null | undefined,
): "MERGEABLE" | "CONFLICTING" | "UNKNOWN" {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized === "MERGEABLE" || normalized === "CONFLICTING" ? normalized : "UNKNOWN";
}

function normalizeReviewDetail(
  raw: Schema.Schema.Type<typeof RawGitHubReviewDetailSchema>,
): GitHubReviewPullRequestDetail {
  const reviewDecision = (raw.reviewDecision ?? "").trim();
  const milestone = (raw.milestone?.title ?? "").trim();
  const mergeStateStatus = (raw.mergeStateStatus ?? "").trim();
  const authorAvatarUrl = normalizeAvatarUrl(raw.author?.avatarUrl);
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: normalizePullRequestState({ state: raw.state, mergedAt: raw.mergedAt }),
    isDraft: raw.isDraft ?? false,
    author: (raw.author?.login ?? "").trim(),
    ...(authorAvatarUrl ? { authorAvatarUrl } : {}),
    baseBranch: raw.baseRefName,
    headBranch: raw.headRefName,
    body: raw.body ?? "",
    createdAt: raw.createdAt ?? "",
    updatedAt: raw.updatedAt ?? "",
    additions: nonNegativeInt(raw.additions),
    deletions: nonNegativeInt(raw.deletions),
    changedFiles: nonNegativeInt(raw.changedFiles),
    commitsCount: (raw.commits ?? []).length,
    reviewDecision: reviewDecision.length > 0 ? reviewDecision : null,
    mergeable: normalizeReviewMergeable(raw.mergeable),
    ...(mergeStateStatus.length > 0 ? { mergeStateStatus } : {}),
    checksStatus: rollupChecksStatus(raw.statusCheckRollup ?? []),
    milestone: milestone.length > 0 ? milestone : null,
    labels: (raw.labels ?? [])
      .map((label) => ({ name: (label.name ?? "").trim(), color: (label.color ?? "").trim() }))
      .filter((label) => label.name.length > 0),
    assignees: (raw.assignees ?? [])
      .map(normalizeReviewUserRef)
      .filter((user): user is NonNullable<typeof user> => user !== null),
    reviewers: normalizeReviewers(raw.latestReviews ?? [], raw.reviewRequests ?? []),
  };
}

const RawConversationCommentSchema = Schema.Struct({
  author: Schema.optional(Schema.NullOr(RawReviewAuthorSchema)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawConversationReviewSchema = Schema.Struct({
  author: Schema.optional(Schema.NullOr(RawReviewAuthorSchema)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  submittedAt: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawGitHubConversationSchema = Schema.Struct({
  comments: Schema.optional(Schema.NullOr(Schema.Array(RawConversationCommentSchema))),
  reviews: Schema.optional(Schema.NullOr(Schema.Array(RawConversationReviewSchema))),
  commits: Schema.optional(Schema.NullOr(Schema.Array(RawReviewCommitSchema))),
});

function normalizeConversation(
  raw: Schema.Schema.Type<typeof RawGitHubConversationSchema>,
): ReadonlyArray<GitHubReviewTimelineEvent> {
  const events: GitHubReviewTimelineEvent[] = [];
  (raw.comments ?? []).forEach((comment, index) => {
    const url = (comment.url ?? "").trim();
    const authorAvatarUrl = normalizeAvatarUrl(comment.author?.avatarUrl);
    events.push({
      kind: "comment",
      id: `comment-${index}`,
      author: (comment.author?.login ?? "").trim(),
      ...(authorAvatarUrl ? { authorAvatarUrl } : {}),
      body: comment.body ?? "",
      createdAt: comment.createdAt ?? "",
      ...(url.length > 0 ? { url } : {}),
    });
  });
  (raw.reviews ?? []).forEach((review, index) => {
    const state = normalizeReviewerState(review.state ?? "");
    const body = (review.body ?? "").trim();
    // Drop empty drive-by reviews (no body, just COMMENTED/PENDING) to cut noise.
    if (body.length === 0 && (state === "COMMENTED" || state === "PENDING")) {
      return;
    }
    const url = (review.url ?? "").trim();
    const authorAvatarUrl = normalizeAvatarUrl(review.author?.avatarUrl);
    events.push({
      kind: "review",
      id: `review-${index}`,
      author: (review.author?.login ?? "").trim(),
      ...(authorAvatarUrl ? { authorAvatarUrl } : {}),
      state,
      body: review.body ?? "",
      createdAt: review.submittedAt ?? "",
      ...(url.length > 0 ? { url } : {}),
    });
  });
  for (const commit of raw.commits ?? []) {
    const author =
      (commit.authors ?? [])
        .map((entry) => (entry.login ?? entry.name ?? "").trim())
        .find((value) => value.length > 0) ?? "";
    events.push({
      kind: "commit",
      oid: commit.oid,
      abbreviatedOid: commit.oid.slice(0, 7),
      messageHeadline: commit.messageHeadline ?? "",
      author,
      createdAt: commit.authoredDate ?? commit.committedDate ?? "",
    });
  }
  return events.toSorted((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
}

function lookupUserAvatar(
  execute: GitHubCliShape["execute"],
  cwd: string,
  login: string,
): Effect.Effect<readonly [string, string | undefined], never> {
  return execute({
    cwd,
    args: ["api", `users/${encodeURIComponent(login)}`, "--jq", ".avatar_url"],
  }).pipe(
    Effect.map((result) => [login, normalizeAvatarUrl(result.stdout)] as const),
    Effect.catch(() => Effect.succeed([login, undefined] as const)),
  );
}

function enrichConversationAvatars(
  execute: GitHubCliShape["execute"],
  cwd: string,
  events: ReadonlyArray<GitHubReviewTimelineEvent>,
): Effect.Effect<ReadonlyArray<GitHubReviewTimelineEvent>, never> {
  const missingLogins = [
    ...new Set(
      events
        .filter(
          (event) =>
            (event.kind === "comment" || event.kind === "review") &&
            event.author.trim().length > 0 &&
            event.authorAvatarUrl === undefined,
        )
        .map((event) => event.author.trim()),
    ),
  ];

  if (missingLogins.length === 0) {
    return Effect.succeed(events);
  }

  return Effect.forEach(missingLogins, (login) => lookupUserAvatar(execute, cwd, login), {
    concurrency: 6,
  }).pipe(
    Effect.map((entries) => {
      const avatarsByLogin = new Map(entries);
      return events.map((event) => {
        if (event.kind !== "comment" && event.kind !== "review") {
          return event;
        }
        if (event.authorAvatarUrl !== undefined) {
          return event;
        }
        const authorAvatarUrl = avatarsByLogin.get(event.author.trim());
        return authorAvatarUrl ? { ...event, authorAvatarUrl } : event;
      });
    }),
  );
}

function normalizePullRequestSummary(
  raw: Schema.Schema.Type<typeof RawGitHubPullRequestSchema>,
): GitHubPullRequestSummary {
  const headRepositoryNameWithOwner = raw.headRepository?.nameWithOwner ?? null;
  const headRepositoryOwnerLogin =
    raw.headRepositoryOwner?.login ??
    (typeof headRepositoryNameWithOwner === "string" && headRepositoryNameWithOwner.includes("/")
      ? (headRepositoryNameWithOwner.split("/")[0] ?? null)
      : null);
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    state: normalizePullRequestState(raw),
    ...(typeof raw.isCrossRepository === "boolean"
      ? { isCrossRepository: raw.isCrossRepository }
      : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

const RawCreateReviewResponseSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Number)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
});

const GRAPHQL_REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $threadsCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $threadsCursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          path
          line
          diffSide
          comments(first: 100) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              author { login avatarUrl }
              body
              createdAt
              url
            }
          }
        }
      }
    }
  }
}`;

const GRAPHQL_REVIEW_THREAD_COMMENTS_QUERY = `query($threadId: ID!, $commentsCursor: String) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $commentsCursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          author { login avatarUrl }
          body
          createdAt
          url
        }
      }
    }
  }
}`;

const RawPageInfoSchema = Schema.Struct({
  hasNextPage: Schema.optional(Schema.NullOr(Schema.Boolean)),
  endCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewThreadCommentSchema = Schema.Struct({
  author: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.optional(Schema.String),
        avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewThreadSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  isResolved: Schema.optional(Schema.NullOr(Schema.Boolean)),
  path: Schema.optional(Schema.NullOr(Schema.String)),
  line: Schema.optional(Schema.NullOr(Schema.Number)),
  diffSide: Schema.optional(Schema.NullOr(Schema.String)),
  comments: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        pageInfo: Schema.optional(Schema.NullOr(RawPageInfoSchema)),
        nodes: Schema.Array(RawReviewThreadCommentSchema),
      }),
    ),
  ),
});

const RawReviewThreadsResponseSchema = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              pullRequest: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    reviewThreads: Schema.Struct({
                      pageInfo: Schema.optional(Schema.NullOr(RawPageInfoSchema)),
                      nodes: Schema.Array(RawReviewThreadSchema),
                    }),
                  }),
                ),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
});

const RawReviewThreadCommentsResponseSchema = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        node: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              comments: Schema.Struct({
                pageInfo: Schema.optional(Schema.NullOr(RawPageInfoSchema)),
                nodes: Schema.Array(RawReviewThreadCommentSchema),
              }),
            }),
          ),
        ),
      }),
    ),
  ),
});

function normalizeReviewSide(value: string | null | undefined): "LEFT" | "RIGHT" | undefined {
  return value === "LEFT" || value === "RIGHT" ? value : undefined;
}

function normalizeReviewThreadComment(
  comment: Schema.Schema.Type<typeof RawReviewThreadCommentSchema>,
): GitHubReviewThread["comments"][number] {
  const authorAvatarUrl = normalizeAvatarUrl(comment.author?.avatarUrl);
  const normalized = {
    author: comment.author?.login ?? "",
    body: comment.body ?? "",
    createdAt: comment.createdAt ?? "",
  };
  if (authorAvatarUrl) {
    Object.assign(normalized, { authorAvatarUrl });
  }
  if (comment.url) {
    Object.assign(normalized, { url: comment.url });
  }
  return normalized;
}

function normalizeReviewThreadNode(input: {
  readonly node: Schema.Schema.Type<typeof RawReviewThreadSchema>;
  readonly pullRequestNumber: number;
  readonly nodeIndex: number;
  readonly comments: ReadonlyArray<Schema.Schema.Type<typeof RawReviewThreadCommentSchema>>;
}): GitHubReviewThread {
  const { node, pullRequestNumber, nodeIndex } = input;
  const comments = input.comments.map(normalizeReviewThreadComment);
  const path = node.path?.trim() ?? "";
  const side = normalizeReviewSide(node.diffSide);
  const normalized = {
    id: node.id ?? `thread-${String(pullRequestNumber)}-${String(nodeIndex)}`,
    isResolved: node.isResolved ?? false,
    comments,
  };
  if (path.length > 0) {
    Object.assign(normalized, { path });
  }
  if (typeof node.line === "number" && node.line > 0) {
    Object.assign(normalized, { line: node.line });
  }
  if (side) {
    Object.assign(normalized, { side });
  }
  return normalized;
}

function reviewEventName(event: GitHubReviewEvent): "APPROVE" | "REQUEST_CHANGES" | "COMMENT" {
  if (event === "approve") {
    return "APPROVE";
  }
  if (event === "request_changes") {
    return "REQUEST_CHANGES";
  }
  return "COMMENT";
}

function reviewEventFlag(event: GitHubReviewEvent): string {
  if (event === "approve") {
    return "--approve";
  }
  if (event === "request_changes") {
    return "--request-changes";
  }
  return "--comment";
}

const RawProjectSummarySchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  title: Schema.String,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  owner: Schema.optional(
    Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

const RawProjectListSchema = Schema.Struct({
  projects: Schema.optional(Schema.NullOr(Schema.Array(RawProjectSummarySchema))),
});

const RawProjectFieldSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  type: Schema.optional(Schema.NullOr(Schema.String)),
  options: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString, name: Schema.String }))),
  ),
});

const RawProjectFieldListSchema = Schema.Struct({
  fields: Schema.optional(Schema.NullOr(Schema.Array(RawProjectFieldSchema))),
});

const RawProjectItemListSchema = Schema.Struct({
  items: Schema.optional(Schema.NullOr(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))),
});

const RawProjectItemContentSchema = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  number: Schema.optional(Schema.NullOr(Schema.Number)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  repository: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) }))),
  assignees: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ login: Schema.optional(Schema.String) }))),
  ),
});

function normalizeProjectSummary(
  raw: Schema.Schema.Type<typeof RawProjectSummarySchema>,
): GitHubProjectSummary {
  const url = raw.url?.trim() ?? "";
  return {
    id: raw.id,
    number: raw.number,
    title: raw.title,
    ownerLogin: raw.owner?.login?.trim() ?? "",
    ...(url.length > 0 ? { url } : {}),
  };
}

function findStatusField(
  fields: ReadonlyArray<Schema.Schema.Type<typeof RawProjectFieldSchema>>,
): GitHubProjectStatusField | null {
  const statusField = fields.find(
    (field) =>
      field.name.trim().toLowerCase() === "status" &&
      (field.options?.length ?? 0) > 0 &&
      (field.type ?? "").includes("SingleSelect"),
  );
  if (!statusField) {
    return null;
  }
  return {
    id: statusField.id,
    name: statusField.name,
    options: (statusField.options ?? []).map((option) => ({ id: option.id, name: option.name })),
  };
}

function normalizeProjectItem(
  raw: Record<string, unknown>,
  statusFieldName: string | null,
): GitHubProjectItem | null {
  const itemId = typeof raw["id"] === "string" ? raw["id"].trim() : "";
  if (itemId.length === 0) {
    return null;
  }
  const contentResult = Schema.decodeUnknownExit(Schema.NullOr(RawProjectItemContentSchema))(
    raw["content"] ?? null,
  );
  const content = contentResult._tag === "Success" ? contentResult.value : null;
  const statusKey = statusFieldName ? camelCaseFieldName(statusFieldName) : "";
  const statusRaw = statusKey.length > 0 ? raw[statusKey] : undefined;
  const statusName =
    typeof statusRaw === "string" && statusRaw.trim().length > 0 ? statusRaw : null;
  const contentNumber = content?.number;
  const author =
    content?.author?.login?.trim() ??
    content?.assignees
      ?.find((assignee) => (assignee.login ?? "").trim().length > 0)
      ?.login?.trim() ??
    "";
  const repository = content?.repository?.trim() ?? "";
  const url = content?.url?.trim() ?? "";
  return {
    itemId,
    statusName,
    contentType: content?.type ?? "",
    number:
      typeof contentNumber === "number" && Number.isFinite(contentNumber) && contentNumber > 0
        ? Math.trunc(contentNumber)
        : null,
    title: content?.title?.trim() ?? (typeof raw["title"] === "string" ? raw["title"] : ""),
    author,
    ...(url.length > 0 ? { url } : {}),
    ...(repository.length > 0 ? { repositoryNameWithOwner: repository } : {}),
  };
}

function decodeGitHubJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation:
    | "listOpenPullRequests"
    | "getPullRequest"
    | "getRepositoryCloneUrls"
    | "listRepositoryPullRequests"
    | "getReviewPullRequestOverview"
    | "getReviewConversation"
    | "createPullRequestReviewWithComments"
    | "getPullRequestThreads"
    | "listProjects"
    | "getProjectBoard",
  invalidDetail: string,
): Effect.Effect<S["Type"], GitHubCliError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (error) =>
        new GitHubCliError({
          operation,
          detail: error instanceof Error ? `${invalidDetail}: ${error.message}` : invalidDetail,
          cause: error,
        }),
    ),
  );
}

interface PullRequestCoordinates {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

function optionalCursorArg(name: string, value: string | null): ReadonlyArray<string> {
  return value !== null && value.length > 0 ? ["-F", `${name}=${value}`] : [];
}

function pageInfoHasNext(
  pageInfo: Schema.Schema.Type<typeof RawPageInfoSchema> | null | undefined,
): boolean {
  return pageInfo?.hasNextPage === true;
}

function pageInfoEndCursor(
  pageInfo: Schema.Schema.Type<typeof RawPageInfoSchema> | null | undefined,
): string | null {
  const cursor = pageInfo?.endCursor?.trim() ?? "";
  return cursor.length > 0 ? cursor : null;
}

function fetchReviewThreadsPage(
  execute: GitHubCliShape["execute"],
  input: {
    readonly cwd: string;
    readonly pullRequest: PullRequestCoordinates;
    readonly threadsCursor: string | null;
  },
): Effect.Effect<Schema.Schema.Type<typeof RawReviewThreadsResponseSchema>, GitHubCliError> {
  return execute({
    cwd: input.cwd,
    args: [
      "api",
      "graphql",
      "-F",
      `owner=${input.pullRequest.owner}`,
      "-F",
      `repo=${input.pullRequest.repo}`,
      "-F",
      `number=${String(input.pullRequest.number)}`,
      ...optionalCursorArg("threadsCursor", input.threadsCursor),
      "-f",
      `query=${GRAPHQL_REVIEW_THREADS_QUERY}`,
    ],
  }).pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.flatMap((raw) =>
      decodeGitHubJson(
        raw,
        RawReviewThreadsResponseSchema,
        "getPullRequestThreads",
        "GitHub API returned invalid review thread JSON.",
      ),
    ),
  );
}

function fetchReviewThreadCommentsPage(
  execute: GitHubCliShape["execute"],
  input: {
    readonly cwd: string;
    readonly threadId: string;
    readonly commentsCursor: string | null;
  },
): Effect.Effect<Schema.Schema.Type<typeof RawReviewThreadCommentsResponseSchema>, GitHubCliError> {
  return execute({
    cwd: input.cwd,
    args: [
      "api",
      "graphql",
      "-F",
      `threadId=${input.threadId}`,
      ...optionalCursorArg("commentsCursor", input.commentsCursor),
      "-f",
      `query=${GRAPHQL_REVIEW_THREAD_COMMENTS_QUERY}`,
    ],
  }).pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.flatMap((raw) =>
      decodeGitHubJson(
        raw,
        RawReviewThreadCommentsResponseSchema,
        "getPullRequestThreads",
        "GitHub API returned invalid review thread comment JSON.",
      ),
    ),
  );
}

function fetchRemainingReviewThreadComments(
  execute: GitHubCliShape["execute"],
  input: {
    readonly cwd: string;
    readonly threadId: string;
    readonly initialComments: ReadonlyArray<
      Schema.Schema.Type<typeof RawReviewThreadCommentSchema>
    >;
    readonly initialPageInfo: Schema.Schema.Type<typeof RawPageInfoSchema> | null | undefined;
  },
): Effect.Effect<
  ReadonlyArray<Schema.Schema.Type<typeof RawReviewThreadCommentSchema>>,
  GitHubCliError
> {
  return Effect.gen(function* () {
    const comments = [...input.initialComments];
    let cursor = pageInfoEndCursor(input.initialPageInfo);
    let hasNextPage = pageInfoHasNext(input.initialPageInfo);

    while (hasNextPage) {
      const page = yield* fetchReviewThreadCommentsPage(execute, {
        cwd: input.cwd,
        threadId: input.threadId,
        commentsCursor: cursor,
      });
      const connection = page.data?.node?.comments;
      comments.push(...(connection?.nodes ?? []));
      cursor = pageInfoEndCursor(connection?.pageInfo);
      hasNextPage = pageInfoHasNext(connection?.pageInfo) && cursor !== null;
    }

    return comments;
  });
}

function fetchPullRequestReviewThreads(
  execute: GitHubCliShape["execute"],
  input: {
    readonly cwd: string;
    readonly pullRequest: PullRequestCoordinates;
  },
): Effect.Effect<ReadonlyArray<GitHubReviewThread>, GitHubCliError> {
  return Effect.gen(function* () {
    const threads: GitHubReviewThread[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;
    let nodeOffset = 0;

    while (hasNextPage) {
      const page = yield* fetchReviewThreadsPage(execute, {
        cwd: input.cwd,
        pullRequest: input.pullRequest,
        threadsCursor: cursor,
      });
      const connection = page.data?.repository?.pullRequest?.reviewThreads;
      const nodes = connection?.nodes ?? [];
      for (const [nodeIndex, node] of nodes.entries()) {
        const threadId = node.id?.trim() ?? "";
        if (pageInfoHasNext(node.comments?.pageInfo) && threadId.length === 0) {
          yield* Effect.fail(
            new GitHubCliError({
              operation: "getPullRequestThreads",
              detail: "GitHub API omitted a paginated review thread id.",
            }),
          );
        }
        const comments = yield* fetchRemainingReviewThreadComments(execute, {
          cwd: input.cwd,
          threadId:
            threadId.length > 0
              ? threadId
              : `thread-${String(input.pullRequest.number)}-${String(nodeOffset + nodeIndex)}`,
          initialComments: node.comments?.nodes ?? [],
          initialPageInfo: node.comments?.pageInfo,
        });
        threads.push(
          normalizeReviewThreadNode({
            node,
            pullRequestNumber: input.pullRequest.number,
            nodeIndex: nodeOffset + nodeIndex,
            comments,
          }),
        );
      }
      nodeOffset += nodes.length;
      cursor = pageInfoEndCursor(connection?.pageInfo);
      hasNextPage = pageInfoHasNext(connection?.pageInfo) && cursor !== null;
    }

    return threads;
  });
}

const makeGitHubCli = Effect.sync(() => {
  const execute: GitHubCliShape["execute"] = (input) =>
    Effect.tryPromise({
      try: () =>
        runProcess("gh", input.args, {
          cwd: input.cwd,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        }),
      catch: (error) => normalizeGitHubCliError("execute", error),
    });

  const service = {
    execute,
    listOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--head",
          input.headSelector,
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 1),
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : decodeGitHubJson(
                raw,
                Schema.Array(RawGitHubPullRequestSchema),
                "listOpenPullRequests",
                "GitHub CLI returned invalid PR list JSON.",
              ),
        ),
        Effect.map((pullRequests) => pullRequests.map(normalizePullRequestSummary)),
      ),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubPullRequestSchema,
            "getPullRequest",
            "GitHub CLI returned invalid pull request JSON.",
          ),
        ),
        Effect.map(normalizePullRequestSummary),
      ),
    listRepositoryPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--state",
          input.state,
          "--limit",
          String(input.limit ?? DEFAULT_REVIEW_PULL_REQUEST_LIST_LIMIT),
          "--json",
          "number,title,author,updatedAt,state,mergedAt,reviewDecision,baseRefName,headRefName,url,isDraft,additions,deletions",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : decodeGitHubJson(
                raw,
                Schema.Array(RawGitHubReviewPullRequestSchema),
                "listRepositoryPullRequests",
                "GitHub CLI returned invalid PR list JSON.",
              ),
        ),
        Effect.map((pullRequests) => pullRequests.map(normalizeReviewPullRequest)),
      ),
    getReviewPullRequestOverview: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          "number,title,url,state,isDraft,author,body,baseRefName,headRefName,createdAt,updatedAt,mergedAt,additions,deletions,changedFiles,reviewDecision,mergeable,mergeStateStatus,milestone,labels,assignees,reviewRequests,latestReviews,commits,statusCheckRollup",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubReviewDetailSchema,
            "getReviewPullRequestOverview",
            "GitHub CLI returned invalid pull request detail JSON.",
          ),
        ),
        Effect.map((raw) => ({
          detail: normalizeReviewDetail(raw),
          commits: (raw.commits ?? []).map(normalizeReviewCommit),
          checks: normalizeReviewChecks(raw.statusCheckRollup ?? []),
        })),
      ),
    getReviewConversation: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "view", input.reference, "--json", "comments,reviews,commits"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubConversationSchema,
            "getReviewConversation",
            "GitHub CLI returned invalid conversation JSON.",
          ),
        ),
        Effect.map(normalizeConversation),
        Effect.flatMap((events) => enrichConversationAvatars(execute, input.cwd, events)),
      ),
    getAuthenticatedUser: (input) =>
      execute({
        cwd: input.cwd,
        args: ["api", "user", "--jq", "{login:.login,avatarUrl:.avatar_url}"],
      }).pipe(
        Effect.map((result) => {
          const parsed = JSON.parse(result.stdout) as {
            login?: unknown;
            avatarUrl?: unknown;
          };
          const login = typeof parsed.login === "string" ? parsed.login.trim() : "";
          const avatarUrl =
            typeof parsed.avatarUrl === "string" ? normalizeAvatarUrl(parsed.avatarUrl) : undefined;
          return { login, ...(avatarUrl ? { avatarUrl } : {}) };
        }),
      ),
    getPullRequestDiff: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "diff", input.reference],
        timeoutMs: DIFF_TIMEOUT_MS,
      }).pipe(Effect.map((result) => result.stdout)),
    getPullRequestHeadSha: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "view", input.reference, "--json", "headRefOid", "-q", ".headRefOid"],
      }).pipe(Effect.map((result) => result.stdout.trim())),
    submitPullRequestReview: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "review",
          input.reference,
          reviewEventFlag(input.event),
          ...(input.body !== undefined ? ["--body", input.body] : []),
        ],
      }).pipe(Effect.asVoid),
    createPullRequestReviewWithComments: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "api",
          "--method",
          "POST",
          `repos/${input.owner}/${input.repo}/pulls/${String(input.number)}/reviews`,
          "--input",
          "-",
        ],
        stdin: JSON.stringify({
          event: reviewEventName(input.event),
          commit_id: input.commitId,
          ...(input.body !== undefined ? { body: input.body } : {}),
          comments: input.comments.map((comment) => ({
            path: comment.path,
            line: comment.line,
            side: comment.side,
            body: comment.body,
          })),
        }),
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed({} as Schema.Schema.Type<typeof RawCreateReviewResponseSchema>)
            : decodeGitHubJson(
                raw,
                RawCreateReviewResponseSchema,
                "createPullRequestReviewWithComments",
                "GitHub API returned invalid review JSON.",
              ),
        ),
        Effect.map(
          (response): GitHubCreateReviewResult => ({
            ...(typeof response.id === "number" && response.id > 0
              ? { reviewId: response.id }
              : {}),
            ...(response.html_url && response.html_url.length > 0
              ? { url: response.html_url }
              : {}),
          }),
        ),
      ),
    getPullRequestThreads: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "view", input.reference, "--json", "url", "-q", ".url"],
      }).pipe(
        Effect.map((result) => parsePullRequestUrl(result.stdout.trim())),
        Effect.flatMap((parsed) =>
          parsed === null
            ? Effect.succeed([] as ReadonlyArray<GitHubReviewThread>)
            : fetchPullRequestReviewThreads(execute, {
                cwd: input.cwd,
                pullRequest: parsed,
              }),
        ),
      ),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubRepositoryCloneUrlsSchema,
            "getRepositoryCloneUrls",
            "GitHub CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headSelector,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
    projectScopeAvailable: (input) =>
      execute({
        cwd: input.cwd,
        args: ["project", "list", "--owner", "@me", "--limit", "1", "--format", "json"],
      }).pipe(
        Effect.as(true),
        Effect.catchTag("GitHubCliError", (error) =>
          isProjectScopeError(error) ? Effect.succeed(false) : Effect.fail(error),
        ),
      ),
    listProjects: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "project",
          "list",
          "--owner",
          input.owner ?? "@me",
          "--limit",
          "100",
          "--format",
          "json",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed({ projects: [] })
            : decodeGitHubJson(
                raw,
                RawProjectListSchema,
                "listProjects",
                "GitHub CLI returned invalid project list JSON.",
              ),
        ),
        Effect.map((decoded) => (decoded.projects ?? []).map(normalizeProjectSummary)),
      ),
    getProjectBoard: (input) =>
      Effect.gen(function* () {
        const summaries = yield* execute({
          cwd: input.cwd,
          args: ["project", "list", "--owner", input.owner, "--limit", "100", "--format", "json"],
        }).pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.flatMap((raw) =>
            raw.length === 0
              ? Effect.succeed({ projects: [] })
              : decodeGitHubJson(
                  raw,
                  RawProjectListSchema,
                  "getProjectBoard",
                  "GitHub CLI returned invalid project list JSON.",
                ),
          ),
          Effect.map((decoded) => (decoded.projects ?? []).map(normalizeProjectSummary)),
        );
        const project =
          summaries.find((summary) => summary.number === input.number) ??
          ({
            id: "",
            number: input.number,
            title: `Project #${String(input.number)}`,
            ownerLogin: input.owner,
          } satisfies GitHubProjectSummary);

        const statusField = yield* execute({
          cwd: input.cwd,
          args: [
            "project",
            "field-list",
            String(input.number),
            "--owner",
            input.owner,
            "--format",
            "json",
          ],
        }).pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.flatMap((raw) =>
            raw.length === 0
              ? Effect.succeed({ fields: [] })
              : decodeGitHubJson(
                  raw,
                  RawProjectFieldListSchema,
                  "getProjectBoard",
                  "GitHub CLI returned invalid project field JSON.",
                ),
          ),
          Effect.map((decoded) => findStatusField(decoded.fields ?? [])),
        );

        const items = yield* execute({
          cwd: input.cwd,
          args: [
            "project",
            "item-list",
            String(input.number),
            "--owner",
            input.owner,
            "--limit",
            String(PROJECT_ITEM_LIMIT),
            "--format",
            "json",
          ],
        }).pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.flatMap((raw) =>
            raw.length === 0
              ? Effect.succeed({ items: [] })
              : decodeGitHubJson(
                  raw,
                  RawProjectItemListSchema,
                  "getProjectBoard",
                  "GitHub CLI returned invalid project item JSON.",
                ),
          ),
          Effect.map((decoded) =>
            (decoded.items ?? [])
              .map((item) => normalizeProjectItem(item, statusField?.name ?? null))
              .filter((item): item is GitHubProjectItem => item !== null),
          ),
        );

        return { project, statusField, items } satisfies GitHubProjectBoardData;
      }),
    moveProjectCard: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "project",
          "item-edit",
          "--id",
          input.itemId,
          "--field-id",
          input.fieldId,
          "--project-id",
          input.projectId,
          "--single-select-option-id",
          input.optionId,
        ],
      }).pipe(Effect.asVoid),
    getRepositoryOwner: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", "--json", "owner", "-q", ".owner.login"],
      }).pipe(Effect.map((result) => result.stdout.trim())),
  } satisfies GitHubCliShape;

  return service;
});

export const GitHubCliLive = Layer.effect(GitHubCli, makeGitHubCli);
