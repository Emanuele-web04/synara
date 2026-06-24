import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import {
  type ReviewChangedFile,
  type ReviewBoardLanesResult,
  type ReviewChangesetResult,
  type ReviewConversationResult,
  type ReviewFinding,
  type ReviewListPullRequestsInput,
  type ReviewListPullRequestsResult,
  type ReviewLoadBoardLanesInput,
  type ReviewListSort,
  type ReviewProjectCard,
  type ReviewProjectColumn,
  type ReviewProjectSummary,
  type ReviewPullRequestHeader,
  type ReviewPullRequestOverview,
  type ReviewPullRequestSurfaceResult,
  type ReviewPullRequestSummary,
  type ReviewSourceRef,
  type ReviewTargetKey,
  type ReviewTimelineEvent,
  type ReviewWalkthrough,
} from "@t3tools/contracts";
import { Clock, Effect, Fiber, Layer, Option } from "effect";

import type { GitHubCliError } from "../../git/Errors.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import {
  GitHubCli,
  type GitHubProjectBoardData,
  type GitHubProjectSummary,
  type GitHubReviewPullRequest,
  type GitHubReviewStateEvent,
} from "../../git/Services/GitHubCli.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { ReviewError, type ReviewServiceError } from "../Errors.ts";
import { parseUnifiedDiff } from "../parseUnifiedDiff.ts";
import { parseUnifiedDiffHunks } from "../parseUnifiedDiffHunks.ts";
import { formatHunksSummary, reconcileChapterCoverage } from "../walkthroughHunks.ts";
import { ReviewCacheStore, type ReviewCacheEnvelope } from "../Services/ReviewCacheStore.ts";
import {
  ReviewPullRequestStore,
  type ReviewPullRequestQuery,
} from "../Services/ReviewPullRequestStore.ts";
import { ReviewSync } from "../Services/ReviewSync.ts";
import { ReviewSource, type ReviewSourceShape } from "../Services/ReviewSource.ts";
import { ReviewUpdateBus } from "../Services/ReviewUpdateBus.ts";
import { deriveReviewLane } from "../reviewLane.ts";
import { validateInlineComments } from "../validateInlineComments.ts";

const PROJECT_ACCESS_DETAIL =
  "GitHub Projects access is not granted. Run `gh auth refresh -s project` and retry.";
const REVIEW_CACHE_TTL_MS = 30_000;
const REVIEW_CACHE_TOKEN_IDENTITY_PREFIX = "gh-user-v2";
const REVIEW_PREFLIGHT_CACHE_TTL_MS = 2_000;
const REVIEW_ANCHOR_KEY_SEPARATOR = "\u0000";
const DEFAULT_REVIEW_LIST_RESULT_LIMIT = 50;
const MAX_REVIEW_LIST_RESULT_LIMIT = 500;
const REVIEW_BOARD_LANE_LIMIT = MAX_REVIEW_LIST_RESULT_LIMIT;
const FILTERED_REVIEW_LIST_CANDIDATE_LIMIT = 1_000;
const FILTERED_REVIEW_LIST_CANDIDATE_MULTIPLIER = 10;
const REVIEW_BOARD_SYNC_STALE_MS = 60_000;
const inFlightRefreshKeys = new Set<string>();
const inFlightBoardSyncKeys = new Set<string>();

interface ReviewCacheIdentity {
  readonly login: string;
  readonly tokenIdentity: string;
}

interface ReviewPreflightCacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

function reviewError(operation: string, detail: string, cause?: unknown): ReviewError {
  return new ReviewError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function isProjectScopeMissing(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("missing the `read:project` scope") || lower.includes("missing required scopes")
  );
}

function toProjectSummary(summary: GitHubProjectSummary): ReviewProjectSummary | null {
  if (summary.id.length === 0 || summary.title.length === 0 || summary.ownerLogin.length === 0) {
    return null;
  }
  return {
    id: summary.id,
    number: summary.number,
    title: summary.title,
    ownerLogin: summary.ownerLogin,
    ...(summary.url ? { url: summary.url } : {}),
  };
}

function toProjectBoard(board: GitHubProjectBoardData) {
  const columns: ReadonlyArray<ReviewProjectColumn> = (board.statusField?.options ?? []).map(
    (option) => ({ id: option.id, name: option.name }),
  );
  const optionIdByName = new Map(
    (board.statusField?.options ?? []).map((option) => [option.name.trim(), option.id] as const),
  );
  const cards: ReadonlyArray<ReviewProjectCard> = board.items.map((item) => ({
    itemId: item.itemId,
    columnId: item.statusName ? (optionIdByName.get(item.statusName.trim()) ?? null) : null,
    number: item.number !== null && item.number > 0 ? item.number : null,
    title: item.title,
    author: item.author,
    isPullRequest: item.contentType === "PullRequest",
    ...(item.url ? { url: item.url } : {}),
    ...(item.repositoryNameWithOwner
      ? { repositoryNameWithOwner: item.repositoryNameWithOwner }
      : {}),
  }));
  const fallbackSummary: ReviewProjectSummary = {
    id: board.project.id.length > 0 ? board.project.id : `project-${String(board.project.number)}`,
    number: board.project.number,
    title:
      board.project.title.length > 0
        ? board.project.title
        : `Project #${String(board.project.number)}`,
    ownerLogin: board.project.ownerLogin.length > 0 ? board.project.ownerLogin : "unknown",
    ...(board.project.url ? { url: board.project.url } : {}),
  };
  return {
    project: toProjectSummary(board.project) ?? fallbackSummary,
    statusFieldId: board.statusField?.id ?? null,
    columns,
    cards,
  };
}

function toPullRequestSummary(pr: GitHubReviewPullRequest): ReviewPullRequestSummary | null {
  if (pr.title.length === 0 || pr.baseRefName.length === 0 || pr.headRefName.length === 0) {
    return null;
  }
  const headRepositoryOwnerLogin = pr.headRepositoryOwnerLogin?.trim() ?? "";
  const headSelector =
    headRepositoryOwnerLogin.length > 0
      ? `${headRepositoryOwnerLogin}:${pr.headRefName}`
      : pr.headRefName;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    ...(headSelector !== pr.headRefName ? { headSelector } : {}),
    author: pr.author,
    ...(pr.authorAvatarUrl !== undefined ? { authorAvatarUrl: pr.authorAvatarUrl } : {}),
    updatedAt: pr.updatedAt,
    state: pr.state,
    reviewDecision: pr.reviewDecision,
    isDraft: pr.isDraft,
    additions: pr.additions,
    deletions: pr.deletions,
    checksStatus: pr.checksStatus,
    reviewRequests: pr.reviewRequests,
    labels: pr.labels,
    assignees: pr.assignees,
  };
}

function normalizeOptionalText(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizedSet(values: ReadonlyArray<string> | undefined): ReadonlySet<string> {
  if (!values || values.length === 0) {
    return new Set();
  }
  return new Set(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

function mergedSet(
  value: string | undefined,
  values: ReadonlyArray<string> | undefined,
): ReadonlySet<string> {
  return normalizedSet([...(value !== undefined ? [value] : []), ...(values ?? [])]);
}

function resolvedAliasSet(
  values: ReadonlyArray<string> | undefined,
  viewerLogin: string,
): ReadonlySet<string> {
  return new Set(
    [...normalizedSet(values)]
      .map((value) => resolveViewerAlias(value, viewerLogin))
      .filter((value): value is string => value !== null && value.length > 0),
  );
}

function resolvedAliasMergedSet(
  value: string | undefined,
  values: ReadonlyArray<string> | undefined,
  viewerLogin: string,
): ReadonlySet<string> {
  return resolvedAliasSet(
    [...(value !== undefined ? [value] : []), ...(values ?? [])],
    viewerLogin,
  );
}

function makeListFilterMatcher(
  input: ReviewListPullRequestsInput,
  viewerLogin: string,
): (summary: ReviewPullRequestSummary) => boolean {
  const authors = resolvedAliasMergedSet(input.author, input.authors, viewerLogin);
  const reviewRequested = resolveViewerAlias(
    normalizeOptionalText(input.reviewRequested),
    viewerLogin,
  );
  const baseBranches = mergedSet(input.baseBranch, input.baseBranches);
  const headBranches = mergedSet(input.headBranch, input.headBranches);
  const labels = mergedSet(input.label, input.labels);
  const assignees = resolvedAliasMergedSet(input.assignee, input.assignees, viewerLogin);
  const columns = normalizedSet(input.columns);
  const checks = normalizedSet(input.checks);
  return (summary) =>
    (authors.size === 0 || authors.has(summary.author)) &&
    (!reviewRequested || summary.reviewRequests.includes(reviewRequested)) &&
    (baseBranches.size === 0 || baseBranches.has(summary.baseBranch)) &&
    (headBranches.size === 0 ||
      headBranches.has(summary.headBranch) ||
      (summary.headSelector ? headBranches.has(summary.headSelector) : false)) &&
    (labels.size === 0 || summary.labels.some((summaryLabel) => labels.has(summaryLabel))) &&
    (assignees.size === 0 ||
      summary.assignees.some((summaryAssignee) => assignees.has(summaryAssignee))) &&
    (input.draft !== true || summary.isDraft) &&
    (columns.size === 0 || columns.has(deriveReviewLane(summary))) &&
    (checks.size === 0 || checks.has(summary.checksStatus));
}

function hasLocalListFilters(input: ReviewListPullRequestsInput, viewerLogin: string): boolean {
  const nativeReviewStatus = nativeListReviewStatus(input.columns);
  const allAuthors = [...resolvedAliasMergedSet(input.author, input.authors, viewerLogin)];
  const nativeAuthors = nativeListSearchValues(allAuthors);
  const localAuthors = allAuthors.filter((author) => !nativeAuthors.includes(author));
  const allBaseBranches = [...mergedSet(input.baseBranch, input.baseBranches)];
  const nativeBaseBranches = nativeListSearchValues(allBaseBranches);
  const localBaseBranches = allBaseBranches.filter(
    (branch) => !nativeBaseBranches.includes(branch),
  );
  const allHeadBranches = [...mergedSet(input.headBranch, input.headBranches)];
  const nativeHeadBranches = nativeListSearchValues(allHeadBranches);
  const localHeadBranches = allHeadBranches.filter(
    (branch) => !nativeHeadBranches.includes(branch),
  );
  const allLabels = [...mergedSet(input.label, input.labels)];
  const nativeLabels = nativeListLabels(allLabels);
  const localLabels = allLabels.filter((label) => !nativeLabels.includes(label));
  const allAssignees = [...resolvedAliasMergedSet(input.assignee, input.assignees, viewerLogin)];
  const nativeAssignees = nativeListSearchValues(allAssignees);
  const localAssignees = allAssignees.filter((assignee) => !nativeAssignees.includes(assignee));
  const localColumns = [...normalizedSet(input.columns)].filter(
    (column) => (column !== "draft" || input.draft !== true) && column !== nativeReviewStatus,
  );
  const nativeChecksStatuses = nativeListChecksStatuses(input.checks);
  const localChecks = [...normalizedSet(input.checks)].filter(
    (check) => !nativeChecksStatuses.includes(check as "passing" | "failing" | "pending"),
  );
  return (
    localAuthors.length > 0 ||
    localBaseBranches.length > 0 ||
    localHeadBranches.length > 0 ||
    localLabels.length > 0 ||
    localAssignees.length > 0 ||
    localColumns.length > 0 ||
    localChecks.length > 0
  );
}

function normalizedReviewListSort(sort: ReviewListPullRequestsInput["sort"]): ReviewListSort {
  return sort ?? "updated";
}

function sortNeedsExpandedCandidates(input: ReviewListPullRequestsInput): boolean {
  return normalizedReviewListSort(input.sort) !== "updated";
}

function compareReviewPullRequestSummaries(
  sort: ReviewListSort,
): (a: ReviewPullRequestSummary, b: ReviewPullRequestSummary) => number {
  switch (sort) {
    case "title":
      return (a, b) => a.title.localeCompare(b.title);
    case "size":
      return (a, b) => b.additions + b.deletions - (a.additions + a.deletions);
    case "updated":
      return (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  }
}

function nativeListSearchValues(values: ReadonlyArray<string> | undefined): ReadonlyArray<string> {
  const normalized = [...normalizedSet(values)].sort();
  if (
    normalized.length === 0 ||
    normalized.some((value) => /[\s,"\\()]/.test(value) || /^(AND|OR|NOT)$/i.test(value))
  ) {
    return [];
  }
  return normalized;
}

function nativeListLabels(labels: ReadonlyArray<string> | undefined): ReadonlyArray<string> {
  const normalized = [...normalizedSet(labels)].sort();
  if (
    normalized.length === 0 ||
    normalized.some((label) => label.includes(",") || label.includes('"') || label.includes("\\"))
  ) {
    return [];
  }
  return normalized;
}

function nativeListReviewStatus(
  columns:
    | ReadonlyArray<"draft" | "needs-review" | "changes-requested" | "approved" | "merged">
    | undefined,
): "approved" | "changes-requested" | undefined {
  const normalized = [...normalizedSet(columns)];
  if (normalized.length !== 1) {
    return undefined;
  }
  const [column] = normalized;
  return column === "approved" || column === "changes-requested" ? column : undefined;
}

function nativeListChecksStatuses(
  checks: ReadonlyArray<"passing" | "failing" | "pending" | "none"> | undefined,
): ReadonlyArray<"passing" | "failing" | "pending"> {
  const normalized = [...normalizedSet(checks)];
  const nativeStatuses: Array<"passing" | "failing" | "pending"> = [];
  for (const check of normalized) {
    if (check === "passing" || check === "failing" || check === "pending") {
      nativeStatuses.push(check);
      continue;
    }
    return [];
  }
  return nativeStatuses.sort();
}

function resolveViewerAlias(value: string | null, viewerLogin: string): string | null {
  if (value !== "@me") {
    return value;
  }
  return viewerLogin.trim().length > 0 ? viewerLogin.trim() : value;
}

function resultListLimit(input: ReviewListPullRequestsInput): number {
  return normalizedResultListLimit(input.limit);
}

function normalizedResultListLimit(limit: number | undefined): number {
  return Math.min(limit ?? DEFAULT_REVIEW_LIST_RESULT_LIMIT, MAX_REVIEW_LIST_RESULT_LIMIT);
}

function githubListLimit(input: ReviewListPullRequestsInput, viewerLogin: string): number {
  const needsLocalWindow =
    hasLocalListFilters(input, viewerLogin) || sortNeedsExpandedCandidates(input);
  if (!needsLocalWindow) {
    return resultListLimit(input);
  }
  const localFilterCandidateLimit = Math.max(
    resultListLimit(input) * FILTERED_REVIEW_LIST_CANDIDATE_MULTIPLIER,
    FILTERED_REVIEW_LIST_CANDIDATE_LIMIT,
  );
  return localFilterCandidateLimit;
}

function toChangedFiles(patch: string): ReadonlyArray<ReviewChangedFile> {
  return parseUnifiedDiff(patch).map((file) => {
    const changedFile: ReviewChangedFile = {
      path: file.path,
      insertions: file.insertions,
      deletions: file.deletions,
    };
    if (file.status) {
      Object.assign(changedFile, { status: file.status });
    }
    return changedFile;
  });
}

function patchSignature(patch: string): string {
  return createHash("sha256").update(patch).digest("hex").slice(0, 16);
}

function ensureChangesetPatchSignature(changeset: ReviewChangesetResult): ReviewChangesetResult {
  return changeset.patchSignature
    ? changeset
    : { ...changeset, patchSignature: patchSignature(changeset.patch) };
}

function findingId(input: {
  readonly patchSignature: string;
  readonly finding: ReviewFinding;
}): string {
  return createHash("sha256")
    .update(
      [
        input.patchSignature,
        input.finding.path,
        String(input.finding.line),
        input.finding.side,
        input.finding.severity,
        input.finding.title,
        input.finding.message,
      ].join(REVIEW_ANCHOR_KEY_SEPARATOR),
    )
    .digest("hex")
    .slice(0, 16);
}

function filterAnchorableFindings(
  patch: string,
  findings: ReadonlyArray<ReviewFinding>,
): { readonly findings: ReadonlyArray<ReviewFinding>; readonly droppedFindings: number } {
  const { valid } = validateInlineComments(
    patch,
    findings.map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: finding.side,
      body: finding.message,
    })),
  );
  const anchorable = new Set(
    valid.map((comment) => reviewAnchorKey(comment.path, comment.line, comment.side)),
  );
  const filtered = findings.filter((finding) =>
    anchorable.has(reviewAnchorKey(finding.path, finding.line, finding.side)),
  );
  return { findings: filtered, droppedFindings: findings.length - filtered.length };
}

function reviewAnchorKey(path: string, line: number, side: string): string {
  return [path, String(line), side].join(REVIEW_ANCHOR_KEY_SEPARATOR);
}

function pullRequestListFilter(
  input: {
    readonly state?: string | undefined;
    readonly limit?: number | undefined;
    readonly search?: string | undefined;
    readonly author?: string | undefined;
    readonly authors?: ReadonlyArray<string> | undefined;
    readonly reviewRequested?: string | undefined;
    readonly baseBranch?: string | undefined;
    readonly baseBranches?: ReadonlyArray<string> | undefined;
    readonly headBranch?: string | undefined;
    readonly headBranches?: ReadonlyArray<string> | undefined;
    readonly label?: string | undefined;
    readonly labels?: ReadonlyArray<string> | undefined;
    readonly assignee?: string | undefined;
    readonly assignees?: ReadonlyArray<string> | undefined;
    readonly draft?: boolean | undefined;
    readonly columns?: ReadonlyArray<string> | undefined;
    readonly checks?: ReadonlyArray<string> | undefined;
    readonly sort?: ReviewListSort | undefined;
  },
  viewerLogin: string,
  options: { readonly includeLimit: boolean } = { includeLimit: true },
): string {
  const authors = [...resolvedAliasMergedSet(input.author, input.authors, viewerLogin)].sort();
  const baseBranches = [...mergedSet(input.baseBranch, input.baseBranches)].sort();
  const headBranches = [...mergedSet(input.headBranch, input.headBranches)].sort();
  const labels = [...mergedSet(input.label, input.labels)].sort();
  const assignees = [
    ...resolvedAliasMergedSet(input.assignee, input.assignees, viewerLogin),
  ].sort();
  return JSON.stringify({
    state: input.state ?? "open",
    ...(options.includeLimit ? { limit: normalizedResultListLimit(input.limit) } : {}),
    search: normalizeOptionalText(input.search),
    author: authors.length === 1 ? authors[0] : null,
    authors: authors.length > 1 ? authors : [],
    reviewRequested: normalizeOptionalText(input.reviewRequested),
    baseBranch: baseBranches.length === 1 ? baseBranches[0] : null,
    baseBranches: baseBranches.length > 1 ? baseBranches : [],
    headBranch: headBranches.length === 1 ? headBranches[0] : null,
    headBranches: headBranches.length > 1 ? headBranches : [],
    label: labels.length === 1 ? labels[0] : null,
    labels: labels.length > 1 ? labels : [],
    assignee: assignees.length === 1 ? assignees[0] : null,
    assignees: assignees.length > 1 ? assignees : [],
    draft: input.draft === true ? true : null,
    columns: [...normalizedSet(input.columns)].sort(),
    checks: [...normalizedSet(input.checks)].sort(),
    ...(input.sort !== undefined ? { sort: normalizedReviewListSort(input.sort) } : {}),
  });
}

function usesExpandedPullRequestListCache(
  input: ReviewListPullRequestsInput,
  viewerLogin: string,
): boolean {
  return hasLocalListFilters(input, viewerLogin) || sortNeedsExpandedCandidates(input);
}

const MIRROR_SERVICEABLE_LANES: ReadonlySet<string> = new Set([
  "draft",
  "needs-review",
  "changes-requested",
  "approved",
]);

// The mirror holds only open, non-tombstoned rows, has no checks rollup, and can't
// express "non-draft only" or a title sort. Those queries stay on the gh path.
function canServeListFromMirror(input: ReviewListPullRequestsInput): boolean {
  if (input.state !== undefined && input.state !== "open") {
    return false;
  }
  if (normalizeOptionalText(input.search) !== null) {
    return false;
  }
  if (normalizedSet(input.checks).size > 0) {
    return false;
  }
  if (input.draft === false) {
    return false;
  }
  const sort = input.sort;
  if (sort !== undefined && sort !== "updated" && sort !== "size") {
    return false;
  }
  const columns = [...normalizedSet(input.columns)];
  if (columns.some((column) => !MIRROR_SERVICEABLE_LANES.has(column))) {
    return false;
  }
  return true;
}

function toMirrorQuery(
  input: ReviewListPullRequestsInput,
  repositoryId: string,
  viewerLogin: string,
  limit = resultListLimit(input),
): ReviewPullRequestQuery {
  const lanes = [...normalizedSet(input.columns)];
  const authors = [...resolvedAliasMergedSet(input.author, input.authors, viewerLogin)];
  const baseBranches = [...mergedSet(input.baseBranch, input.baseBranches)];
  const headBranches = [...mergedSet(input.headBranch, input.headBranches)];
  const labels = [...mergedSet(input.label, input.labels)];
  const assignees = [...resolvedAliasMergedSet(input.assignee, input.assignees, viewerLogin)];
  const resolvedReviewRequested = normalizeOptionalText(
    resolveViewerAlias(normalizeOptionalText(input.reviewRequested), viewerLogin) ?? undefined,
  );
  return {
    repositoryId,
    state: "open",
    ...(lanes.length > 0 ? { lanes } : {}),
    ...(authors.length > 0 ? { authors } : {}),
    ...(baseBranches.length > 0 ? { baseBranches } : {}),
    ...(headBranches.length > 0 ? { headBranches } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    ...(assignees.length > 0 ? { assignees } : {}),
    ...(resolvedReviewRequested ? { reviewRequested: resolvedReviewRequested } : {}),
    ...(input.draft === true ? { draft: true } : {}),
    sort: input.sort === "size" ? "size" : "updated",
    limit,
  };
}

function mirrorListCandidateLimit(resultLimit: number): number {
  return resultLimit + 1;
}

function pullRequestListCacheFilter(
  input: ReviewListPullRequestsInput,
  viewerLogin: string,
): string {
  return pullRequestListFilter(input, viewerLogin, {
    includeLimit: !usesExpandedPullRequestListCache(input, viewerLogin),
  });
}

function slicePullRequestListResult(
  data: ReviewListPullRequestsResult,
  input: ReviewListPullRequestsInput,
): ReviewListPullRequestsResult {
  const resultLimit = resultListLimit(input);
  const pullRequests = data.pullRequests.slice(0, resultLimit);
  if (data.meta === undefined) {
    return { pullRequests };
  }
  const {
    requestedLimit: _requestedLimit,
    resultLimit: _resultLimit,
    returnedCount: _returnedCount,
    ...restMeta
  } = data.meta;
  return {
    pullRequests,
    meta: {
      ...restMeta,
      ...(input.limit !== undefined ? { requestedLimit: input.limit } : {}),
      resultLimit,
      returnedCount: pullRequests.length,
    },
  };
}

function isUsableCacheEnvelope<T>(
  envelope: ReviewCacheEnvelope<T>,
  tokenIdentity: string,
): boolean {
  return envelope.tokenIdentity === tokenIdentity;
}

function hasAvatar(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function hasCompleteReviewSidebarAvatars(overview: ReviewPullRequestOverview): boolean {
  return (
    hasAvatar(overview.detail.authorAvatarUrl) &&
    overview.detail.reviewers.every((reviewer) => hasAvatar(reviewer.avatarUrl)) &&
    overview.detail.assignees.every((assignee) => hasAvatar(assignee.avatarUrl))
  );
}

function isUsablePullRequestOverviewCacheEnvelope(
  envelope: ReviewCacheEnvelope<ReviewPullRequestOverview>,
  tokenIdentity: string,
): boolean {
  return (
    isUsableCacheEnvelope(envelope, tokenIdentity) && hasCompleteReviewSidebarAvatars(envelope.data)
  );
}

function emptyWalkthrough(
  currentPatchSignature: string,
  currentPatchSource: ReviewWalkthrough["patchSource"],
  headSha: string | undefined,
  generatedAt: string,
): ReviewWalkthrough {
  return {
    prologue: {
      keyChanges: [],
      focusAreas: [],
      complexity: { level: "low", reasoning: "No changes to walk through." },
    },
    chapters: [],
    ...(headSha ? { reviewedHeadSha: headSha } : {}),
    patchSignature: currentPatchSignature,
    ...(currentPatchSource ? { patchSource: currentPatchSource } : {}),
    generatedAt,
  };
}

const makeReviewSource = Effect.gen(function* () {
  const cacheStore = yield* ReviewCacheStore;
  const pullRequestStore = yield* ReviewPullRequestStore;
  const reviewSync = yield* ReviewSync;
  const gitCore = yield* GitCore;
  const gitHubCli = yield* GitHubCli;
  const gitManager = yield* GitManager;
  const reviewUpdateBus = yield* ReviewUpdateBus;
  const textGeneration = yield* TextGeneration;
  const cacheWriteClock = Clock.currentTimeMillis;
  const cacheIdentityByCwd = new Map<string, ReviewPreflightCacheEntry<ReviewCacheIdentity>>();
  const repositoryIdByCwd = new Map<string, ReviewPreflightCacheEntry<string>>();

  const readCacheIdentityUncached = (cwd: string) =>
    gitHubCli.getAuthenticatedUser({ cwd }).pipe(
      Effect.map((viewer) => {
        const login = viewer.login.trim();
        return {
          login,
          tokenIdentity: `${REVIEW_CACHE_TOKEN_IDENTITY_PREFIX}:${login}`,
        };
      }),
      Effect.catchTag("GitHubCliError", () =>
        Effect.succeed({
          login: "",
          tokenIdentity: `${REVIEW_CACHE_TOKEN_IDENTITY_PREFIX}:unknown`,
        }),
      ),
    );

  const readCacheIdentity = (cwd: string) =>
    Effect.gen(function* () {
      const cacheKey = canonicalizePath(cwd);
      const now = yield* cacheWriteClock;
      const cached = cacheIdentityByCwd.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        return cached.value;
      }
      const identity = yield* readCacheIdentityUncached(cwd);
      const fetchedAt = yield* cacheWriteClock;
      cacheIdentityByCwd.set(cacheKey, {
        value: identity,
        expiresAt: fetchedAt + REVIEW_PREFLIGHT_CACHE_TTL_MS,
      });
      return identity;
    });

  const readCacheTokenIdentity = (cwd: string) =>
    readCacheIdentity(cwd).pipe(Effect.map((identity) => identity.tokenIdentity));

  const resolveRepositoryIdUncached = (cwd: string) =>
    gitCore
      .execute({
        operation: "ReviewSource.repositoryId",
        cwd,
        args: ["rev-parse", "--show-toplevel"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          const toplevel = result.stdout.trim();
          const canonical =
            toplevel.length > 0 ? canonicalizePath(toplevel) : canonicalizePath(cwd);
          return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
        }),
        Effect.catch(() =>
          Effect.succeed(
            createHash("sha256").update(canonicalizePath(cwd)).digest("hex").slice(0, 16),
          ),
        ),
      );

  const resolveRepositoryId = (cwd: string) =>
    Effect.gen(function* () {
      const cacheKey = canonicalizePath(cwd);
      const now = yield* cacheWriteClock;
      const cached = repositoryIdByCwd.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        return cached.value;
      }
      const repositoryId = yield* resolveRepositoryIdUncached(cwd);
      const fetchedAt = yield* cacheWriteClock;
      repositoryIdByCwd.set(cacheKey, {
        value: repositoryId,
        expiresAt: fetchedAt + REVIEW_PREFLIGHT_CACHE_TTL_MS,
      });
      return repositoryId;
    });

  const listPullRequestsUncached = (
    input: ReviewListPullRequestsInput,
    viewerLogin: string,
    options: { readonly sliceExpandedResults: boolean } = { sliceExpandedResults: true },
  ) => {
    const listLimit = githubListLimit(input, viewerLogin);
    const authors = nativeListSearchValues([
      ...resolvedAliasMergedSet(input.author, input.authors, viewerLogin),
    ]);
    const baseBranches = nativeListSearchValues([
      ...mergedSet(input.baseBranch, input.baseBranches),
    ]);
    const headBranches = nativeListSearchValues([
      ...mergedSet(input.headBranch, input.headBranches),
    ]);
    const labels = nativeListLabels([...mergedSet(input.label, input.labels)]);
    const assignees = nativeListSearchValues([
      ...resolvedAliasMergedSet(input.assignee, input.assignees, viewerLogin),
    ]);
    const reviewStatus = nativeListReviewStatus(input.columns);
    const checksStatuses = nativeListChecksStatuses(input.checks);
    return gitHubCli
      .listRepositoryPullRequests({
        cwd: input.cwd,
        state: input.state ?? "open",
        limit: listLimit,
        ...(input.search !== undefined ? { search: input.search } : {}),
        ...(authors.length === 1 ? { author: authors[0] } : {}),
        ...(authors.length > 1 ? { authors } : {}),
        ...(input.reviewRequested !== undefined ? { reviewRequested: input.reviewRequested } : {}),
        ...(baseBranches.length === 1 ? { baseBranch: baseBranches[0] } : {}),
        ...(baseBranches.length > 1 ? { baseBranches } : {}),
        ...(headBranches.length === 1 ? { headBranch: headBranches[0] } : {}),
        ...(headBranches.length > 1 ? { headBranches } : {}),
        ...(labels.length === 1 ? { label: labels[0] } : {}),
        ...(labels.length > 1 ? { labels } : {}),
        ...(assignees.length === 1 ? { assignee: assignees[0] } : {}),
        ...(assignees.length > 1 ? { assignees } : {}),
        ...(input.draft === true ? { draft: true } : {}),
        ...(reviewStatus !== undefined ? { reviewStatus } : {}),
        ...(checksStatuses.length > 0 ? { checksStatuses } : {}),
      })
      .pipe(
        Effect.map((pullRequests): ReviewListPullRequestsResult => {
          const matchesListFilters = makeListFilterMatcher(input, viewerLogin);
          const summaries = pullRequests
            .map(toPullRequestSummary)
            .filter((summary): summary is ReviewPullRequestSummary => summary !== null)
            .filter(matchesListFilters);
          const sortedSummaries = [...summaries].sort(
            compareReviewPullRequestSummaries(normalizedReviewListSort(input.sort)),
          );
          const usesLocalCandidateWindow = usesExpandedPullRequestListCache(input, viewerLogin);
          const candidateLimit = listLimit;
          const resultLimit = resultListLimit(input);
          const returnedPullRequests =
            usesLocalCandidateWindow && options.sliceExpandedResults
              ? sortedSummaries.slice(0, resultLimit)
              : sortedSummaries;
          return {
            pullRequests: returnedPullRequests,
            meta: {
              ...(input.limit !== undefined ? { requestedLimit: input.limit } : {}),
              resultLimit,
              candidateLimit,
              candidateCount: pullRequests.length,
              candidateLimitReached: pullRequests.length >= candidateLimit,
              matchedCount: summaries.length,
              returnedCount: returnedPullRequests.length,
              bounded: true,
            },
          };
        }),
      );
  };

  const forkRefreshIfStale = <T>(
    key: string,
    envelope: ReviewCacheEnvelope<T>,
    refresh: Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const now = yield* cacheWriteClock;
      if (now - envelope.lastValidatedAt < envelope.ttlMs || inFlightRefreshKeys.has(key)) {
        return;
      }
      inFlightRefreshKeys.add(key);
      yield* refresh.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            inFlightRefreshKeys.delete(key);
          }),
        ),
        Effect.forkDetach,
        Effect.ignore,
      );
    });

  const forkBoardSync = (
    cwd: string,
    repositoryId: string,
    tokenIdentity: string,
    now: number,
    mode: "delta" | "full",
  ) =>
    Effect.gen(function* () {
      if (inFlightBoardSyncKeys.has(repositoryId)) {
        return;
      }
      inFlightBoardSyncKeys.add(repositoryId);
      yield* reviewSync.syncRepository({ cwd, repositoryId, tokenIdentity, now, mode }).pipe(
        // reconciled counts as a change: a full reconcile can drop merged/closed PRs without upserting.
        Effect.flatMap((result) =>
          result.upserted > 0 || result.reconciled
            ? reviewUpdateBus.publish({ _tag: "boardLanes", cwd, repositoryId, fetchedAt: now })
            : Effect.void,
        ),
        Effect.ensuring(
          Effect.sync(() => {
            inFlightBoardSyncKeys.delete(repositoryId);
          }),
        ),
        Effect.catch((error: unknown) =>
          Effect.logWarning(`ReviewSource.forkBoardSync(${mode}) failed: ${String(error)}`),
        ),
        Effect.forkDetach,
      );
    });

  // Background refresh runs full, not delta: an open-only delta can't observe PRs that left the open set.
  const ensureMirrorFresh = (
    cwd: string,
    repositoryId: string,
    tokenIdentity: string,
    now: number,
  ) =>
    Effect.gen(function* () {
      const syncFullMirror = reviewSync.syncRepository({
        cwd,
        repositoryId,
        tokenIdentity,
        now,
        mode: "full",
      });
      const syncState = yield* pullRequestStore.getSyncState({ repositoryId });
      const syncedIdentity = Option.isSome(syncState) ? syncState.value.tokenIdentity : null;
      if (syncedIdentity !== tokenIdentity) {
        yield* syncFullMirror;
        return;
      }

      const hasRows = yield* pullRequestStore.hasOpenPullRequests({ repositoryId });
      if (!hasRows) {
        yield* syncFullMirror;
        return;
      }

      const lastSyncedAt = Option.isSome(syncState) ? syncState.value.lastSyncedAt : null;
      if (lastSyncedAt === null) {
        yield* syncFullMirror;
        return;
      }

      if (now - lastSyncedAt >= REVIEW_BOARD_SYNC_STALE_MS) {
        yield* forkBoardSync(cwd, repositoryId, tokenIdentity, now, "full");
      }
    });

  const listPullRequestsFromMirror = (
    input: ReviewListPullRequestsInput,
    repositoryId: string,
    cacheIdentity: ReviewCacheIdentity,
    now: number,
  ) =>
    Effect.gen(function* () {
      yield* ensureMirrorFresh(input.cwd, repositoryId, cacheIdentity.tokenIdentity, now);
      const resultLimit = resultListLimit(input);
      const candidateLimit = mirrorListCandidateLimit(resultLimit);
      const pullRequests = yield* pullRequestStore.queryPullRequests(
        toMirrorQuery(input, repositoryId, cacheIdentity.login, candidateLimit),
      );
      const returnedPullRequests = pullRequests.slice(0, resultLimit);
      if (pullRequests.length < candidateLimit) {
        return { pullRequests: returnedPullRequests } satisfies ReviewListPullRequestsResult;
      }
      return {
        pullRequests: returnedPullRequests,
        meta: {
          ...(input.limit !== undefined ? { requestedLimit: input.limit } : {}),
          resultLimit,
          candidateLimit,
          candidateCount: pullRequests.length,
          candidateLimitReached: pullRequests.length >= candidateLimit,
          matchedCount: pullRequests.length,
          returnedCount: returnedPullRequests.length,
          bounded: true,
        },
      } satisfies ReviewListPullRequestsResult;
    }).pipe(
      Effect.mapError((error) =>
        reviewError("listPullRequests", "Could not list pull requests.", error),
      ),
    );

  const listPullRequests: ReviewSourceShape["listPullRequests"] = (input) =>
    Effect.gen(function* () {
      const [repositoryId, cacheIdentity, now] = yield* Effect.all(
        [resolveRepositoryId(input.cwd), readCacheIdentity(input.cwd), cacheWriteClock],
        { concurrency: "unbounded" },
      );
      if (canServeListFromMirror(input)) {
        return yield* listPullRequestsFromMirror(input, repositoryId, cacheIdentity, now);
      }
      const useExpandedCache = usesExpandedPullRequestListCache(input, cacheIdentity.login);
      const listFilter = pullRequestListCacheFilter(input, cacheIdentity.login);
      const cached = yield* cacheStore
        .getPullRequestList({ repositoryId, listFilter })
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (
        Option.isSome(cached) &&
        isUsableCacheEnvelope(cached.value, cacheIdentity.tokenIdentity)
      ) {
        const data = useExpandedCache
          ? slicePullRequestListResult(cached.value.data, input)
          : cached.value.data;
        yield* forkRefreshIfStale(
          `pr-list:${repositoryId}:${listFilter}`,
          cached.value,
          refreshPullRequestList(input, repositoryId, listFilter, cacheIdentity),
        );
        return data;
      }
      const cacheData = yield* listPullRequestsUncached(input, cacheIdentity.login, {
        sliceExpandedResults: !useExpandedCache,
      }).pipe(
        Effect.mapError((error) =>
          reviewError("listPullRequests", `Could not list pull requests: ${error.message}`, error),
        ),
      );
      const fetchedAt = yield* cacheWriteClock;
      yield* cacheStore
        .upsertPullRequestList({
          repositoryId,
          listFilter,
          data: cacheData,
          fetchedAt,
          ttlMs: REVIEW_CACHE_TTL_MS,
          tokenIdentity: cacheIdentity.tokenIdentity,
        })
        .pipe(Effect.ignore);
      return useExpandedCache ? slicePullRequestListResult(cacheData, input) : cacheData;
    });

  const loadBoardLanes: ReviewSourceShape["loadBoardLanes"] = (input) =>
    Effect.gen(function* () {
      const [repositoryId, cacheIdentity, now] = yield* Effect.all(
        [resolveRepositoryId(input.cwd), readCacheIdentity(input.cwd), cacheWriteClock],
        { concurrency: "unbounded" },
      );
      yield* ensureMirrorFresh(input.cwd, repositoryId, cacheIdentity.tokenIdentity, now);
      const limit =
        input.limit !== undefined
          ? normalizedResultListLimit(input.limit)
          : REVIEW_BOARD_LANE_LIMIT;
      const [needsReview, changesRequested, approved, draft] = yield* Effect.all(
        [
          pullRequestStore.getLane({ repositoryId, lane: "needs-review", limit }),
          pullRequestStore.getLane({ repositoryId, lane: "changes-requested", limit }),
          pullRequestStore.getLane({ repositoryId, lane: "approved", limit }),
          pullRequestStore.getLane({ repositoryId, lane: "draft", limit }),
        ],
        { concurrency: "unbounded" },
      );
      return {
        "needs-review": { pullRequests: needsReview },
        "changes-requested": { pullRequests: changesRequested },
        approved: { pullRequests: approved },
        draft: { pullRequests: draft },
      } satisfies ReviewBoardLanesResult;
    }).pipe(
      Effect.mapError((error) =>
        reviewError("loadBoardLanes", "Could not load review board lanes.", error),
      ),
    );

  const getViewer: ReviewSourceShape["getViewer"] = (input) =>
    gitHubCli.getAuthenticatedUser({ cwd: input.cwd }).pipe(
      Effect.map((viewer) => ({
        login: viewer.login.trim(),
        ...(viewer.avatarUrl !== undefined ? { avatarUrl: viewer.avatarUrl } : {}),
      })),
      Effect.catchTag("GitHubCliError", () => Effect.succeed({ login: "" })),
    );

  const readHeadSha = (cwd: string, reference: string) =>
    gitHubCli
      .getPullRequestHeadSha({ cwd, reference })
      .pipe(Effect.catchTag("GitHubCliError", () => Effect.succeed("")));

  const loadPullRequestChangesetUncached = (
    cwd: string,
    source: Extract<ReviewSourceRef, { _tag: "pullRequest" }>,
    knownHeadSha?: string,
  ) =>
    Effect.gen(function* () {
      const { pullRequest } = yield* gitManager
        .resolvePullRequest({ cwd, reference: source.reference })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "GitHubCliError" || error._tag === "GitCommandError"
              ? error
              : reviewError(
                  "loadPullRequestChangeset",
                  `Could not resolve pull request: ${error.message}`,
                  error,
                ),
          ),
        );
      const repositoryId = yield* resolveRepositoryId(cwd);

      const patchResult = yield* gitHubCli
        .getPullRequestDiff({ cwd, reference: source.reference })
        .pipe(
          Effect.map((patch) => ({ patch, patchSource: "github" as const })),
          Effect.catchTag("GitHubCliError", (error) =>
            gitCore
              .readRangeDiff({
                cwd,
                base: pullRequest.baseBranch,
                head: pullRequest.headBranch,
              })
              .pipe(
                Effect.map((result) => ({
                  patch: result.patch,
                  patchSource: "localFallback" as const,
                })),
                Effect.catch(() =>
                  Effect.fail(
                    reviewError(
                      "loadPullRequestChangeset",
                      `Could not load pull request diff: ${error.message}`,
                      error,
                    ),
                  ),
                ),
              ),
          ),
        );

      const headSha = knownHeadSha ?? (yield* readHeadSha(cwd, source.reference));
      const signature = patchSignature(patchResult.patch);

      const target: ReviewTargetKey = {
        _tag: "pullRequest",
        repositoryId,
        number: pullRequest.number,
      };

      return {
        target,
        patch: patchResult.patch,
        patchSignature: signature,
        patchSource: patchResult.patchSource,
        files: toChangedFiles(patchResult.patch),
        pullRequest,
        ...(headSha.length > 0 ? { headSha } : {}),
      } satisfies ReviewChangesetResult;
    });

  const loadBranchRangeChangeset = (
    cwd: string,
    source: Extract<ReviewSourceRef, { _tag: "branchRange" }>,
  ) =>
    Effect.gen(function* () {
      const repositoryId = yield* resolveRepositoryId(cwd);
      const { patch } = yield* gitCore.readRangeDiff({
        cwd,
        base: source.base,
        head: source.head,
      });

      const target: ReviewTargetKey = {
        _tag: "branchRange",
        repositoryId,
        base: source.base,
        head: source.head,
      };

      return {
        target,
        patch,
        patchSignature: patchSignature(patch),
        patchSource: "localBranchRange",
        files: toChangedFiles(patch),
      } satisfies ReviewChangesetResult;
    });

  const loadChangeset: ReviewSourceShape["loadChangeset"] = (input) => {
    if (input.source._tag !== "pullRequest") {
      return loadBranchRangeChangeset(input.cwd, input.source);
    }
    const source = input.source;
    return Effect.gen(function* () {
      const repositoryId = yield* resolveRepositoryId(input.cwd);
      const tokenIdentity = yield* readCacheTokenIdentity(input.cwd);
      const headSha = yield* readHeadSha(input.cwd, source.reference);
      if (headSha.length === 0) {
        const data = yield* loadPullRequestChangesetUncached(input.cwd, source);
        return ensureChangesetPatchSignature(data);
      }
      const cached = yield* cacheStore
        .getPullRequestChangeset({
          repositoryId,
          reference: source.reference,
          headSha,
        })
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isSome(cached) && isUsableCacheEnvelope(cached.value, tokenIdentity)) {
        yield* forkRefreshIfStale(
          `pr-diff:${repositoryId}:${source.reference}:${headSha}`,
          cached.value,
          refreshPullRequestChangeset(input.cwd, source, repositoryId, tokenIdentity),
        );
        return ensureChangesetPatchSignature(cached.value.data);
      }
      const data = ensureChangesetPatchSignature(
        yield* loadPullRequestChangesetUncached(input.cwd, source, headSha),
      );
      const fetchedAt = yield* cacheWriteClock;
      yield* cacheStore
        .upsertPullRequestChangeset({
          repositoryId,
          reference: source.reference,
          headSha,
          data,
          fetchedAt,
          ttlMs: REVIEW_CACHE_TTL_MS,
          tokenIdentity,
        })
        .pipe(Effect.ignore);
      return data;
    });
  };

  // detail + commits + checks come back from one `gh pr view`; GitHub's plain
  // shapes match the (unbranded) contract types field-for-field.
  const loadPullRequestUncached: ReviewSourceShape["loadPullRequest"] = (input) =>
    gitHubCli
      .getReviewPullRequestOverview({ cwd: input.cwd, reference: input.reference })
      .pipe(Effect.map((overview): ReviewPullRequestOverview => overview));

  const loadPullRequest: ReviewSourceShape["loadPullRequest"] = (input) =>
    Effect.gen(function* () {
      const repositoryId = yield* resolveRepositoryId(input.cwd);
      const tokenIdentity = yield* readCacheTokenIdentity(input.cwd);
      const cached = yield* cacheStore
        .getPullRequestOverview({ repositoryId, reference: input.reference })
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (
        Option.isSome(cached) &&
        isUsablePullRequestOverviewCacheEnvelope(cached.value, tokenIdentity)
      ) {
        yield* forkRefreshIfStale(
          `pr-overview:${repositoryId}:${input.reference}`,
          cached.value,
          refreshPullRequestOverview(input, repositoryId, tokenIdentity),
        );
        return cached.value.data;
      }
      const data = yield* loadPullRequestUncached(input);
      const fetchedAt = yield* cacheWriteClock;
      yield* cacheStore
        .upsertPullRequestOverview({
          repositoryId,
          reference: input.reference,
          data,
          fetchedAt,
          ttlMs: REVIEW_CACHE_TTL_MS,
          tokenIdentity,
        })
        .pipe(Effect.ignore);
      return data;
    });

  const loadPullRequestHeader: ReviewSourceShape["loadPullRequestHeader"] = (input) =>
    Effect.gen(function* () {
      const repositoryId = yield* resolveRepositoryId(input.cwd);
      const tokenIdentity = yield* readCacheTokenIdentity(input.cwd);
      const cached = yield* cacheStore
        .getPullRequestOverview({ repositoryId, reference: input.reference })
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (
        Option.isSome(cached) &&
        isUsablePullRequestOverviewCacheEnvelope(cached.value, tokenIdentity)
      ) {
        yield* forkRefreshIfStale(
          `pr-overview:${repositoryId}:${input.reference}`,
          cached.value,
          refreshPullRequestOverview(input, repositoryId, tokenIdentity),
        );
        return { detail: cached.value.data.detail } satisfies ReviewPullRequestHeader;
      }
      return yield* gitHubCli
        .getReviewPullRequestHeader({ cwd: input.cwd, reference: input.reference })
        .pipe(Effect.map((header): ReviewPullRequestHeader => header));
    });

  const loadConversationUncached: ReviewSourceShape["loadConversation"] = (input) =>
    Effect.gen(function* () {
      const [conversation, stateEvents] = yield* Effect.all(
        [
          gitHubCli.getReviewConversation({ cwd: input.cwd, reference: input.reference }),
          // State events are best-effort: a timeline failure must not drop the
          // comments/reviews/commits the conversation already loads.
          gitHubCli
            .getReviewTimeline({ cwd: input.cwd, reference: input.reference })
            .pipe(
              Effect.catchTag("GitHubCliError", () =>
                Effect.succeed([] as ReadonlyArray<GitHubReviewStateEvent>),
              ),
            ),
        ],
        { concurrency: "unbounded" },
      );
      const conversationEvents = conversation.map((event): ReviewTimelineEvent => {
        if (event.kind === "comment") {
          return {
            _tag: "comment",
            id: event.id,
            author: event.author,
            ...(event.authorAvatarUrl !== undefined
              ? { authorAvatarUrl: event.authorAvatarUrl }
              : {}),
            body: event.body,
            createdAt: event.createdAt,
            ...(event.url !== undefined ? { url: event.url } : {}),
          };
        }
        if (event.kind === "review") {
          return {
            _tag: "review",
            id: event.id,
            author: event.author,
            ...(event.authorAvatarUrl !== undefined
              ? { authorAvatarUrl: event.authorAvatarUrl }
              : {}),
            state: event.state,
            body: event.body,
            createdAt: event.createdAt,
            ...(event.url !== undefined ? { url: event.url } : {}),
          };
        }
        return {
          _tag: "commit",
          oid: event.oid,
          abbreviatedOid: event.abbreviatedOid,
          messageHeadline: event.messageHeadline,
          author: event.author,
          createdAt: event.createdAt,
        };
      });
      const stateTimeline = stateEvents.map((event): ReviewTimelineEvent => {
        switch (event.kind) {
          case "labeled":
            return {
              _tag: "labeled",
              actor: event.actor,
              label: { name: event.label, color: "" },
              added: event.added,
              createdAt: event.createdAt,
            };
          case "assigned":
            return {
              _tag: "assigned",
              actor: event.actor,
              assignee: event.assignee,
              added: event.added,
              createdAt: event.createdAt,
            };
          case "milestoned":
            return {
              _tag: "milestoned",
              actor: event.actor,
              milestone: event.milestone,
              added: event.added,
              createdAt: event.createdAt,
            };
          case "reviewRequested":
            return {
              _tag: "reviewRequested",
              actor: event.actor,
              requestedReviewer: event.requestedReviewer,
              createdAt: event.createdAt,
            };
          case "merged":
            return {
              _tag: "merged",
              actor: event.actor,
              ...(event.commitOid !== undefined ? { commitOid: event.commitOid } : {}),
              createdAt: event.createdAt,
            };
          case "closed":
            return { _tag: "closed", actor: event.actor, createdAt: event.createdAt };
          case "reopened":
            return { _tag: "reopened", actor: event.actor, createdAt: event.createdAt };
          case "headRefForcePushed":
            return { _tag: "headRefForcePushed", actor: event.actor, createdAt: event.createdAt };
        }
      });
      const events = [...conversationEvents, ...stateTimeline].sort(
        (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
      );
      return { events };
    });

  const loadConversation: ReviewSourceShape["loadConversation"] = (input) =>
    Effect.gen(function* () {
      const repositoryId = yield* resolveRepositoryId(input.cwd);
      const tokenIdentity = yield* readCacheTokenIdentity(input.cwd);
      const cached = yield* cacheStore
        .getPullRequestConversation({ repositoryId, reference: input.reference })
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isSome(cached) && isUsableCacheEnvelope(cached.value, tokenIdentity)) {
        yield* forkRefreshIfStale(
          `pr-conversation:${repositoryId}:${input.reference}`,
          cached.value,
          refreshPullRequestConversation(input, repositoryId, tokenIdentity),
        );
        return cached.value.data;
      }
      const data = yield* loadConversationUncached(input);
      const fetchedAt = yield* cacheWriteClock;
      yield* cacheStore
        .upsertPullRequestConversation({
          repositoryId,
          reference: input.reference,
          data,
          fetchedAt,
          ttlMs: REVIEW_CACHE_TTL_MS,
          tokenIdentity,
        })
        .pipe(Effect.ignore);
      return data;
    });

  const loadPullRequestSurface: ReviewSourceShape["loadPullRequestSurface"] = (input) =>
    Effect.gen(function* () {
      const [overview, conversation, changeset] = yield* Effect.all(
        [
          loadPullRequest({ cwd: input.cwd, reference: input.reference }),
          input.includeConversation === true
            ? loadConversation({ cwd: input.cwd, reference: input.reference })
            : Effect.succeed<ReviewConversationResult | undefined>(undefined),
          input.includeChangeset === true
            ? loadChangeset({ cwd: input.cwd, source: input.source })
            : Effect.succeed<ReviewChangesetResult | undefined>(undefined),
        ] as const,
        { concurrency: "unbounded" },
      );
      return {
        overview,
        ...(conversation !== undefined ? { conversation } : {}),
        ...(changeset !== undefined ? { changeset } : {}),
      } satisfies ReviewPullRequestSurfaceResult;
    });

  const refreshPullRequestList = (
    input: Parameters<ReviewSourceShape["listPullRequests"]>[0],
    repositoryId: string,
    listFilter: string,
    cacheIdentity: { readonly login: string; readonly tokenIdentity: string },
  ) =>
    listPullRequestsUncached(input, cacheIdentity.login, {
      sliceExpandedResults: !usesExpandedPullRequestListCache(input, cacheIdentity.login),
    }).pipe(
      Effect.flatMap((cacheData) =>
        cacheWriteClock.pipe(
          Effect.flatMap((fetchedAt) =>
            cacheStore
              .upsertPullRequestList({
                repositoryId,
                listFilter,
                data: cacheData,
                fetchedAt,
                ttlMs: REVIEW_CACHE_TTL_MS,
                tokenIdentity: cacheIdentity.tokenIdentity,
              })
              .pipe(
                Effect.andThen(
                  reviewUpdateBus.publish({
                    _tag: "pullRequestList",
                    cwd: input.cwd,
                    repositoryId,
                    state: input.state ?? "open",
                    ...(input.limit !== undefined ? { limit: input.limit } : {}),
                    ...(input.search !== undefined ? { search: input.search } : {}),
                    ...(input.author !== undefined ? { author: input.author } : {}),
                    ...(input.authors !== undefined ? { authors: input.authors } : {}),
                    ...(input.reviewRequested !== undefined
                      ? { reviewRequested: input.reviewRequested }
                      : {}),
                    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
                    ...(input.baseBranches !== undefined
                      ? { baseBranches: input.baseBranches }
                      : {}),
                    ...(input.headBranch !== undefined ? { headBranch: input.headBranch } : {}),
                    ...(input.headBranches !== undefined
                      ? { headBranches: input.headBranches }
                      : {}),
                    ...(input.label !== undefined ? { label: input.label } : {}),
                    ...(input.labels !== undefined ? { labels: input.labels } : {}),
                    ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
                    ...(input.assignees !== undefined ? { assignees: input.assignees } : {}),
                    ...(input.draft === true ? { draft: true } : {}),
                    ...(input.columns !== undefined ? { columns: input.columns } : {}),
                    ...(input.checks !== undefined ? { checks: input.checks } : {}),
                    ...(input.sort !== undefined ? { sort: input.sort } : {}),
                    data: usesExpandedPullRequestListCache(input, cacheIdentity.login)
                      ? slicePullRequestListResult(cacheData, input)
                      : cacheData,
                    fetchedAt,
                  }),
                ),
              ),
          ),
        ),
      ),
      Effect.catch((error: unknown) =>
        Effect.logWarning(`ReviewSource.refreshPullRequestList failed: ${String(error)}`),
      ),
    );

  const refreshPullRequestOverview = (
    input: Parameters<ReviewSourceShape["loadPullRequest"]>[0],
    repositoryId: string,
    tokenIdentity: string,
  ) =>
    loadPullRequestUncached(input).pipe(
      Effect.flatMap((data) =>
        cacheWriteClock.pipe(
          Effect.flatMap((fetchedAt) =>
            cacheStore
              .upsertPullRequestOverview({
                repositoryId,
                reference: input.reference,
                data,
                fetchedAt,
                ttlMs: REVIEW_CACHE_TTL_MS,
                tokenIdentity,
              })
              .pipe(
                Effect.andThen(
                  reviewUpdateBus.publish({
                    _tag: "pullRequestOverview",
                    cwd: input.cwd,
                    repositoryId,
                    reference: input.reference,
                    data,
                    fetchedAt,
                  }),
                ),
              ),
          ),
        ),
      ),
      Effect.catch((error: unknown) =>
        Effect.logWarning(`ReviewSource.refreshPullRequestOverview failed: ${String(error)}`),
      ),
    );

  const refreshPullRequestConversation = (
    input: Parameters<ReviewSourceShape["loadConversation"]>[0],
    repositoryId: string,
    tokenIdentity: string,
  ) =>
    loadConversationUncached(input).pipe(
      Effect.flatMap((data) =>
        cacheWriteClock.pipe(
          Effect.flatMap((fetchedAt) =>
            cacheStore
              .upsertPullRequestConversation({
                repositoryId,
                reference: input.reference,
                data,
                fetchedAt,
                ttlMs: REVIEW_CACHE_TTL_MS,
                tokenIdentity,
              })
              .pipe(
                Effect.andThen(
                  reviewUpdateBus.publish({
                    _tag: "pullRequestConversation",
                    cwd: input.cwd,
                    repositoryId,
                    reference: input.reference,
                    data,
                    fetchedAt,
                  }),
                ),
              ),
          ),
        ),
      ),
      Effect.catch((error: unknown) =>
        Effect.logWarning(`ReviewSource.refreshPullRequestConversation failed: ${String(error)}`),
      ),
    );

  const refreshPullRequestChangeset = (
    cwd: string,
    source: Extract<ReviewSourceRef, { _tag: "pullRequest" }>,
    repositoryId: string,
    tokenIdentity: string,
  ) =>
    readHeadSha(cwd, source.reference).pipe(
      Effect.flatMap((headSha) =>
        headSha.length > 0
          ? loadPullRequestChangesetUncached(cwd, source, headSha).pipe(
              Effect.flatMap((data) =>
                cacheWriteClock.pipe(
                  Effect.flatMap((fetchedAt) =>
                    cacheStore
                      .upsertPullRequestChangeset({
                        repositoryId,
                        reference: source.reference,
                        headSha,
                        data,
                        fetchedAt,
                        ttlMs: REVIEW_CACHE_TTL_MS,
                        tokenIdentity,
                      })
                      .pipe(
                        Effect.andThen(
                          reviewUpdateBus.publish({
                            _tag: "pullRequestChangeset",
                            cwd,
                            repositoryId,
                            reference: source.reference,
                            data: ensureChangesetPatchSignature(data),
                            fetchedAt,
                          }),
                        ),
                      ),
                  ),
                ),
              ),
            )
          : Effect.void,
      ),
      Effect.catch((error: unknown) =>
        Effect.logWarning(`ReviewSource.refreshPullRequestChangeset failed: ${String(error)}`),
      ),
    );

  const runAgentReview: ReviewSourceShape["runAgentReview"] = (input) =>
    Effect.gen(function* () {
      const pullRequestOverviewFiber =
        input.source._tag === "pullRequest"
          ? yield* loadPullRequest({ cwd: input.cwd, reference: input.source.reference }).pipe(
              Effect.catch(() => Effect.succeed(null)),
              Effect.forkChild,
            )
          : null;
      let pullRequestOverviewJoined = false;
      const interruptPullRequestOverview =
        pullRequestOverviewFiber === null
          ? Effect.void
          : Effect.gen(function* () {
              if (!pullRequestOverviewJoined) {
                yield* Fiber.interrupt(pullRequestOverviewFiber).pipe(Effect.ignore);
              }
            });

      return yield* Effect.gen(function* () {
        const changeset = yield* loadChangeset({ cwd: input.cwd, source: input.source });
        const currentPatchSignature = changeset.patchSignature ?? patchSignature(changeset.patch);
        const currentPatchSource = changeset.patchSource ?? "github";
        const headMoved =
          input.expectedHeadSha !== undefined &&
          changeset.headSha !== undefined &&
          changeset.headSha !== input.expectedHeadSha;
        const patchChanged =
          input.expectedPatchSignature !== undefined &&
          currentPatchSignature !== input.expectedPatchSignature;
        if (headMoved || patchChanged) {
          return {
            summary: "",
            findings: [],
            ...(changeset.headSha ? { reviewedHeadSha: changeset.headSha } : {}),
            patchSignature: currentPatchSignature,
            patchSource: currentPatchSource,
            totalFindings: 0,
            anchoredFindings: 0,
            droppedFindings: 0,
            headMoved,
            patchChanged,
            warnings: ["The pull request changed before the agent review could run."],
          };
        }
        if (changeset.patch.trim().length === 0) {
          return {
            summary: "",
            findings: [],
            ...(changeset.headSha ? { reviewedHeadSha: changeset.headSha } : {}),
            patchSignature: currentPatchSignature,
            patchSource: currentPatchSource,
            totalFindings: 0,
            anchoredFindings: 0,
            droppedFindings: 0,
          };
        }
        let pullRequestOverview: ReviewPullRequestOverview | null = null;
        if (pullRequestOverviewFiber !== null) {
          pullRequestOverview = yield* Fiber.join(pullRequestOverviewFiber);
          pullRequestOverviewJoined = true;
        }

        const generated = yield* textGeneration.generateReviewFindings({
          cwd: input.cwd,
          patch: changeset.patch,
          ...(changeset.pullRequest ? { prTitle: changeset.pullRequest.title } : {}),
          ...(pullRequestOverview ? { prBody: pullRequestOverview.detail.body } : {}),
          ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
          ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
          ...(input.textGenerationModel ? { model: input.textGenerationModel } : {}),
        });
        const filtered = filterAnchorableFindings(changeset.patch, generated.findings);
        const findings = filtered.findings.map((finding) => ({
          ...finding,
          id: finding.id ?? findingId({ patchSignature: currentPatchSignature, finding }),
        }));
        const warnings = [
          ...(currentPatchSource === "localFallback"
            ? ["GitHub diff could not be loaded, so the agent reviewed a local fallback diff."]
            : []),
          ...(filtered.droppedFindings > 0
            ? [
                `${String(filtered.droppedFindings)} finding(s) were dropped because they did not anchor to the current patch.`,
              ]
            : []),
        ];

        return {
          summary: generated.summary,
          findings,
          ...(changeset.headSha ? { reviewedHeadSha: changeset.headSha } : {}),
          patchSignature: currentPatchSignature,
          patchSource: currentPatchSource,
          totalFindings: generated.findings.length,
          anchoredFindings: findings.length,
          droppedFindings: filtered.droppedFindings,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      }).pipe(Effect.ensuring(interruptPullRequestOverview));
    });

  const generateWalkthrough: ReviewSourceShape["generateWalkthrough"] = (input) =>
    Effect.gen(function* () {
      const pullRequestOverviewFiber =
        input.source._tag === "pullRequest"
          ? yield* loadPullRequest({ cwd: input.cwd, reference: input.source.reference }).pipe(
              Effect.catch(() => Effect.succeed(null)),
              Effect.forkChild,
            )
          : null;
      let pullRequestOverviewJoined = false;
      const interruptPullRequestOverview =
        pullRequestOverviewFiber === null
          ? Effect.void
          : Effect.gen(function* () {
              if (!pullRequestOverviewJoined) {
                yield* Fiber.interrupt(pullRequestOverviewFiber).pipe(Effect.ignore);
              }
            });

      return yield* Effect.gen(function* () {
        const reference = input.source._tag === "pullRequest" ? input.source.reference : undefined;
        const changeset = yield* loadChangeset({ cwd: input.cwd, source: input.source });
        const currentPatchSignature = changeset.patchSignature ?? patchSignature(changeset.patch);
        const currentPatchSource = changeset.patchSource ?? "github";
        const headMoved =
          input.expectedHeadSha !== undefined &&
          changeset.headSha !== undefined &&
          changeset.headSha !== input.expectedHeadSha;
        const patchChanged =
          input.expectedPatchSignature !== undefined &&
          currentPatchSignature !== input.expectedPatchSignature;
        const now = yield* cacheWriteClock;
        if (headMoved || patchChanged) {
          return {
            walkthrough: emptyWalkthrough(
              currentPatchSignature,
              currentPatchSource,
              changeset.headSha,
              new Date(now).toISOString(),
            ),
            ...(changeset.headSha ? { reviewedHeadSha: changeset.headSha } : {}),
            patchSignature: currentPatchSignature,
            patchSource: currentPatchSource,
            headMoved,
            patchChanged,
            warnings: ["The pull request changed before the walkthrough could be generated."],
          };
        }

        const repositoryId = reference !== undefined ? yield* resolveRepositoryId(input.cwd) : null;
        const walkthroughTokenIdentity =
          repositoryId !== null && reference !== undefined
            ? yield* readCacheTokenIdentity(input.cwd)
            : null;
        if (repositoryId !== null && reference !== undefined && walkthroughTokenIdentity !== null) {
          const cached = yield* cacheStore
            .getPullRequestWalkthrough({
              repositoryId,
              reference,
              patchSignature: currentPatchSignature,
              tokenIdentity: walkthroughTokenIdentity,
            })
            .pipe(Effect.catch(() => Effect.succeed(Option.none())));
          if (Option.isSome(cached)) {
            return {
              walkthrough: cached.value,
              ...(changeset.headSha ? { reviewedHeadSha: changeset.headSha } : {}),
              patchSignature: currentPatchSignature,
              patchSource: currentPatchSource,
              headMoved: false,
              patchChanged: false,
            };
          }
        }

        if (changeset.patch.trim().length === 0) {
          return {
            walkthrough: emptyWalkthrough(
              currentPatchSignature,
              currentPatchSource,
              changeset.headSha,
              new Date(now).toISOString(),
            ),
            ...(changeset.headSha ? { reviewedHeadSha: changeset.headSha } : {}),
            patchSignature: currentPatchSignature,
            patchSource: currentPatchSource,
            headMoved: false,
            patchChanged: false,
          };
        }

        let pullRequestOverview: ReviewPullRequestOverview | null = null;
        if (pullRequestOverviewFiber !== null) {
          pullRequestOverview = yield* Fiber.join(pullRequestOverviewFiber);
          pullRequestOverviewJoined = true;
        }

        const files = parseUnifiedDiffHunks(changeset.patch);
        const hunksSummary = formatHunksSummary(files);

        const generated = yield* textGeneration.generateWalkthrough({
          cwd: input.cwd,
          patch: changeset.patch,
          ...(hunksSummary.length > 0 ? { hunksSummary } : {}),
          ...(changeset.pullRequest ? { prTitle: changeset.pullRequest.title } : {}),
          ...(pullRequestOverview ? { prBody: pullRequestOverview.detail.body } : {}),
          ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
          ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
          ...(input.textGenerationModel ? { model: input.textGenerationModel } : {}),
        });

        const reconciled = reconcileChapterCoverage(files, generated.chapters);
        const generatedAt = new Date(yield* cacheWriteClock).toISOString();
        const walkthrough: ReviewWalkthrough = {
          prologue: generated.prologue,
          chapters: reconciled.chapters,
          ...(changeset.headSha ? { reviewedHeadSha: changeset.headSha } : {}),
          patchSignature: currentPatchSignature,
          patchSource: currentPatchSource,
          generatedAt,
        };

        if (repositoryId !== null && reference !== undefined && walkthroughTokenIdentity !== null) {
          const fetchedAt = yield* cacheWriteClock;
          yield* cacheStore
            .upsertPullRequestWalkthrough({
              repositoryId,
              reference,
              patchSignature: currentPatchSignature,
              tokenIdentity: walkthroughTokenIdentity,
              data: walkthrough,
              fetchedAt,
            })
            .pipe(Effect.ignore);
          yield* reviewUpdateBus.publish({
            _tag: "pullRequestWalkthrough",
            cwd: input.cwd,
            repositoryId,
            reference,
            data: walkthrough,
            fetchedAt,
          });
        }

        const warnings = [
          ...(currentPatchSource === "localFallback"
            ? ["GitHub diff could not be loaded, so the walkthrough covers a local fallback diff."]
            : []),
          ...reconciled.warnings,
        ];

        return {
          walkthrough,
          ...(changeset.headSha ? { reviewedHeadSha: changeset.headSha } : {}),
          patchSignature: currentPatchSignature,
          patchSource: currentPatchSource,
          headMoved: false,
          patchChanged: false,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      }).pipe(Effect.ensuring(interruptPullRequestOverview));
    });

  const mapProjectScopeError =
    (operation: string) =>
    (error: GitHubCliError): ReviewServiceError =>
      isProjectScopeMissing(error.message)
        ? reviewError(operation, PROJECT_ACCESS_DETAIL, error)
        : error;

  const checkProjectAccess: ReviewSourceShape["checkProjectAccess"] = (input) =>
    gitHubCli.projectScopeAvailable({ cwd: input.cwd }).pipe(
      Effect.map((hasProjectScope) => ({ hasProjectScope })),
      Effect.catchTag("GitHubCliError", (error) =>
        isProjectScopeMissing(error.message)
          ? Effect.succeed({ hasProjectScope: false })
          : Effect.fail(error),
      ),
    );

  const listProjects: ReviewSourceShape["listProjects"] = (input) =>
    gitHubCli.listProjects({ cwd: input.cwd, ...(input.owner ? { owner: input.owner } : {}) }).pipe(
      Effect.map((projects) => ({
        projects: projects
          .map(toProjectSummary)
          .filter((summary): summary is ReviewProjectSummary => summary !== null),
      })),
      Effect.mapError(mapProjectScopeError("listProjects")),
    );

  const getProjectBoard: ReviewSourceShape["getProjectBoard"] = (input) =>
    gitHubCli
      .getProjectBoard({ cwd: input.cwd, owner: input.owner, number: input.number })
      .pipe(Effect.map(toProjectBoard), Effect.mapError(mapProjectScopeError("getProjectBoard")));

  const moveProjectCard: ReviewSourceShape["moveProjectCard"] = (input) =>
    gitHubCli
      .moveProjectCard({
        cwd: input.cwd,
        projectId: input.projectId,
        itemId: input.itemId,
        fieldId: input.fieldId,
        optionId: input.optionId,
      })
      .pipe(Effect.as({ ok: true }), Effect.mapError(mapProjectScopeError("moveProjectCard")));

  return {
    listPullRequests,
    loadBoardLanes,
    getViewer,
    loadChangeset,
    loadPullRequest,
    loadPullRequestHeader,
    loadConversation,
    loadPullRequestSurface,
    runAgentReview,
    generateWalkthrough,
    checkProjectAccess,
    listProjects,
    getProjectBoard,
    moveProjectCard,
  } satisfies ReviewSourceShape;
});

function canonicalizePath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

export const ReviewSourceLive = Layer.effect(ReviewSource, makeReviewSource);
