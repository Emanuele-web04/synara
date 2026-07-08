import { Effect, Layer, Schema } from "effect";
import {
  PositiveInt,
  TrimmedNonEmptyString,
  type GitPullRequestCheck,
  type GitPullRequestCheckStatus,
  type GitPullRequestComment,
} from "@t3tools/contracts";

import { runProcess } from "../../processRunner";
import { GitHubCliError } from "../Errors.ts";
import {
  GitHubCli,
  PULL_REQUEST_SUMMARY_JSON_FIELDS,
  type GitHubRepositoryCloneUrls,
  type GitHubCliShape,
  type GitHubPullRequestSummary,
} from "../Services/GitHubCli.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

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

// GitHub reports MERGEABLE/CONFLICTING/UNKNOWN; UNKNOWN also stands in for the
// transient window right after a push while GitHub recomputes mergeability.
function normalizePullRequestMergeability(
  mergeable: string | null | undefined,
): "mergeable" | "conflicting" | "unknown" {
  switch (mergeable) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

function normalizeDiffCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
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
  isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  additions: Schema.optional(Schema.NullOr(Schema.Number)),
  deletions: Schema.optional(Schema.NullOr(Schema.Number)),
  changedFiles: Schema.optional(Schema.NullOr(Schema.Number)),
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
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});

// `gh pr view --json statusCheckRollup` mixes CheckRun and StatusContext nodes; both are
// covered by one permissive shape and told apart by which fields are populated.
const RawStatusCheckRollupItemSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  detailsUrl: Schema.optional(Schema.NullOr(Schema.String)),
  targetUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawPullRequestChecksSchema = Schema.Struct({
  statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Array(RawStatusCheckRollupItemSchema))),
});

const RawGitHubPullRequestWithChecksSchema = Schema.Struct({
  ...RawGitHubPullRequestSchema.fields,
  ...RawPullRequestChecksSchema.fields,
});

const PULL_REQUEST_REVIEW_THREAD_PAGE_SIZE = 50;
const PULL_REQUEST_REVIEW_THREAD_PAGE_LIMIT = 5;
const PULL_REQUEST_REVIEW_COMMENT_LIMIT = 20;

// GraphQL review-threads query: resolved threads are filtered after fetch because GitHub's
// reviewThreads connection does not expose an unresolved-only argument.
const PULL_REQUEST_REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: $first, after: $after) {
        nodes {
          isResolved
          comments(first: 1) {
            nodes {
              id
              body
              path
              url
              createdAt
              author { login }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;

const RawGraphQlErrorSchema = Schema.Struct({
  message: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewThreadCommentSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const RawReviewThreadSchema = Schema.Struct({
  isResolved: Schema.optional(Schema.NullOr(Schema.Boolean)),
  comments: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(
          Schema.NullOr(Schema.Array(Schema.NullOr(RawReviewThreadCommentSchema))),
        ),
      }),
    ),
  ),
});

const RawReviewThreadsResponseSchema = Schema.Struct({
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawGraphQlErrorSchema)))),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              pullRequest: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    reviewThreads: Schema.optional(
                      Schema.NullOr(
                        Schema.Struct({
                          nodes: Schema.optional(
                            Schema.NullOr(Schema.Array(Schema.NullOr(RawReviewThreadSchema))),
                          ),
                          pageInfo: Schema.optional(
                            Schema.NullOr(
                              Schema.Struct({
                                hasNextPage: Schema.optional(Schema.NullOr(Schema.Boolean)),
                                endCursor: Schema.optional(Schema.NullOr(Schema.String)),
                              }),
                            ),
                          ),
                        }),
                      ),
                    ),
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
    isDraft: raw.isDraft === true,
    mergeability: normalizePullRequestMergeability(raw.mergeable),
    additions: normalizeDiffCount(raw.additions),
    deletions: normalizeDiffCount(raw.deletions),
    changedFiles: normalizeDiffCount(raw.changedFiles),
    updatedAt: raw.updatedAt?.trim() || null,
    ...(typeof raw.isCrossRepository === "boolean"
      ? { isCrossRepository: raw.isCrossRepository }
      : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

// Maps StatusContext states and CheckRun statuses/conclusions onto the shared check status.
function normalizeCheckStatus(
  item: Schema.Schema.Type<typeof RawStatusCheckRollupItemSchema>,
): GitPullRequestCheckStatus {
  if (typeof item.state === "string" && item.state.length > 0) {
    switch (item.state) {
      case "SUCCESS":
        return "success";
      case "FAILURE":
      case "ERROR":
        return "failure";
      default:
        return "pending";
    }
  }

  if (typeof item.status === "string" && item.status !== "COMPLETED") {
    return "pending";
  }

  switch (item.conclusion) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
      return "failure";
    case "SKIPPED":
      return "skipped";
    case "CANCELLED":
      return "cancelled";
    case "NEUTRAL":
    case "STALE":
      return "neutral";
    default:
      return "pending";
  }
}

function normalizePullRequestChecks(
  raw: Schema.Schema.Type<typeof RawPullRequestChecksSchema>,
): GitPullRequestCheck[] {
  const checks: GitPullRequestCheck[] = [];
  for (const item of raw.statusCheckRollup ?? []) {
    const name = (item.name ?? item.context ?? "").trim();
    if (name.length === 0) {
      continue;
    }
    checks.push({
      name,
      status: normalizeCheckStatus(item),
      url: item.detailsUrl ?? item.targetUrl ?? null,
    });
  }
  return checks;
}

function normalizePullRequestReviewComments(
  raw: Schema.Schema.Type<typeof RawReviewThreadsResponseSchema>,
): GitPullRequestComment[] {
  const threads = raw.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const comments: GitPullRequestComment[] = [];
  for (const thread of threads) {
    if (!thread || thread.isResolved === true) {
      continue;
    }
    const rootComment = thread.comments?.nodes?.find((node) => node !== null) ?? null;
    if (!rootComment) {
      continue;
    }
    comments.push({
      id: rootComment.id,
      author: rootComment.author?.login?.trim() || null,
      body: rootComment.body ?? "",
      path: rootComment.path?.trim() || null,
      url: rootComment.url ?? null,
      createdAt: rootComment.createdAt?.trim() || null,
    });
  }
  return comments;
}

function getGraphQlErrorDetail(
  raw: Schema.Schema.Type<typeof RawReviewThreadsResponseSchema>,
): string | null {
  const messages =
    raw.errors
      ?.flatMap((error) => {
        const message = error?.message?.trim();
        return message ? [message] : [];
      })
      .join("; ") ?? "";
  return messages.length > 0 ? `GitHub GraphQL returned errors: ${messages}` : null;
}

function getPullRequestReviewThreadsPageInfo(
  raw: Schema.Schema.Type<typeof RawReviewThreadsResponseSchema>,
): { hasNextPage: boolean; endCursor: string | null } {
  const pageInfo = raw.data?.repository?.pullRequest?.reviewThreads?.pageInfo;
  return {
    hasNextPage: pageInfo?.hasNextPage === true,
    endCursor: pageInfo?.endCursor?.trim() || null,
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

function decodeGitHubJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation:
    | "listOpenPullRequests"
    | "listPullRequests"
    | "getPullRequest"
    | "getRepositoryCloneUrls"
    | "getPullRequestWithChecks"
    | "getPullRequestReviewComments",
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

const decodeRawPullRequestEntry = Schema.decodeUnknownSync(RawGitHubPullRequestSchema);

/**
 * Decode + normalize a `gh pr list --json` payload. Exported so test fakes parse fixtures
 * through the exact same schema/normalization as the live layer instead of re-implementing it.
 *
 * Entries are decoded individually: one malformed PR (a gh quirk or API oddity) must not
 * hide the healthy PRs in the same list. Only a payload that is not a JSON array fails.
 */
export function decodePullRequestListJson(
  raw: string,
  operation: "listOpenPullRequests" | "listPullRequests" = "listPullRequests",
): Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return Effect.succeed([]);
  }
  return decodeGitHubJson(
    trimmed,
    Schema.Array(Schema.Unknown),
    operation,
    "GitHub CLI returned invalid PR list JSON.",
  ).pipe(
    Effect.map((entries) =>
      entries.flatMap((entry) => {
        try {
          return [normalizePullRequestSummary(decodeRawPullRequestEntry(entry))];
        } catch {
          return [];
        }
      }),
    ),
  );
}

const makeGitHubCli = Effect.sync(() => {
  const execute: GitHubCliShape["execute"] = (input) =>
    Effect.tryPromise({
      try: () =>
        runProcess("gh", input.args, {
          cwd: input.cwd,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }),
      catch: (error) => normalizeGitHubCliError("execute", error),
    });

  // One implementation behind both list methods so the field list, decoding, and
  // normalization cannot drift between the open-only and any-state lookups.
  const listPullRequestsWithState = (
    input: { readonly cwd: string; readonly headSelector: string; readonly limit?: number },
    options: {
      readonly state: "open" | "all";
      readonly defaultLimit: number;
      readonly operation: "listOpenPullRequests" | "listPullRequests";
    },
  ) =>
    execute({
      cwd: input.cwd,
      args: [
        "pr",
        "list",
        "--head",
        input.headSelector,
        "--state",
        options.state,
        "--limit",
        String(input.limit ?? options.defaultLimit),
        "--json",
        PULL_REQUEST_SUMMARY_JSON_FIELDS,
      ],
    }).pipe(
      Effect.flatMap((result) => decodePullRequestListJson(result.stdout, options.operation)),
    );

  const service = {
    execute,
    listOpenPullRequests: (input) =>
      listPullRequestsWithState(input, {
        state: "open",
        defaultLimit: 1,
        operation: "listOpenPullRequests",
      }),
    listPullRequests: (input) =>
      listPullRequestsWithState(input, {
        state: "all",
        defaultLimit: 20,
        operation: "listPullRequests",
      }),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "view", input.reference, "--json", PULL_REQUEST_SUMMARY_JSON_FIELDS],
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
    getPullRequestWithChecks: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          `${PULL_REQUEST_SUMMARY_JSON_FIELDS},statusCheckRollup`,
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubPullRequestWithChecksSchema,
            "getPullRequestWithChecks",
            "GitHub CLI returned invalid pull request JSON.",
          ),
        ),
        Effect.map((decoded) => ({
          summary: normalizePullRequestSummary(decoded),
          checks: normalizePullRequestChecks(decoded),
        })),
      ),
    getPullRequestReviewComments: (input) =>
      Effect.gen(function* () {
        const comments: GitPullRequestComment[] = [];
        let after: string | null = null;
        let fetchedPages = 0;
        let truncated = false;

        do {
          fetchedPages += 1;
          const args = [
            "api",
            "graphql",
            "--hostname",
            input.host,
            "-f",
            `query=${PULL_REQUEST_REVIEW_THREADS_QUERY}`,
            "-F",
            `owner=${input.owner}`,
            "-F",
            `repo=${input.repo}`,
            "-F",
            `number=${input.number}`,
            "-F",
            `first=${PULL_REQUEST_REVIEW_THREAD_PAGE_SIZE}`,
            ...(after ? ["-F", `after=${after}`] : []),
          ];

          const raw = yield* execute({ cwd: input.cwd, args }).pipe(
            Effect.map((result) => result.stdout.trim()),
          );
          const decoded = yield* decodeGitHubJson(
            raw,
            RawReviewThreadsResponseSchema,
            "getPullRequestReviewComments",
            "GitHub CLI returned invalid review threads JSON.",
          );
          const errorDetail = getGraphQlErrorDetail(decoded);
          if (errorDetail) {
            return yield* Effect.fail(
              new GitHubCliError({
                operation: "getPullRequestReviewComments",
                detail: errorDetail,
              }),
            );
          }

          const remaining = PULL_REQUEST_REVIEW_COMMENT_LIMIT - comments.length;
          const pageComments = normalizePullRequestReviewComments(decoded);
          if (pageComments.length > remaining) {
            truncated = true;
          }
          comments.push(...pageComments.slice(0, Math.max(remaining, 0)));

          const pageInfo = getPullRequestReviewThreadsPageInfo(decoded);
          const canFetchNextPage =
            pageInfo.hasNextPage &&
            pageInfo.endCursor !== null &&
            comments.length < PULL_REQUEST_REVIEW_COMMENT_LIMIT &&
            fetchedPages < PULL_REQUEST_REVIEW_THREAD_PAGE_LIMIT;
          // hasNextPage alone marks truncation: a null endCursor still means threads remain,
          // we just cannot page to them.
          if (!canFetchNextPage && pageInfo.hasNextPage) {
            truncated = true;
          }
          after = canFetchNextPage ? pageInfo.endCursor : null;
        } while (after !== null);

        return { comments, truncated };
      }),
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
  } satisfies GitHubCliShape;

  return service;
});

export const GitHubCliLive = Layer.effect(GitHubCli, makeGitHubCli);
