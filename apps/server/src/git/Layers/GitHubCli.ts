// Purpose: GitHubCliLive layer — wires the `gh` CLI into the GitHubCli service.
// Layer: Layer.effect(GitHubCli, makeGitHubCli). Owns process execution + per-method `gh` invocations.
// Exports: GitHubCliLive (only external consumer; runtimeLayer.ts).
// Parsing/normalization lives in GitHubCli.parsing.ts; raw schemas/constants in GitHubCli.types.ts;
// execute-parameterized pagination/avatar helpers in GitHubCli.commands.ts.

import { Effect, Layer, Schema } from "effect";
import { parsePullRequestUrl } from "@t3tools/shared/git";

import { runProcess } from "../../processRunner";
import {
  GitHubCli,
  type GitHubCliShape,
  type GitHubProjectBoardData,
  type GitHubProjectItem,
  type GitHubProjectSummary,
  type GitHubReviewThread,
} from "../Services/GitHubCli.ts";
import {
  decodeGitHubJson,
  findStatusField,
  isProjectScopeError,
  normalizeAvatarUrl,
  normalizeConversation,
  normalizeCreateReviewResult,
  normalizeGitHubCliError,
  normalizeProjectItem,
  normalizeProjectSummary,
  normalizePullRequestSummary,
  normalizeRepositoryCloneUrls,
  normalizeReviewChecks,
  normalizeReviewCommit,
  normalizeReviewDetail,
  normalizeReviewPullRequest,
  reviewEventFlag,
  reviewEventName,
} from "./GitHubCli.parsing.ts";
import { enrichConversationAvatars, fetchPullRequestReviewThreads } from "./GitHubCli.commands.ts";
import {
  DEFAULT_REVIEW_PULL_REQUEST_LIST_LIMIT,
  DEFAULT_TIMEOUT_MS,
  DIFF_TIMEOUT_MS,
  PROJECT_ITEM_LIMIT,
  RawCreateReviewResponseSchema,
  RawGitHubConversationSchema,
  RawGitHubPullRequestSchema,
  RawGitHubRepositoryCloneUrlsSchema,
  RawGitHubReviewDetailSchema,
  RawGitHubReviewPullRequestSchema,
  RawProjectFieldListSchema,
  RawProjectItemListSchema,
  RawProjectListSchema,
} from "./GitHubCli.types.ts";

function optionalTrimmed(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizedSearchValues(values: ReadonlyArray<string> | undefined): ReadonlyArray<string> {
  return [...new Set((values ?? []).map((value) => value.trim()))]
    .filter((value) => value.length > 0)
    .sort();
}

function isSafeSearchQualifierValue(value: string): boolean {
  return !/[\s,"\\()]/.test(value) && !/^(AND|OR|NOT)$/i.test(value);
}

function mergedSearchValues(
  value: string | undefined,
  values: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  return normalizedSearchValues([...(value !== undefined ? [value] : []), ...(values ?? [])]);
}

function searchQualifierOrGroup(
  qualifier: string,
  values: ReadonlyArray<string> | undefined,
): string | null {
  const normalized = normalizedSearchValues(values);
  if (
    normalized.length === 0 ||
    normalized.some((value) => !isSafeSearchQualifierValue(value))
  ) {
    return null;
  }
  const terms = normalized.map((value) => `${qualifier}:${value}`);
  return terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`;
}

function pullRequestListSearch(input: {
  readonly search?: string;
  readonly authors?: ReadonlyArray<string>;
  readonly reviewRequested?: string;
  readonly baseBranches?: ReadonlyArray<string>;
  readonly headBranches?: ReadonlyArray<string>;
  readonly labels?: ReadonlyArray<string>;
  readonly assignees?: ReadonlyArray<string>;
  readonly checksStatuses?: ReadonlyArray<"passing" | "failing">;
  readonly reviewStatus?: "approved" | "changes-requested";
}): string | null {
  const search = optionalTrimmed(input.search);
  const reviewRequested = optionalTrimmed(input.reviewRequested);
  const authorsSearch = searchQualifierOrGroup("author", input.authors);
  const baseBranchesSearch = searchQualifierOrGroup("base", input.baseBranches);
  const headBranchesSearch = searchQualifierOrGroup("head", input.headBranches);
  const labelSearch = pullRequestLabelSearch(input.labels);
  const assigneesSearch = searchQualifierOrGroup("assignee", input.assignees);
  const checksStatusTerms = [...new Set(input.checksStatuses ?? [])]
    .map((status) => (status === "passing" ? "status:success" : "status:failure"))
    .sort();
  const checksStatusSearch =
    checksStatusTerms.length === 0
      ? null
      : checksStatusTerms.length === 1
        ? checksStatusTerms[0]
        : `(${checksStatusTerms.join(" OR ")})`;
  const reviewStatusSearch =
    input.reviewStatus === "approved"
      ? "review:approved"
      : input.reviewStatus === "changes-requested"
        ? "review:changes_requested"
        : null;
  return [
    search,
    authorsSearch,
    reviewRequested ? `review-requested:${reviewRequested}` : null,
    baseBranchesSearch,
    headBranchesSearch,
    labelSearch,
    assigneesSearch,
    checksStatusSearch,
    reviewStatusSearch,
  ]
    .filter((value): value is string => value !== null)
    .join(" ") || null;
}

function pullRequestLabelSearch(labels: ReadonlyArray<string> | undefined): string | null {
  const normalized = normalizedSearchValues(labels);
  if (
    normalized.length === 0 ||
    normalized.some(
      (label) => label.includes(",") || label.includes("\"") || label.includes("\\"),
    )
  ) {
    return null;
  }
  return `label:${normalized.map((label) => `"${label}"`).join(",")}`;
}

function repositoryPullRequestListArgs(input: {
  readonly state: "open" | "closed" | "merged" | "all";
  readonly limit?: number;
  readonly search?: string;
  readonly author?: string;
  readonly authors?: ReadonlyArray<string>;
  readonly reviewRequested?: string;
  readonly baseBranch?: string;
  readonly baseBranches?: ReadonlyArray<string>;
  readonly headBranch?: string;
  readonly headBranches?: ReadonlyArray<string>;
  readonly label?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly assignee?: string;
  readonly assignees?: ReadonlyArray<string>;
  readonly draft?: boolean;
  readonly checksStatuses?: ReadonlyArray<"passing" | "failing">;
  readonly reviewStatus?: "approved" | "changes-requested";
}): string[] {
  const args = [
    "pr",
    "list",
    "--state",
    input.state,
    "--limit",
    String(input.limit ?? DEFAULT_REVIEW_PULL_REQUEST_LIST_LIMIT),
  ];
  const authors = mergedSearchValues(input.author, input.authors);
  const baseBranches = mergedSearchValues(input.baseBranch, input.baseBranches);
  const headBranches = mergedSearchValues(input.headBranch, input.headBranches);
  const labels = mergedSearchValues(input.label, input.labels);
  const assignees = mergedSearchValues(input.assignee, input.assignees);
  if (authors.length === 1) {
    args.push("--author", authors[0]);
  }
  if (assignees.length === 1) {
    args.push("--assignee", assignees[0]);
  }
  if (baseBranches.length === 1) {
    args.push("--base", baseBranches[0]);
  }
  if (headBranches.length === 1 && !headBranches[0].includes(":")) {
    args.push("--head", headBranches[0]);
  }
  if (labels.length === 1) {
    args.push("--label", labels[0]);
  }
  if (input.draft === true) {
    args.push("--draft");
  }
  const search = pullRequestListSearch({
    search: input.search,
    reviewRequested: input.reviewRequested,
    ...(authors.length > 1 ? { authors } : {}),
    ...(baseBranches.length > 1 ? { baseBranches } : {}),
    ...(headBranches.length > 1 || headBranches[0]?.includes(":") ? { headBranches } : {}),
    ...(labels.length > 1 ? { labels } : {}),
    ...(assignees.length > 1 ? { assignees } : {}),
    checksStatuses: input.checksStatuses,
    reviewStatus: input.reviewStatus,
  });
  if (search) {
    args.push("--search", search);
  }
  const jsonFields = [
    "number",
    "title",
    "author",
    "updatedAt",
    "state",
    "mergedAt",
    "reviewDecision",
    "baseRefName",
    "headRefName",
    "headRepositoryOwner",
    "url",
    "isDraft",
    "additions",
    "deletions",
    "statusCheckRollup",
    "labels",
    "assignees",
    ...(optionalTrimmed(input.reviewRequested) ? ["reviewRequests"] : []),
  ];
  args.push(
    "--json",
    jsonFields.join(","),
  );
  return args;
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
        args: repositoryPullRequestListArgs(input),
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
        Effect.map(normalizeCreateReviewResult),
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
