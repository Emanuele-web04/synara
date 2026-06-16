import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import {
  type ReviewChangedFile,
  type ReviewChangesetResult,
  type ReviewFinding,
  type ReviewListPullRequestsInput,
  type ReviewListPullRequestsResult,
  type ReviewProjectCard,
  type ReviewProjectColumn,
  type ReviewProjectSummary,
  type ReviewPullRequestOverview,
  type ReviewPullRequestSummary,
  type ReviewSourceRef,
  type ReviewTargetKey,
  type ReviewTimelineEvent,
} from "@t3tools/contracts";
import { Clock, Effect, Fiber, Layer, Option } from "effect";

import type { GitHubCliError } from "../../git/Errors.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import {
  GitHubCli,
  type GitHubProjectBoardData,
  type GitHubProjectSummary,
  type GitHubReviewPullRequest,
} from "../../git/Services/GitHubCli.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { ReviewError, type ReviewServiceError } from "../Errors.ts";
import { parseUnifiedDiff } from "../parseUnifiedDiff.ts";
import { ReviewCacheStore, type ReviewCacheEnvelope } from "../Services/ReviewCacheStore.ts";
import { ReviewSource, type ReviewSourceShape } from "../Services/ReviewSource.ts";
import { ReviewUpdateBus } from "../Services/ReviewUpdateBus.ts";
import { validateInlineComments } from "../validateInlineComments.ts";

const PROJECT_ACCESS_DETAIL =
  "GitHub Projects access is not granted. Run `gh auth refresh -s project` and retry.";
const REVIEW_CACHE_TTL_MS = 30_000;
const REVIEW_CACHE_TOKEN_IDENTITY_PREFIX = "gh-user-v1";
const REVIEW_ANCHOR_KEY_SEPARATOR = "\u0000";
const DEFAULT_REVIEW_LIST_RESULT_LIMIT = 50;
const MAX_REVIEW_LIST_RESULT_LIMIT = 100;
const FILTERED_REVIEW_LIST_CANDIDATE_LIMIT = 1_000;
const inFlightRefreshKeys = new Set<string>();

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

function reviewColumn(summary: ReviewPullRequestSummary): string {
  if (summary.isDraft) {
    return "draft";
  }
  if (summary.state === "merged") {
    return "merged";
  }
  if (summary.reviewDecision === "CHANGES_REQUESTED") {
    return "changes-requested";
  }
  if (summary.reviewDecision === "APPROVED") {
    return "approved";
  }
  return "needs-review";
}

function matchesListFilters(
  summary: ReviewPullRequestSummary,
  input: ReviewListPullRequestsInput,
  viewerLogin: string,
): boolean {
  const author = resolveViewerAlias(normalizeOptionalText(input.author), viewerLogin);
  const reviewRequested = resolveViewerAlias(
    normalizeOptionalText(input.reviewRequested),
    viewerLogin,
  );
  const baseBranch = normalizeOptionalText(input.baseBranch);
  const headBranch = normalizeOptionalText(input.headBranch);
  const label = normalizeOptionalText(input.label);
  const labels = normalizedSet(input.labels);
  const assignee = resolveViewerAlias(normalizeOptionalText(input.assignee), viewerLogin);
  const columns = normalizedSet(input.columns);
  const checks = normalizedSet(input.checks);
  return (
    (!author || summary.author === author) &&
    (!reviewRequested || summary.reviewRequests.includes(reviewRequested)) &&
    (!baseBranch || summary.baseBranch === baseBranch) &&
    (!headBranch || summary.headBranch === headBranch || summary.headSelector === headBranch) &&
    (!label || summary.labels.includes(label)) &&
    (labels.size === 0 || summary.labels.some((summaryLabel) => labels.has(summaryLabel))) &&
    (!assignee || summary.assignees.includes(assignee)) &&
    (input.draft !== true || summary.isDraft) &&
    (columns.size === 0 || columns.has(reviewColumn(summary))) &&
    (checks.size === 0 || checks.has(summary.checksStatus))
  );
}

function hasLocalListFilters(input: ReviewListPullRequestsInput): boolean {
  const nativeReviewStatus = nativeListReviewStatus(input.columns);
  const nativeLabels = nativeListLabels(input.labels);
  const localLabels = [...normalizedSet(input.labels)].filter(
    (label) => !nativeLabels.includes(label),
  );
  const localColumns = [...normalizedSet(input.columns)].filter(
    (column) =>
      (column !== "draft" || input.draft !== true) && column !== nativeReviewStatus,
  );
  const nativeChecksStatuses = nativeListChecksStatuses(input.checks);
  const localChecks = [...normalizedSet(input.checks)].filter(
    (check) => !nativeChecksStatuses.includes(check as "passing" | "failing"),
  );
  return localLabels.length > 0 || localColumns.length > 0 || localChecks.length > 0;
}

function nativeListLabels(labels: ReadonlyArray<string> | undefined): ReadonlyArray<string> {
  const normalized = [...normalizedSet(labels)].sort();
  if (
    normalized.length === 0 ||
    normalized.some(
      (label) => label.includes(",") || label.includes("\"") || label.includes("\\"),
    )
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
): ReadonlyArray<"passing" | "failing"> {
  const normalized = [...normalizedSet(checks)];
  const nativeStatuses: Array<"passing" | "failing"> = [];
  for (const check of normalized) {
    if (check === "passing" || check === "failing") {
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

function githubListLimit(input: ReviewListPullRequestsInput): number | undefined {
  if (!hasLocalListFilters(input)) {
    return resultListLimit(input);
  }
  return Math.max(resultListLimit(input), FILTERED_REVIEW_LIST_CANDIDATE_LIMIT);
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

function pullRequestListFilter(input: {
  readonly state?: string | undefined;
  readonly limit?: number | undefined;
  readonly search?: string | undefined;
  readonly author?: string | undefined;
  readonly reviewRequested?: string | undefined;
  readonly baseBranch?: string | undefined;
  readonly headBranch?: string | undefined;
  readonly label?: string | undefined;
  readonly labels?: ReadonlyArray<string> | undefined;
  readonly assignee?: string | undefined;
  readonly draft?: boolean | undefined;
  readonly columns?: ReadonlyArray<string> | undefined;
  readonly checks?: ReadonlyArray<string> | undefined;
}): string {
  return JSON.stringify({
    state: input.state ?? "open",
    limit: normalizedResultListLimit(input.limit),
    search: normalizeOptionalText(input.search),
    author: normalizeOptionalText(input.author),
    reviewRequested: normalizeOptionalText(input.reviewRequested),
    baseBranch: normalizeOptionalText(input.baseBranch),
    headBranch: normalizeOptionalText(input.headBranch),
    label: normalizeOptionalText(input.label),
    labels: [...normalizedSet(input.labels)].sort(),
    assignee: normalizeOptionalText(input.assignee),
    draft: input.draft === true ? true : null,
    columns: [...normalizedSet(input.columns)].sort(),
    checks: [...normalizedSet(input.checks)].sort(),
  });
}

function isUsableCacheEnvelope<T>(
  envelope: ReviewCacheEnvelope<T>,
  tokenIdentity: string,
): boolean {
  return envelope.tokenIdentity === tokenIdentity;
}

const makeReviewSource = Effect.gen(function* () {
  const cacheStore = yield* ReviewCacheStore;
  const gitCore = yield* GitCore;
  const gitHubCli = yield* GitHubCli;
  const gitManager = yield* GitManager;
  const reviewUpdateBus = yield* ReviewUpdateBus;
  const textGeneration = yield* TextGeneration;

  const readCacheIdentity = (cwd: string) =>
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

  const readCacheTokenIdentity = (cwd: string) =>
    readCacheIdentity(cwd).pipe(Effect.map((identity) => identity.tokenIdentity));

  const resolveRepositoryId = (cwd: string) =>
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

  const listPullRequestsUncached = (input: ReviewListPullRequestsInput, viewerLogin: string) => {
    const listLimit = githubListLimit(input);
    const labels = nativeListLabels(input.labels);
    const reviewStatus = nativeListReviewStatus(input.columns);
    const checksStatuses = nativeListChecksStatuses(input.checks);
    return gitHubCli
      .listRepositoryPullRequests({
        cwd: input.cwd,
        state: input.state ?? "open",
        ...(listLimit !== undefined ? { limit: listLimit } : {}),
        ...(input.search !== undefined ? { search: input.search } : {}),
        ...(input.author !== undefined ? { author: input.author } : {}),
        ...(input.reviewRequested !== undefined ? { reviewRequested: input.reviewRequested } : {}),
        ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
        ...(input.headBranch !== undefined ? { headBranch: input.headBranch } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(labels.length > 0 ? { labels } : {}),
        ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
        ...(input.draft === true ? { draft: true } : {}),
        ...(reviewStatus !== undefined ? { reviewStatus } : {}),
        ...(checksStatuses.length > 0 ? { checksStatuses } : {}),
      })
      .pipe(
        Effect.map((pullRequests): ReviewListPullRequestsResult => {
          const summaries = pullRequests
            .map(toPullRequestSummary)
            .filter((summary): summary is ReviewPullRequestSummary => summary !== null)
            .filter((summary) => matchesListFilters(summary, input, viewerLogin));
          const usesLocalCandidateWindow = hasLocalListFilters(input);
          const candidateLimit = listLimit ?? resultListLimit(input);
          const resultLimit = resultListLimit(input);
          const returnedPullRequests = usesLocalCandidateWindow
            ? summaries.slice(0, resultLimit)
            : summaries;
          return {
            pullRequests: returnedPullRequests,
            ...(candidateLimit !== undefined
              ? {
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
                }
              : {}),
          };
        }),
      );
  };

  const cacheWriteClock = Clock.currentTimeMillis;

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

  const listPullRequests: ReviewSourceShape["listPullRequests"] = (input) =>
    Effect.gen(function* () {
      const repositoryId = yield* resolveRepositoryId(input.cwd);
      const cacheIdentity = yield* readCacheIdentity(input.cwd);
      const listFilter = pullRequestListFilter(input);
      const cached = yield* cacheStore
        .getPullRequestList({ repositoryId, listFilter })
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isSome(cached) && isUsableCacheEnvelope(cached.value, cacheIdentity.tokenIdentity)) {
        yield* forkRefreshIfStale(
          `pr-list:${repositoryId}:${listFilter}`,
          cached.value,
          refreshPullRequestList(input, repositoryId, listFilter, cacheIdentity),
        );
        return cached.value.data;
      }
      const data = yield* listPullRequestsUncached(input, cacheIdentity.login).pipe(
        Effect.mapError((error) =>
          reviewError("listPullRequests", `Could not list pull requests: ${error.message}`, error),
        ),
      );
      const fetchedAt = yield* cacheWriteClock;
      yield* cacheStore
        .upsertPullRequestList({
          repositoryId,
          listFilter,
          data,
          fetchedAt,
          ttlMs: REVIEW_CACHE_TTL_MS,
          tokenIdentity: cacheIdentity.tokenIdentity,
        })
        .pipe(Effect.ignore);
      return data;
    });

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
      if (Option.isSome(cached) && isUsableCacheEnvelope(cached.value, tokenIdentity)) {
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

  const loadConversationUncached: ReviewSourceShape["loadConversation"] = (input) =>
    gitHubCli.getReviewConversation({ cwd: input.cwd, reference: input.reference }).pipe(
      Effect.map((events) => ({
        events: events.map((event): ReviewTimelineEvent => {
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
        }),
      })),
    );

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

  const refreshPullRequestList = (
    input: Parameters<ReviewSourceShape["listPullRequests"]>[0],
    repositoryId: string,
    listFilter: string,
    cacheIdentity: { readonly login: string; readonly tokenIdentity: string },
  ) =>
    listPullRequestsUncached(input, cacheIdentity.login).pipe(
      Effect.flatMap((data) =>
        cacheWriteClock.pipe(
          Effect.flatMap((fetchedAt) =>
            cacheStore
              .upsertPullRequestList({
                repositoryId,
                listFilter,
                data,
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
                    ...(input.reviewRequested !== undefined
                      ? { reviewRequested: input.reviewRequested }
                      : {}),
                    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
                    ...(input.headBranch !== undefined ? { headBranch: input.headBranch } : {}),
                    ...(input.label !== undefined ? { label: input.label } : {}),
                    ...(input.labels !== undefined ? { labels: input.labels } : {}),
                    ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
                    ...(input.draft === true ? { draft: true } : {}),
                    ...(input.columns !== undefined ? { columns: input.columns } : {}),
                    ...(input.checks !== undefined ? { checks: input.checks } : {}),
                    data,
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
    getViewer,
    loadChangeset,
    loadPullRequest,
    loadConversation,
    runAgentReview,
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
