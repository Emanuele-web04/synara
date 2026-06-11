// Purpose: execute-parameterized Effect helpers for GitHubCli — avatar enrichment and review-thread pagination.
// Layer: GitHubCliLive (apps/server/src/git/Layers/GitHubCli.ts) — each helper takes the layer's `execute`.
// Exports: enrichConversationAvatars, fetchPullRequestReviewThreads.

import { Effect, Schema } from "effect";

import { GitHubCliError } from "../Errors.ts";
import type {
  GitHubCliShape,
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
  GRAPHQL_REVIEW_THREAD_COMMENTS_QUERY,
  GRAPHQL_REVIEW_THREADS_QUERY,
  type PullRequestCoordinates,
  RawPageInfoSchema,
  RawReviewThreadCommentSchema,
  RawReviewThreadCommentsResponseSchema,
  RawReviewThreadsResponseSchema,
} from "./GitHubCli.types.ts";

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
