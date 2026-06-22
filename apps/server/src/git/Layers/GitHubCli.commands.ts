// Purpose: execute-parameterized Effect helpers for GitHubCli — avatar enrichment and review/timeline pagination.
// Layer: GitHubCliLive (apps/server/src/git/Layers/GitHubCli.ts) — each helper takes the layer's `execute`.
// Exports: enrichConversationAvatars, fetchPullRequestReviewThreads.

import { parsePullRequestUrl } from "@t3tools/shared/git";
import { Effect, Schema } from "effect";

import { GitHubCliError } from "../Errors.ts";
import type {
  GitHubCliShape,
  GitHubReviewPullRequestDetail,
  GitHubReviewPullRequestHeaderDetail,
  GitHubReviewStateEvent,
  GitHubReviewThread,
  GitHubReviewTimelineEvent,
} from "../Services/GitHubCli.ts";
import {
  decodeGitHubJson,
  normalizeAvatarUrl,
  normalizeReviewThreadNode,
  optionalCursorArg,
  pageInfoEndCursor,
  pageInfoHasNext,
} from "./GitHubCli.parsing.ts";
import {
  GRAPHQL_REVIEW_AVATARS_QUERY,
  GRAPHQL_REVIEW_THREAD_COMMENTS_QUERY,
  GRAPHQL_REVIEW_THREADS_QUERY,
  type PullRequestCoordinates,
  RawPageInfoSchema,
  RawReviewAvatarEnrichmentResponseSchema,
  RawGitHubReviewDetailSchema,
  RawReviewAuthorSchema,
  RawReviewLatestReviewSchema,
  RawReviewRequestSchema,
  RawReviewThreadCommentSchema,
  RawReviewThreadCommentsResponseSchema,
  RawReviewThreadsResponseSchema,
  RawReviewUserSchema,
} from "./GitHubCli.types.ts";

type RawReviewAvatarEntity =
  | Schema.Schema.Type<typeof RawReviewAuthorSchema>
  | Schema.Schema.Type<typeof RawReviewUserSchema>;

type RawReviewRequest = Schema.Schema.Type<typeof RawReviewRequestSchema>;
type RawReviewLatestReview = Schema.Schema.Type<typeof RawReviewLatestReviewSchema>;
type RawReviewDetail = Schema.Schema.Type<typeof RawGitHubReviewDetailSchema>;
type RawReviewAvatarEnrichmentResponse = Schema.Schema.Type<
  typeof RawReviewAvatarEnrichmentResponseSchema
>;
type RawReviewAvatarEnrichmentData = NonNullable<RawReviewAvatarEnrichmentResponse["data"]>;
type RawReviewAvatarEnrichmentRepository = NonNullable<RawReviewAvatarEnrichmentData["repository"]>;
type RawReviewAvatarEnrichmentPullRequest = NonNullable<
  RawReviewAvatarEnrichmentRepository["pullRequest"]
>;
type RawReviewAvatarEnrichmentRequestConnection = NonNullable<
  RawReviewAvatarEnrichmentPullRequest["reviewRequests"]
>;
type RawReviewAvatarEnrichmentRequestNode = NonNullable<
  RawReviewAvatarEnrichmentRequestConnection["nodes"]
>[number];
type ReviewDetailWithAvatars = GitHubReviewPullRequestDetail | GitHubReviewPullRequestHeaderDetail;

interface ReviewAvatarEnrichment {
  readonly reviewRequests: ReadonlyArray<RawReviewRequest>;
  readonly latestReviews: ReadonlyArray<RawReviewLatestReview>;
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

function missingAvatarLogin(entity: RawReviewAvatarEntity | null | undefined): string | null {
  const login = entity?.login?.trim() ?? "";
  if (login.length === 0 || normalizeAvatarUrl(entity?.avatarUrl) !== undefined) {
    return null;
  }
  return login;
}

function missingReviewRequestAvatarLogin(request: RawReviewRequest): string | null {
  const login = request.login?.trim() ?? "";
  if (login.length === 0 || normalizeAvatarUrl(request.avatarUrl) !== undefined) {
    return null;
  }
  return login;
}

function withUserAvatar<T extends RawReviewAvatarEntity>(
  entity: T,
  avatarsByLogin: ReadonlyMap<string, string | undefined>,
): T;
function withUserAvatar<T extends RawReviewAvatarEntity>(
  entity: T | null | undefined,
  avatarsByLogin: ReadonlyMap<string, string | undefined>,
): T | null | undefined;
function withUserAvatar<T extends RawReviewAvatarEntity>(
  entity: T | null | undefined,
  avatarsByLogin: ReadonlyMap<string, string | undefined>,
): T | null | undefined {
  const login = entity?.login?.trim() ?? "";
  const avatarUrl = login.length > 0 ? avatarsByLogin.get(login) : undefined;
  if (!entity || avatarUrl === undefined || normalizeAvatarUrl(entity.avatarUrl) !== undefined) {
    return entity;
  }
  return { ...entity, avatarUrl };
}

function withReviewRequestAvatar(
  request: RawReviewRequest,
  avatarsByLogin: ReadonlyMap<string, string | undefined>,
): RawReviewRequest {
  const login = request.login?.trim() ?? "";
  const avatarUrl = login.length > 0 ? avatarsByLogin.get(login) : undefined;
  if (avatarUrl === undefined || normalizeAvatarUrl(request.avatarUrl) !== undefined) {
    return request;
  }
  return { ...request, avatarUrl };
}

function rawReviewRequestIdentity(request: RawReviewRequest): string | null {
  const login = request.login?.trim();
  if (login && login.length > 0) {
    return `user:${login.toLowerCase()}`;
  }
  const slug = request.slug?.trim();
  if (slug && slug.length > 0) {
    return `team:${slug.toLowerCase()}`;
  }
  const name = request.name?.trim();
  if (name && name.length > 0) {
    return `team:${name.toLowerCase()}`;
  }
  return null;
}

function rawReviewRequestHasMissingAvatar(request: RawReviewRequest): boolean {
  return (
    rawReviewRequestIdentity(request) !== null &&
    normalizeAvatarUrl(request.avatarUrl) === undefined
  );
}

function rawLatestReviewHasMissingAvatar(review: RawReviewLatestReview): boolean {
  const login = review.author?.login?.trim() ?? "";
  return login.length > 0 && normalizeAvatarUrl(review.author?.avatarUrl) === undefined;
}

function rawDetailNeedsGraphqlReviewerAvatars(raw: RawReviewDetail): boolean {
  return (
    (raw.reviewRequests ?? []).some(rawReviewRequestHasMissingAvatar) ||
    (raw.latestReviews ?? []).some(rawLatestReviewHasMissingAvatar)
  );
}

function normalizeGraphqlReviewRequest(
  request: RawReviewAvatarEnrichmentRequestNode,
): RawReviewRequest | null {
  const reviewer = request.requestedReviewer;
  const login = reviewer?.login?.trim() ?? "";
  const name = reviewer?.name?.trim() ?? "";
  const slug = reviewer?.slug?.trim() ?? "";
  const avatarUrl = normalizeAvatarUrl(reviewer?.avatarUrl);
  if (login.length === 0 && name.length === 0 && slug.length === 0) {
    return null;
  }
  return {
    ...(login.length > 0 ? { login } : {}),
    ...(name.length > 0 ? { name } : {}),
    ...(slug.length > 0 ? { slug } : {}),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
  };
}

function readReviewAvatarEnrichment(
  response: RawReviewAvatarEnrichmentResponse,
): ReviewAvatarEnrichment {
  const pullRequest = response.data?.repository?.pullRequest;
  return {
    reviewRequests:
      pullRequest?.reviewRequests?.nodes
        ?.map(normalizeGraphqlReviewRequest)
        .filter((request): request is RawReviewRequest => request !== null) ?? [],
    latestReviews: pullRequest?.latestReviews?.nodes ?? [],
  };
}

function fetchReviewAvatarEnrichment(
  execute: GitHubCliShape["execute"],
  input: {
    readonly cwd: string;
    readonly pullRequest: PullRequestCoordinates;
  },
): Effect.Effect<ReviewAvatarEnrichment, never> {
  return execute({
    cwd: input.cwd,
    args: [
      "api",
      "graphql",
      "-f",
      `query=${GRAPHQL_REVIEW_AVATARS_QUERY}`,
      "-F",
      `owner=${input.pullRequest.owner}`,
      "-F",
      `name=${input.pullRequest.repo}`,
      "-F",
      `number=${String(input.pullRequest.number)}`,
    ],
  }).pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.flatMap((raw) =>
      decodeGitHubJson(
        raw,
        RawReviewAvatarEnrichmentResponseSchema,
        "getReviewPullRequestAvatars",
        "GitHub API returned invalid reviewer avatar JSON.",
      ),
    ),
    Effect.map(readReviewAvatarEnrichment),
    Effect.catch(() => Effect.succeed({ reviewRequests: [], latestReviews: [] })),
  );
}

function reviewRequestCandidates(request: RawReviewRequest): ReadonlyArray<string> {
  const login = request.login?.trim().toLowerCase();
  const slug = request.slug?.trim().toLowerCase();
  const name = request.name?.trim().toLowerCase();
  return [
    ...(login && login.length > 0 ? [`user:${login}`] : []),
    ...(slug && slug.length > 0 ? [`team:${slug}`] : []),
    ...(name && name.length > 0 ? [`team:${name}`] : []),
  ];
}

function findReviewRequestMatch(
  request: RawReviewRequest,
  enrichmentByIdentity: ReadonlyMap<string, RawReviewRequest>,
  fallback: RawReviewRequest | undefined,
): RawReviewRequest | undefined {
  for (const candidate of reviewRequestCandidates(request)) {
    const match = enrichmentByIdentity.get(candidate);
    if (match !== undefined) {
      return match;
    }
  }
  return fallback;
}

function mergeReviewRequestEnrichment(
  rawRequests: ReadonlyArray<RawReviewRequest> | null | undefined,
  enrichedRequests: ReadonlyArray<RawReviewRequest>,
): ReadonlyArray<RawReviewRequest> | null | undefined {
  if (rawRequests === undefined || rawRequests === null || rawRequests.length === 0) {
    return rawRequests;
  }
  const enrichedByIdentity = new Map<string, RawReviewRequest>();
  for (const enriched of enrichedRequests) {
    for (const candidate of reviewRequestCandidates(enriched)) {
      enrichedByIdentity.set(candidate, enriched);
    }
  }
  return rawRequests.map((request, index) => {
    const enriched = findReviewRequestMatch(request, enrichedByIdentity, enrichedRequests[index]);
    const avatarUrl = normalizeAvatarUrl(enriched?.avatarUrl);
    if (enriched === undefined || avatarUrl === undefined) {
      return request;
    }
    return {
      ...request,
      ...(request.login === undefined && enriched.login !== undefined
        ? { login: enriched.login }
        : {}),
      ...(request.name === undefined && enriched.name !== undefined ? { name: enriched.name } : {}),
      ...(request.slug === undefined && enriched.slug !== undefined ? { slug: enriched.slug } : {}),
      avatarUrl,
    };
  });
}

function mergeLatestReviewEnrichment(
  rawReviews: ReadonlyArray<RawReviewLatestReview> | null | undefined,
  enrichedReviews: ReadonlyArray<RawReviewLatestReview>,
): ReadonlyArray<RawReviewLatestReview> | null | undefined {
  if (rawReviews === undefined || rawReviews === null || rawReviews.length === 0) {
    return rawReviews;
  }
  const enrichedByLogin = new Map<string, RawReviewLatestReview>();
  for (const enriched of enrichedReviews) {
    const login = enriched.author?.login?.trim().toLowerCase() ?? "";
    if (login.length > 0) {
      enrichedByLogin.set(login, enriched);
    }
  }
  return rawReviews.map((review, index) => {
    const login = review.author?.login?.trim().toLowerCase() ?? "";
    const enriched = login.length > 0 ? enrichedByLogin.get(login) : enrichedReviews[index];
    const avatarUrl = normalizeAvatarUrl(enriched?.author?.avatarUrl);
    if (review.author === undefined || review.author === null || avatarUrl === undefined) {
      return review;
    }
    return {
      ...review,
      author: {
        ...review.author,
        avatarUrl,
      },
    };
  });
}

function mergeReviewAvatarEnrichment(
  raw: RawReviewDetail,
  enrichment: ReviewAvatarEnrichment,
): RawReviewDetail {
  return {
    ...raw,
    reviewRequests: mergeReviewRequestEnrichment(raw.reviewRequests, enrichment.reviewRequests),
    latestReviews: mergeLatestReviewEnrichment(raw.latestReviews, enrichment.latestReviews),
  };
}

function enrichRawReviewDetailReviewerAvatars(
  execute: GitHubCliShape["execute"],
  cwd: string,
  raw: RawReviewDetail,
): Effect.Effect<RawReviewDetail, never> {
  const pullRequest = parsePullRequestUrl(raw.url);
  if (pullRequest === null || !rawDetailNeedsGraphqlReviewerAvatars(raw)) {
    return Effect.succeed(raw);
  }
  return fetchReviewAvatarEnrichment(execute, { cwd, pullRequest }).pipe(
    Effect.map((enrichment) => mergeReviewAvatarEnrichment(raw, enrichment)),
  );
}

function enrichRawReviewDetailUserAvatars(
  execute: GitHubCliShape["execute"],
  cwd: string,
  raw: RawReviewDetail,
): Effect.Effect<RawReviewDetail, never> {
  const missingLogins = new Set<string>();
  const addMissing = (login: string | null): void => {
    if (login !== null) {
      missingLogins.add(login);
    }
  };

  addMissing(missingAvatarLogin(raw.author));
  for (const assignee of raw.assignees ?? []) {
    addMissing(missingAvatarLogin(assignee));
  }
  for (const review of raw.latestReviews ?? []) {
    addMissing(missingAvatarLogin(review.author));
  }
  for (const request of raw.reviewRequests ?? []) {
    addMissing(missingReviewRequestAvatarLogin(request));
  }

  if (missingLogins.size === 0) {
    return Effect.succeed(raw);
  }

  return Effect.forEach([...missingLogins], (login) => lookupUserAvatar(execute, cwd, login), {
    concurrency: 6,
  }).pipe(
    Effect.map((entries) => {
      const avatarsByLogin = new Map(entries);
      const enriched: RawReviewDetail = {
        ...raw,
        author: withUserAvatar(raw.author, avatarsByLogin),
        assignees: raw.assignees?.map((assignee) => withUserAvatar(assignee, avatarsByLogin)),
        latestReviews: raw.latestReviews?.map(
          (review): RawReviewLatestReview => ({
            ...review,
            author: withUserAvatar(review.author, avatarsByLogin),
          }),
        ),
        reviewRequests: raw.reviewRequests?.map((request) =>
          withReviewRequestAvatar(request, avatarsByLogin),
        ),
      };
      return enriched;
    }),
  );
}

export function enrichReviewDetailAvatars<T extends ReviewDetailWithAvatars>(
  execute: GitHubCliShape["execute"],
  cwd: string,
  raw: RawReviewDetail,
  normalize: (raw: RawReviewDetail) => T,
): Effect.Effect<T, never> {
  return enrichRawReviewDetailReviewerAvatars(execute, cwd, raw).pipe(
    Effect.flatMap((enrichedRaw) => enrichRawReviewDetailUserAvatars(execute, cwd, enrichedRaw)),
    Effect.map(normalize),
  );
}

export function enrichConversationAvatars(
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

export function fetchPullRequestReviewThreads(
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

const GRAPHQL_PR_TIMELINE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $timelineCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(first: 100, after: $timelineCursor, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, MILESTONED_EVENT, DEMILESTONED_EVENT, REVIEW_REQUESTED_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT]) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          __typename
          ... on LabeledEvent { createdAt actor { login } label { name } }
          ... on UnlabeledEvent { createdAt actor { login } label { name } }
          ... on AssignedEvent { createdAt actor { login } assignee { ... on User { login } } }
          ... on UnassignedEvent { createdAt actor { login } assignee { ... on User { login } } }
          ... on MilestonedEvent { createdAt actor { login } milestoneTitle }
          ... on DemilestonedEvent { createdAt actor { login } milestoneTitle }
          ... on ReviewRequestedEvent { createdAt actor { login } requestedReviewer { ... on User { login } ... on Team { name } } }
          ... on MergedEvent { createdAt actor { login } commit { oid } }
          ... on ClosedEvent { createdAt actor { login } }
          ... on ReopenedEvent { createdAt actor { login } }
          ... on HeadRefForcePushedEvent { createdAt actor { login } }
        }
      }
    }
  }
}`;

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function normalizeTimelineNode(node: Record<string, unknown>): GitHubReviewStateEvent | null {
  const typename = node["__typename"];
  const createdAt = readString(node, "createdAt");
  if (createdAt === undefined) {
    return null;
  }
  const actor = readString(node["actor"], "login") ?? "";
  switch (typename) {
    case "LabeledEvent":
    case "UnlabeledEvent": {
      const label = readString(node["label"], "name");
      return label !== undefined
        ? { kind: "labeled", actor, label, added: typename === "LabeledEvent", createdAt }
        : null;
    }
    case "AssignedEvent":
    case "UnassignedEvent": {
      const assignee = readString(node["assignee"], "login");
      return assignee !== undefined
        ? { kind: "assigned", actor, assignee, added: typename === "AssignedEvent", createdAt }
        : null;
    }
    case "MilestonedEvent":
    case "DemilestonedEvent": {
      const milestone = readString(node, "milestoneTitle");
      return milestone !== undefined
        ? { kind: "milestoned", actor, milestone, added: typename === "MilestonedEvent", createdAt }
        : null;
    }
    case "ReviewRequestedEvent": {
      const reviewer =
        readString(node["requestedReviewer"], "login") ??
        readString(node["requestedReviewer"], "name");
      return reviewer !== undefined
        ? { kind: "reviewRequested", actor, requestedReviewer: reviewer, createdAt }
        : null;
    }
    case "MergedEvent": {
      const commitOid = readString(node["commit"], "oid");
      return {
        kind: "merged",
        actor,
        ...(commitOid !== undefined ? { commitOid } : {}),
        createdAt,
      };
    }
    case "ClosedEvent":
      return { kind: "closed", actor, createdAt };
    case "ReopenedEvent":
      return { kind: "reopened", actor, createdAt };
    case "HeadRefForcePushedEvent":
      return { kind: "headRefForcePushed", actor, createdAt };
    default:
      return null;
  }
}

function readResolvedThread(
  parsed: unknown,
  field: string,
): { readonly id: string; readonly isResolved: boolean } | null {
  const data =
    typeof parsed === "object" && parsed !== null ? (parsed as { data?: unknown }).data : undefined;
  const mutation =
    typeof data === "object" && data !== null
      ? (data as Record<string, unknown>)[field]
      : undefined;
  const thread =
    typeof mutation === "object" && mutation !== null
      ? (mutation as { thread?: unknown }).thread
      : undefined;
  if (typeof thread !== "object" || thread === null) {
    return null;
  }
  const id = readString(thread, "id");
  if (id === undefined) {
    return null;
  }
  return { id, isResolved: (thread as { isResolved?: unknown }).isResolved === true };
}

export function setReviewThreadResolution(
  execute: GitHubCliShape["execute"],
  input: { readonly cwd: string; readonly threadId: string; readonly resolved: boolean },
): Effect.Effect<{ readonly id: string; readonly isResolved: boolean }, GitHubCliError> {
  const field = input.resolved ? "resolveReviewThread" : "unresolveReviewThread";
  const mutation = `mutation($threadId: ID!) { ${field}(input: { threadId: $threadId }) { thread { id isResolved } } }`;
  return execute({
    cwd: input.cwd,
    args: ["api", "graphql", "-f", `query=${mutation}`, "-F", `threadId=${input.threadId}`],
  }).pipe(
    Effect.flatMap((result) =>
      Effect.try({
        try: () => JSON.parse(result.stdout) as unknown,
        catch: (error) =>
          new GitHubCliError({
            operation: "setReviewThreadResolution",
            detail: "GitHub API returned invalid thread resolution JSON.",
            cause: error,
          }),
      }),
    ),
    Effect.flatMap((parsed) => {
      const thread = readResolvedThread(parsed, field);
      return thread === null
        ? Effect.fail(
            new GitHubCliError({
              operation: "setReviewThreadResolution",
              detail: "GitHub API did not return the updated review thread.",
            }),
          )
        : Effect.succeed(thread);
    }),
  );
}

function readReplyCommentId(parsed: unknown): string | null {
  const data =
    typeof parsed === "object" && parsed !== null ? (parsed as { data?: unknown }).data : undefined;
  const mutation =
    typeof data === "object" && data !== null
      ? (data as { addPullRequestReviewThreadReply?: unknown }).addPullRequestReviewThreadReply
      : undefined;
  const comment =
    typeof mutation === "object" && mutation !== null
      ? (mutation as { comment?: unknown }).comment
      : undefined;
  return comment !== undefined ? (readString(comment, "id") ?? null) : null;
}

export function addReviewThreadReply(
  execute: GitHubCliShape["execute"],
  input: { readonly cwd: string; readonly threadId: string; readonly body: string },
): Effect.Effect<{ readonly threadId: string }, GitHubCliError> {
  const mutation = `mutation($threadId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } } }`;
  return execute({
    cwd: input.cwd,
    args: [
      "api",
      "graphql",
      "-f",
      `query=${mutation}`,
      "-F",
      `threadId=${input.threadId}`,
      "-f",
      `body=${input.body}`,
    ],
  }).pipe(
    Effect.flatMap((result) =>
      Effect.try({
        try: () => JSON.parse(result.stdout) as unknown,
        catch: (error) =>
          new GitHubCliError({
            operation: "addReviewThreadReply",
            detail: "GitHub API returned invalid reply JSON.",
            cause: error,
          }),
      }),
    ),
    Effect.flatMap((parsed) =>
      readReplyCommentId(parsed) === null
        ? Effect.fail(
            new GitHubCliError({
              operation: "addReviewThreadReply",
              detail: "GitHub API did not return the posted reply.",
            }),
          )
        : Effect.succeed({ threadId: input.threadId }),
    ),
  );
}

function readMutationCommentId(parsed: unknown, mutationField: string): string | null {
  const data =
    typeof parsed === "object" && parsed !== null ? (parsed as { data?: unknown }).data : undefined;
  const mutation =
    typeof data === "object" && data !== null
      ? (data as Record<string, unknown>)[mutationField]
      : undefined;
  const comment =
    typeof mutation === "object" && mutation !== null
      ? (mutation as { pullRequestReviewComment?: unknown }).pullRequestReviewComment
      : undefined;
  return comment !== undefined ? (readString(comment, "id") ?? null) : null;
}

export function updateReviewThreadComment(
  execute: GitHubCliShape["execute"],
  input: { readonly cwd: string; readonly commentId: string; readonly body: string },
): Effect.Effect<{ readonly commentId: string }, GitHubCliError> {
  const mutation = `mutation($commentId: ID!, $body: String!) { updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $commentId, body: $body }) { pullRequestReviewComment { id } } }`;
  return execute({
    cwd: input.cwd,
    args: [
      "api",
      "graphql",
      "-f",
      `query=${mutation}`,
      "-F",
      `commentId=${input.commentId}`,
      "-f",
      `body=${input.body}`,
    ],
  }).pipe(
    Effect.flatMap((result) =>
      Effect.try({
        try: () => JSON.parse(result.stdout) as unknown,
        catch: (error) =>
          new GitHubCliError({
            operation: "updateReviewThreadComment",
            detail: "GitHub API returned invalid comment update JSON.",
            cause: error,
          }),
      }),
    ),
    Effect.flatMap((parsed) =>
      readMutationCommentId(parsed, "updatePullRequestReviewComment") === null
        ? Effect.fail(
            new GitHubCliError({
              operation: "updateReviewThreadComment",
              detail: "GitHub API did not return the updated comment.",
            }),
          )
        : Effect.succeed({ commentId: input.commentId }),
    ),
  );
}

export function deleteReviewThreadComment(
  execute: GitHubCliShape["execute"],
  input: { readonly cwd: string; readonly commentId: string },
): Effect.Effect<{ readonly commentId: string }, GitHubCliError> {
  const mutation = `mutation($commentId: ID!) { deletePullRequestReviewComment(input: { id: $commentId }) { clientMutationId } }`;
  return execute({
    cwd: input.cwd,
    args: ["api", "graphql", "-f", `query=${mutation}`, "-F", `commentId=${input.commentId}`],
  }).pipe(Effect.as({ commentId: input.commentId }));
}

interface TimelinePage {
  readonly nodes: ReadonlyArray<Record<string, unknown>>;
  readonly pageInfo: Schema.Schema.Type<typeof RawPageInfoSchema> | null;
}

function readTimelinePageInfo(
  pageInfo: unknown,
): Schema.Schema.Type<typeof RawPageInfoSchema> | null {
  if (typeof pageInfo !== "object" || pageInfo === null) {
    return null;
  }
  const hasNextPage = (pageInfo as { hasNextPage?: unknown }).hasNextPage;
  const endCursor = (pageInfo as { endCursor?: unknown }).endCursor;
  return {
    hasNextPage: typeof hasNextPage === "boolean" ? hasNextPage : null,
    endCursor: typeof endCursor === "string" ? endCursor : null,
  };
}

function readTimelinePage(parsed: unknown): TimelinePage {
  const data =
    typeof parsed === "object" && parsed !== null ? (parsed as { data?: unknown }).data : undefined;
  const repository =
    typeof data === "object" && data !== null
      ? (data as { repository?: unknown }).repository
      : undefined;
  const pullRequest =
    typeof repository === "object" && repository !== null
      ? (repository as { pullRequest?: unknown }).pullRequest
      : undefined;
  const timelineItems =
    typeof pullRequest === "object" && pullRequest !== null
      ? (pullRequest as { timelineItems?: unknown }).timelineItems
      : undefined;
  const nodes =
    typeof timelineItems === "object" && timelineItems !== null
      ? (timelineItems as { nodes?: unknown }).nodes
      : undefined;
  const pageInfo =
    typeof timelineItems === "object" && timelineItems !== null
      ? (timelineItems as { pageInfo?: unknown }).pageInfo
      : undefined;
  return {
    nodes: Array.isArray(nodes)
      ? nodes.filter(
          (node): node is Record<string, unknown> => typeof node === "object" && node !== null,
        )
      : [],
    pageInfo: readTimelinePageInfo(pageInfo),
  };
}

function fetchPullRequestTimelinePage(
  execute: GitHubCliShape["execute"],
  input: {
    readonly cwd: string;
    readonly pullRequest: PullRequestCoordinates;
    readonly timelineCursor: string | null;
  },
): Effect.Effect<TimelinePage, GitHubCliError> {
  return execute({
    cwd: input.cwd,
    args: [
      "api",
      "graphql",
      "-f",
      `query=${GRAPHQL_PR_TIMELINE_QUERY}`,
      "-F",
      `owner=${input.pullRequest.owner}`,
      "-F",
      `name=${input.pullRequest.repo}`,
      "-F",
      `number=${String(input.pullRequest.number)}`,
      ...optionalCursorArg("timelineCursor", input.timelineCursor),
    ],
  }).pipe(
    Effect.flatMap((result) =>
      Effect.try({
        try: () => JSON.parse(result.stdout) as unknown,
        catch: (error) =>
          new GitHubCliError({
            operation: "getReviewTimeline",
            detail: "GitHub API returned invalid timeline JSON.",
            cause: error,
          }),
      }),
    ),
    Effect.map(readTimelinePage),
  );
}

export function fetchPullRequestTimeline(
  execute: GitHubCliShape["execute"],
  input: { readonly cwd: string; readonly pullRequest: PullRequestCoordinates },
): Effect.Effect<ReadonlyArray<GitHubReviewStateEvent>, GitHubCliError> {
  return Effect.gen(function* () {
    const events: GitHubReviewStateEvent[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const page = yield* fetchPullRequestTimelinePage(execute, {
        cwd: input.cwd,
        pullRequest: input.pullRequest,
        timelineCursor: cursor,
      });
      events.push(
        ...page.nodes
          .map(normalizeTimelineNode)
          .filter((event): event is GitHubReviewStateEvent => event !== null),
      );
      cursor = pageInfoEndCursor(page.pageInfo);
      hasNextPage = pageInfoHasNext(page.pageInfo) && cursor !== null;
    }

    return events;
  });
}
