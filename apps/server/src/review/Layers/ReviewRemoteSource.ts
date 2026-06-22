import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { GitHubCli } from "../../git/Services/GitHubCli.ts";
import {
  REVIEW_SYNC_PAGE_SIZE,
  ReviewRemoteSource,
  type ReviewRemoteBudget,
  type ReviewRemotePage,
  type ReviewRemoteSourceShape,
  ReviewSyncError,
} from "../Services/ReviewSync.ts";

// Open-only: syncing merged/closed would bury older open PRs under recently-updated closed ones
// (UPDATED_AT DESC), so the scan stops short. No statusCheckRollup -- checks hydrate lazily per PR.
const PULL_REQUESTS_QUERY = `query($owner: String!, $name: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}, states: [OPEN]) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url isDraft updatedAt state additions deletions reviewDecision
        baseRefName headRefName
        author { login avatarUrl }
        headRepositoryOwner { login }
        labels(first: 20) { nodes { name } }
        assignees(first: 20) { nodes { login } }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
      }
    }
  }
}`;

interface OwnerName {
  readonly owner: string;
  readonly name: string;
}

const RATE_LIMIT_PATTERN = /rate limit/i;

function isRateLimitText(text: string): boolean {
  return RATE_LIMIT_PATTERN.test(text);
}

// GitHub surfaces the reopen time as an `x-ratelimit-reset` epoch-seconds header or an ISO
// `resetAt`; gh often prints only the message, so this is best-effort and may return undefined.
function parseRateLimitResetAt(text: string): number | undefined {
  const epochSeconds = /x-ratelimit-reset:?\s*(\d{10,})/i.exec(text);
  if (epochSeconds) {
    return Number(epochSeconds[1]) * 1000;
  }
  const iso = /reset[aA]t["':\s]+([0-9T:.\-+Z]+)/.exec(text);
  if (iso && !Number.isNaN(Date.parse(iso[1]!))) {
    return Date.parse(iso[1]!);
  }
  return undefined;
}

function rateLimitFields(error: unknown): { rateLimited: true; resetAt?: number } | undefined {
  const text =
    error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
  if (!isRateLimitText(text)) {
    return undefined;
  }
  const resetAt = parseRateLimitResetAt(text);
  return resetAt !== undefined ? { rateLimited: true, resetAt } : { rateLimited: true };
}

function mapState(state: unknown): ReviewPullRequestSummary["state"] {
  switch (state) {
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return "open";
  }
}

function stringArray(connection: unknown, key: "name" | "login"): string[] {
  const nodes =
    typeof connection === "object" && connection !== null
      ? (connection as { nodes?: unknown }).nodes
      : undefined;
  if (!Array.isArray(nodes)) {
    return [];
  }
  return nodes
    .map((node) =>
      typeof node === "object" && node !== null
        ? (node as Record<string, unknown>)[key]
        : undefined,
    )
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function reviewerLogins(connection: unknown): string[] {
  const nodes =
    typeof connection === "object" && connection !== null
      ? (connection as { nodes?: unknown }).nodes
      : undefined;
  if (!Array.isArray(nodes)) {
    return [];
  }
  return nodes
    .map((node) => {
      const reviewer =
        typeof node === "object" && node !== null
          ? (node as { requestedReviewer?: unknown }).requestedReviewer
          : undefined;
      return typeof reviewer === "object" && reviewer !== null
        ? (reviewer as { login?: unknown }).login
        : undefined;
    })
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function normalizeNode(node: Record<string, unknown>, owner: string): ReviewPullRequestSummary {
  const author = (node["author"] as { login?: unknown; avatarUrl?: unknown } | null) ?? null;
  const headOwner = (node["headRepositoryOwner"] as { login?: unknown } | null)?.login ?? owner;
  const headRefName = String(node["headRefName"] ?? "");
  const authorLogin = typeof author?.login === "string" ? author.login : "";
  const avatarUrl = typeof author?.avatarUrl === "string" ? author.avatarUrl : undefined;
  const headSelector =
    typeof headOwner === "string" && headOwner !== owner
      ? `${headOwner}:${headRefName}`
      : undefined;
  return {
    number: Number(node["number"]),
    title: String(node["title"] ?? ""),
    url: String(node["url"] ?? ""),
    baseBranch: String(node["baseRefName"] ?? ""),
    headBranch: headRefName,
    ...(headSelector !== undefined ? { headSelector } : {}),
    author: authorLogin,
    ...(avatarUrl !== undefined ? { authorAvatarUrl: avatarUrl } : {}),
    updatedAt: String(node["updatedAt"] ?? ""),
    state: mapState(node["state"]),
    reviewDecision:
      typeof node["reviewDecision"] === "string" ? (node["reviewDecision"] as string) : null,
    isDraft: node["isDraft"] === true,
    additions: Math.max(0, Number(node["additions"] ?? 0)),
    deletions: Math.max(0, Number(node["deletions"] ?? 0)),
    checksStatus: "none",
    reviewRequests: reviewerLogins(node["reviewRequests"]),
    labels: stringArray(node["labels"], "name"),
    assignees: stringArray(node["assignees"], "login"),
  };
}

const makeReviewRemoteSource = Effect.gen(function* () {
  const gitHubCli = yield* GitHubCli;
  const ownerNameByCwd = new Map<string, OwnerName>();

  const resolveOwnerName = (cwd: string): Effect.Effect<OwnerName, ReviewSyncError> => {
    const cached = ownerNameByCwd.get(cwd);
    if (cached !== undefined) {
      return Effect.succeed(cached);
    }
    return gitHubCli
      .execute({
        cwd,
        args: ["repo", "view", "--json", "owner,name", "-q", '.owner.login + "/" + .name'],
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new ReviewSyncError({
              operation: "resolveOwnerName",
              detail: `Could not resolve repository for ${cwd}`,
              cause: error,
            }),
        ),
        Effect.flatMap((result) => {
          const trimmed = result.stdout.trim();
          const slash = trimmed.indexOf("/");
          if (slash <= 0 || slash >= trimmed.length - 1) {
            return Effect.fail(
              new ReviewSyncError({
                operation: "resolveOwnerName",
                detail: `Unexpected repository identifier "${trimmed}"`,
              }),
            );
          }
          const ownerName: OwnerName = {
            owner: trimmed.slice(0, slash),
            name: trimmed.slice(slash + 1),
          };
          ownerNameByCwd.set(cwd, ownerName);
          return Effect.succeed(ownerName);
        }),
      );
  };

  const fetchUpdatedPage: ReviewRemoteSourceShape["fetchUpdatedPage"] = (input) =>
    Effect.gen(function* () {
      const { owner, name } = yield* resolveOwnerName(input.cwd);
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${PULL_REQUESTS_QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `first=${input.pageSize || REVIEW_SYNC_PAGE_SIZE}`,
        ...(input.after !== null ? ["-f", `after=${input.after}`] : []),
      ];
      const result = yield* gitHubCli.execute({ cwd: input.cwd, args }).pipe(
        Effect.mapError(
          (error) =>
            new ReviewSyncError({
              operation: "fetchUpdatedPage",
              detail: `gh api graphql failed for ${owner}/${name}`,
              cause: error,
              ...rateLimitFields(error),
            }),
        ),
      );
      const parsed = yield* Effect.try({
        try: () => JSON.parse(result.stdout) as unknown,
        catch: (error) =>
          new ReviewSyncError({
            operation: "fetchUpdatedPage",
            detail: "Invalid JSON from gh api graphql",
            cause: error,
          }),
      });
      const data =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { data?: unknown }).data
          : undefined;
      const repository =
        typeof data === "object" && data !== null
          ? (data as { repository?: unknown }).repository
          : undefined;
      const connection =
        typeof repository === "object" && repository !== null
          ? (repository as { pullRequests?: unknown }).pullRequests
          : undefined;
      if (typeof connection !== "object" || connection === null) {
        const errors =
          typeof parsed === "object" && parsed !== null
            ? (parsed as { errors?: unknown }).errors
            : undefined;
        const graphqlMessage =
          Array.isArray(errors) &&
          errors.length > 0 &&
          typeof errors[0] === "object" &&
          errors[0] !== null
            ? String((errors[0] as { message?: unknown }).message ?? "unknown GraphQL error")
            : null;
        return yield* Effect.fail(
          new ReviewSyncError({
            operation: "fetchUpdatedPage",
            detail:
              graphqlMessage !== null
                ? `gh api graphql error for ${owner}/${name}: ${graphqlMessage}`
                : `Missing repository data for ${owner}/${name}`,
            ...(graphqlMessage !== null ? rateLimitFields(graphqlMessage) : {}),
          }),
        );
      }
      const rateLimit =
        typeof data === "object" && data !== null
          ? (data as { rateLimit?: { cost?: unknown; remaining?: unknown; resetAt?: unknown } })
              .rateLimit
          : undefined;
      const budget: ReviewRemoteBudget = {
        cost: Number(rateLimit?.cost ?? 1),
        remaining: Number(rateLimit?.remaining ?? Number.POSITIVE_INFINITY),
        resetAt:
          typeof rateLimit?.resetAt === "string" && !Number.isNaN(Date.parse(rateLimit.resetAt))
            ? Date.parse(rateLimit.resetAt)
            : 0,
      };
      const conn = connection as {
        pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
        nodes?: unknown;
      };
      const nodes = Array.isArray(conn.nodes) ? conn.nodes : [];
      const pullRequests = nodes
        .filter(
          (node): node is Record<string, unknown> => typeof node === "object" && node !== null,
        )
        .map((node) => normalizeNode(node, owner));
      const page: ReviewRemotePage = {
        pullRequests,
        hasNextPage: conn.pageInfo?.hasNextPage === true,
        endCursor: typeof conn.pageInfo?.endCursor === "string" ? conn.pageInfo.endCursor : null,
        budget,
      };
      return page;
    });

  return { fetchUpdatedPage } satisfies ReviewRemoteSourceShape;
});

export const ReviewRemoteSourceLive = Layer.effect(ReviewRemoteSource, makeReviewRemoteSource);
