// Purpose: Pure parsing/normalization helpers that map raw `gh` JSON into GitHubCli domain types.
// Layer: GitHubCliLive (apps/server/src/git/Layers/GitHubCli.ts) — no I/O; decodeGitHubJson is the only Effect-returning helper.
// Exports: error/state normalizers, all normalize*/rollup*/map*/find* mappers, review-event helpers,
//   cursor/page-info helpers, and decodeGitHubJson.

import { Effect, Schema } from "effect";

import { GitHubCliError } from "../Errors.ts";
import type {
  GitHubChecksStatus,
  GitHubCreateReviewResult,
  GitHubProjectItem,
  GitHubProjectStatusField,
  GitHubProjectSummary,
  GitHubPullRequestSummary,
  GitHubRepositoryCloneUrls,
  GitHubReviewCheck,
  GitHubReviewCheckState,
  GitHubReviewCommit,
  GitHubReviewer,
  GitHubReviewerState,
  GitHubReviewEvent,
  GitHubReviewPullRequest,
  GitHubReviewPullRequestDetail,
  GitHubReviewThread,
  GitHubReviewTimelineEvent,
} from "../Services/GitHubCli.ts";
import {
  FAILING_CHECK_STATES,
  PENDING_CHECK_STATES,
  PROJECT_SCOPE_MISSING_DETAIL,
  RawCreateReviewResponseSchema,
  RawGitHubConversationSchema,
  RawGitHubPullRequestSchema,
  RawGitHubRepositoryCloneUrlsSchema,
  RawGitHubReviewDetailSchema,
  RawGitHubReviewPullRequestSchema,
  RawPageInfoSchema,
  RawProjectFieldSchema,
  RawProjectItemContentSchema,
  RawProjectSummarySchema,
  RawReviewAuthorSchema,
  RawReviewCommitSchema,
  RawReviewLabelSchema,
  RawReviewLatestReviewSchema,
  RawReviewRequestSchema,
  RawReviewThreadCommentSchema,
  RawReviewThreadSchema,
  RawReviewUserSchema,
  RawStatusCheckRollupEntrySchema,
  SUCCESS_CHECK_STATES,
} from "./GitHubCli.types.ts";

export function isProjectScopeError(error: GitHubCliError): boolean {
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

export function normalizeGitHubCliError(
  operation: "execute" | "stdout",
  error: unknown,
): GitHubCliError {
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

export function normalizeAvatarUrl(value: string | null | undefined): string | undefined {
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

function normalizeReviewLabelNames(
  rawLabels: ReadonlyArray<Schema.Schema.Type<typeof RawReviewLabelSchema>>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const raw of rawLabels) {
    const name = (raw.name ?? "").trim();
    if (name.length > 0 && !seen.has(name)) {
      seen.add(name);
      labels.push(name);
    }
  }
  return labels;
}

function normalizeReviewUserLogins(
  rawUsers: ReadonlyArray<Schema.Schema.Type<typeof RawReviewUserSchema>>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const logins: string[] = [];
  for (const raw of rawUsers) {
    const login = (raw.login ?? raw.name ?? "").trim();
    if (login.length > 0 && !seen.has(login)) {
      seen.add(login);
      logins.push(login);
    }
  }
  return logins;
}

export function normalizeReviewPullRequest(
  raw: Schema.Schema.Type<typeof RawGitHubReviewPullRequestSchema>,
): GitHubReviewPullRequest {
  const author = raw.author?.login?.trim() ?? "";
  const authorAvatarUrl = normalizeAvatarUrl(raw.author?.avatarUrl);
  const reviewDecision = raw.reviewDecision?.trim() ?? "";
  const headRepositoryOwnerLogin = raw.headRepositoryOwner?.login?.trim() ?? "";
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    ...(headRepositoryOwnerLogin.length > 0 ? { headRepositoryOwnerLogin } : {}),
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
    labels: normalizeReviewLabelNames(raw.labels ?? []),
    assignees: normalizeReviewUserLogins(raw.assignees ?? []),
  };
}

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

export function normalizeReviewChecks(
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

export function normalizeReviewCommit(
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
    byLogin.set(login, {
      login,
      state: "REVIEW_REQUIRED",
      ...(avatarUrl ? { avatarUrl } : {}),
    });
  }
  return [...byLogin.values()];
}

function normalizeReviewMergeable(
  value: string | null | undefined,
): "MERGEABLE" | "CONFLICTING" | "UNKNOWN" {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized === "MERGEABLE" || normalized === "CONFLICTING" ? normalized : "UNKNOWN";
}

export function normalizeReviewDetail(
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
    state: normalizePullRequestState({
      state: raw.state,
      mergedAt: raw.mergedAt,
    }),
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
      .map((label) => ({
        name: (label.name ?? "").trim(),
        color: (label.color ?? "").trim(),
      }))
      .filter((label) => label.name.length > 0),
    assignees: (raw.assignees ?? [])
      .map(normalizeReviewUserRef)
      .filter((user): user is NonNullable<typeof user> => user !== null),
    reviewers: normalizeReviewers(raw.latestReviews ?? [], raw.reviewRequests ?? []),
  };
}

export function normalizeConversation(
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

export function normalizePullRequestSummary(
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

export function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

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

export function normalizeReviewThreadNode(input: {
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

export function reviewEventName(
  event: GitHubReviewEvent,
): "APPROVE" | "REQUEST_CHANGES" | "COMMENT" {
  if (event === "approve") {
    return "APPROVE";
  }
  if (event === "request_changes") {
    return "REQUEST_CHANGES";
  }
  return "COMMENT";
}

export function reviewEventFlag(event: GitHubReviewEvent): string {
  if (event === "approve") {
    return "--approve";
  }
  if (event === "request_changes") {
    return "--request-changes";
  }
  return "--comment";
}

export function normalizeProjectSummary(
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

export function findStatusField(
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
    options: (statusField.options ?? []).map((option) => ({
      id: option.id,
      name: option.name,
    })),
  };
}

export function normalizeProjectItem(
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

export function normalizeCreateReviewResult(
  response: Schema.Schema.Type<typeof RawCreateReviewResponseSchema>,
): GitHubCreateReviewResult {
  return {
    ...(typeof response.id === "number" && response.id > 0 ? { reviewId: response.id } : {}),
    ...(response.html_url && response.html_url.length > 0 ? { url: response.html_url } : {}),
  };
}

export function decodeGitHubJson<S extends Schema.Top>(
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

export function optionalCursorArg(name: string, value: string | null): ReadonlyArray<string> {
  return value !== null && value.length > 0 ? ["-F", `${name}=${value}`] : [];
}

export function pageInfoHasNext(
  pageInfo: Schema.Schema.Type<typeof RawPageInfoSchema> | null | undefined,
): boolean {
  return pageInfo?.hasNextPage === true;
}

export function pageInfoEndCursor(
  pageInfo: Schema.Schema.Type<typeof RawPageInfoSchema> | null | undefined,
): string | null {
  const cursor = pageInfo?.endCursor?.trim() ?? "";
  return cursor.length > 0 ? cursor : null;
}
