// FILE: fakeGitHubCli.ts
// Purpose: Shared test fake for the GitHubCli service — scripted `gh` responses (PR lists,
//          views, checkout, repo lookups) plus a call log for command assertions.
// Layer: Server test utility (imported by *.test.ts only; never by production code)
// Note: list and inbox responses decode through the live layer's decoders so raw gh-shaped
//       fixtures ("OPEN", "CONFLICTING", GraphQL nodes, …) normalize exactly like production.

import { spawnSync } from "node:child_process";

import { Effect, Semaphore } from "effect";
import type {
  GitPullRequestCheck,
  GitPullRequestComment,
  PullRequestMergeCapabilities,
  PullRequestStack,
  WorkItemAttachment,
} from "@synara/contracts";

import { GitHubCliError } from "../Errors.ts";
import { GITHUB_READ_SLOTS } from "../githubReadGate.ts";
import {
  decodePullRequestListJson,
  decodeRepositoryInboxJson,
  decodeRepositoryInvolvementJson,
} from "../Layers/GitHubCli.ts";
import {
  type GitHubCliShape,
  type GitHubIssueDetailData,
  type GitHubPullRequestDetailData,
  type GitHubPullRequestSummary,
  type GitHubRepositoryChangeProbe,
  type GitHubRepositoryInboxLookup,
  PULL_REQUEST_SUMMARY_JSON_FIELDS,
} from "../Services/GitHubCli.ts";

export interface FakeGhScenario {
  prListSequence?: string[];
  prListByHeadSelector?: Record<string, string>;
  createdPrUrl?: string;
  defaultBranch?: string;
  pullRequest?: {
    number: number;
    title: string;
    url: string;
    baseRefName: string;
    headRefName: string;
    state?: "open" | "closed" | "merged";
    isCrossRepository?: boolean;
    headRepositoryNameWithOwner?: string | null;
    headRepositoryOwnerLogin?: string | null;
  };
  repositoryCloneUrls?: Record<string, { url: string; sshUrl: string }>;
  pullRequestChecks?: GitPullRequestCheck[];
  pullRequestHeadSha?: string;
  pullRequestReviewComments?: GitPullRequestComment[];
  pullRequestReviewCommentsTruncated?: boolean;
  failWith?: GitHubCliError;
  reviewCommentsError?: GitHubCliError;
  createPullRequestError?: GitHubCliError;
  viewerLogin?: string;
  /** Raw `gh api graphql` inbox JSON, keyed by `owner/repo:state` (see {@link fakeInboxGraphQlJson}). */
  repositoryInboxJson?: Record<string, string>;
  /** Change-probe answer; defaults to "changed" with a fresh ETag per call. */
  repositoryChangeProbe?: GitHubRepositoryChangeProbe;
  /** Fails only the involvement search (`listRepositoryInboxInvolvement`). */
  repositoryInvolvementError?: GitHubCliError;
  repositoryInboxItems?: Record<number, GitHubRepositoryInboxLookup>;
  issueDetail?: GitHubIssueDetailData;
  pullRequestDetail?: GitHubPullRequestDetailData;
  pullRequestStack?: PullRequestStack | null;
  mergeCapabilities?: PullRequestMergeCapabilities;
  pullRequestDiff?: { patch: string; truncated: boolean };
  mergeOutcome?: "merged" | "enqueued";
  workItems?: WorkItemAttachment[];
}

export type FakePullRequest = NonNullable<FakeGhScenario["pullRequest"]>;

function runGitSyncForFakeGh(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status === 0) {
    return;
  }
  throw new GitHubCliError({
    operation: "execute",
    detail: `Failed to simulate gh checkout with git ${args.join(" ")}: ${result.stderr?.trim() || "unknown error"}`,
  });
}

function isGitHubCliError(error: unknown): error is GitHubCliError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error as { _tag?: unknown })._tag === "GitHubCliError"
  );
}

export function createGitHubCliWithFakeGh(scenario: FakeGhScenario = {}): {
  service: GitHubCliShape;
  ghCalls: string[];
} {
  const prListQueue = [...(scenario.prListSequence ?? [])];
  const ghCalls: string[] = [];

  const execute: GitHubCliShape["execute"] = (input) => {
    const args = [...input.args];
    ghCalls.push(args.join(" "));

    if (scenario.failWith) {
      return Effect.fail(scenario.failWith);
    }

    if (args[0] === "pr" && args[1] === "list") {
      const headSelectorIndex = args.findIndex((value) => value === "--head");
      const headSelector =
        headSelectorIndex >= 0 && headSelectorIndex < args.length - 1
          ? args[headSelectorIndex + 1]
          : undefined;
      const mappedStdout =
        typeof headSelector === "string"
          ? scenario.prListByHeadSelector?.[headSelector]
          : undefined;
      const stdout = (mappedStdout ?? prListQueue.shift() ?? "[]") + "\n";
      return Effect.succeed({
        stdout,
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
    }

    if (args[0] === "pr" && args[1] === "create") {
      if (scenario.createPullRequestError) {
        return Effect.fail(scenario.createPullRequestError);
      }
      return Effect.succeed({
        stdout:
          (scenario.createdPrUrl ?? "https://github.com/example-org/sample-repo/pull/101") + "\n",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
    }

    if (args[0] === "pr" && args[1] === "view") {
      const pullRequest: FakePullRequest = scenario.pullRequest ?? {
        number: 101,
        title: "Pull request",
        url: "https://github.com/example-org/sample-repo/pull/101",
        baseRefName: "main",
        headRefName: "feature/pull-request",
        state: "open",
      };
      return Effect.succeed({
        stdout:
          JSON.stringify({
            ...pullRequest,
            ...(pullRequest.headRepositoryNameWithOwner
              ? {
                  headRepository: {
                    nameWithOwner: pullRequest.headRepositoryNameWithOwner,
                  },
                }
              : {}),
            ...(pullRequest.headRepositoryOwnerLogin
              ? {
                  headRepositoryOwner: {
                    login: pullRequest.headRepositoryOwnerLogin,
                  },
                }
              : {}),
          }) + "\n",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
    }

    if (args[0] === "pr" && args[1] === "checkout") {
      return Effect.try({
        try: () => {
          const headBranch = scenario.pullRequest?.headRefName;
          if (headBranch) {
            const existingBranch = spawnSync(
              "git",
              ["show-ref", "--verify", "--quiet", `refs/heads/${headBranch}`],
              {
                cwd: input.cwd,
                encoding: "utf8",
              },
            );
            if (existingBranch.status === 0) {
              runGitSyncForFakeGh(input.cwd, ["checkout", headBranch]);
            } else {
              runGitSyncForFakeGh(input.cwd, ["checkout", "-b", headBranch]);
            }
          }
          return {
            stdout: "",
            stderr: "",
            code: 0,
            signal: null,
            timedOut: false,
          };
        },
        catch: (error) =>
          isGitHubCliError(error)
            ? error
            : new GitHubCliError({
                operation: "execute",
                detail:
                  error instanceof Error
                    ? `Failed to simulate gh checkout: ${error.message}`
                    : "Failed to simulate gh checkout.",
              }),
      });
    }

    if (args[0] === "repo" && args[1] === "view") {
      const repository = args[2];
      if (typeof repository === "string" && args.includes("nameWithOwner,url,sshUrl")) {
        const cloneUrls = scenario.repositoryCloneUrls?.[repository];
        if (!cloneUrls) {
          return Effect.fail(
            new GitHubCliError({
              operation: "execute",
              detail: `Unexpected repository lookup: ${repository}`,
            }),
          );
        }
        return Effect.succeed({
          stdout:
            JSON.stringify({
              nameWithOwner: repository,
              url: cloneUrls.url,
              sshUrl: cloneUrls.sshUrl,
            }) + "\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });
      }
      return Effect.succeed({
        stdout: `${scenario.defaultBranch ?? "main"}\n`,
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
    }

    return Effect.fail(
      new GitHubCliError({
        operation: "execute",
        detail: `Unexpected gh command: ${args.join(" ")}`,
      }),
    );
  };

  const listPullRequestsWithState = (
    input: { cwd: string; headSelector: string; limit?: number },
    options: { state: "open" | "all"; defaultLimit: number },
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
    }).pipe(Effect.flatMap((result) => decodePullRequestListJson(result.stdout)));

  const fakeInboxFixture = (input: { repository: string; state: string }) =>
    scenario.repositoryInboxJson?.[`${input.repository}:${input.state}`] ??
    fakeInboxGraphQlJson({ viewer: scenario.viewerLogin ?? "viewer" });

  // Queue only: tests drive rate-limit pauses with their own clocks, which the live gate's
  // wall-clock pause would outlast.
  const readSlots = Semaphore.makeUnsafe(GITHUB_READ_SLOTS);

  return {
    service: {
      withRead: (effect) => readSlots.withPermits(1)(effect),
      execute,
      getViewerLogin: (input) => {
        ghCalls.push(`api user --jq .login [cwd=${input.cwd}]`);
        return scenario.failWith
          ? Effect.fail(scenario.failWith)
          : Effect.succeed(scenario.viewerLogin ?? "viewer");
      },
      listRepositoryInbox: (input) => {
        ghCalls.push(`api graphql inbox ${input.repository} ${input.state}`);
        if (scenario.failWith) return Effect.fail(scenario.failWith);
        return decodeRepositoryInboxJson(fakeInboxFixture(input));
      },
      // The one fixture answers both documents; each decoder reads only its own fields.
      listRepositoryInboxInvolvement: (input) => {
        ghCalls.push(`api graphql inbox-involvement ${input.repository} ${input.state}`);
        const failure = scenario.failWith ?? scenario.repositoryInvolvementError;
        if (failure) return Effect.fail(failure);
        return decodeRepositoryInvolvementJson(fakeInboxFixture(input));
      },
      probeRepositoryInboxChanges: (input) => {
        ghCalls.push(`api -i repos/${input.repository}/issues (etag=${input.etag ?? "none"})`);
        if (scenario.failWith) return Effect.fail(scenario.failWith);
        return Effect.succeed(
          scenario.repositoryChangeProbe ?? { changed: true, etag: `"etag-${ghCalls.length}"` },
        );
      },
      getRepositoryInboxItems: (input) => {
        ghCalls.push(`api graphql inbox-items ${input.repository} ${input.numbers.join(",")}`);
        if (scenario.failWith) return Effect.fail(scenario.failWith);
        const results = new Map<number, GitHubRepositoryInboxLookup>();
        for (const number of input.numbers) {
          results.set(number, scenario.repositoryInboxItems?.[number] ?? { _tag: "not-found" });
        }
        return Effect.succeed(results);
      },
      getIssueDetail: (input) => {
        ghCalls.push(`issue view ${input.number} --repo ${input.repository}`);
        if (scenario.failWith) return Effect.fail(scenario.failWith);
        return scenario.issueDetail
          ? Effect.succeed(scenario.issueDetail)
          : Effect.fail(
              new GitHubCliError({
                operation: "getIssueDetail",
                detail: "Fake issue detail was not configured.",
              }),
            );
      },
      commentOnIssue: (input) => {
        ghCalls.push(`issue comment ${input.number} --repo ${input.repository}`);
        return scenario.failWith ? Effect.fail(scenario.failWith) : Effect.void;
      },
      getPullRequestDetail: (input) => {
        ghCalls.push(`pr view ${input.number} --repo ${input.repository}`);
        const detail = scenario.pullRequestDetail;
        return detail
          ? Effect.succeed(detail)
          : Effect.fail(
              new GitHubCliError({
                operation: "getPullRequestDetail",
                detail: "Fake pull request detail was not configured.",
              }),
            );
      },
      getPullRequestStack: (input) => {
        ghCalls.push(`graphql stack ${input.number} --repo ${input.repository}`);
        return scenario.failWith
          ? Effect.fail(scenario.failWith)
          : Effect.succeed(scenario.pullRequestStack ?? null);
      },
      getRepositoryMergeCapabilities: (input) => {
        ghCalls.push(`repo view ${input.repository} --json merge-capabilities`);
        return Effect.succeed(
          scenario.mergeCapabilities ?? {
            merge: true,
            squash: true,
            rebase: true,
            deleteBranchOnMerge: false,
          },
        );
      },
      getPullRequestDiff: (input) => {
        ghCalls.push(`pr diff ${input.number} --repo ${input.repository}`);
        return Effect.succeed(scenario.pullRequestDiff ?? { patch: "", truncated: false });
      },
      runPullRequestAction: (input) => {
        ghCalls.push(
          `pr action ${input.action} ${input.number} --repo ${input.repository}${input.mergeMethod ? ` --${input.mergeMethod}` : ""}`,
        );
        return scenario.failWith
          ? Effect.fail(scenario.failWith)
          : Effect.succeed({ mergeOutcome: scenario.mergeOutcome ?? null });
      },
      commentOnPullRequest: (input) => {
        ghCalls.push(`pr comment ${input.number} --repo ${input.repository}`);
        return scenario.failWith ? Effect.fail(scenario.failWith) : Effect.void;
      },
      listOpenPullRequests: (input) =>
        listPullRequestsWithState(input, { state: "open", defaultLimit: 1 }),
      listPullRequests: (input) =>
        listPullRequestsWithState(input, { state: "all", defaultLimit: 20 }),
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
            ...(input.draft === true ? ["--draft"] : []),
          ],
        }).pipe(Effect.asVoid),
      getDefaultBranch: (input) =>
        execute({
          cwd: input.cwd,
          args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
        }).pipe(
          Effect.map((result) => {
            const value = result.stdout.trim();
            return value.length > 0 ? value : null;
          }),
        ),
      getPullRequest: (input) =>
        execute({
          cwd: input.cwd,
          args: ["pr", "view", input.reference, "--json", PULL_REQUEST_SUMMARY_JSON_FIELDS],
        }).pipe(Effect.map((result) => JSON.parse(result.stdout) as GitHubPullRequestSummary)),
      getRepositoryCloneUrls: (input) =>
        execute({
          cwd: input.cwd,
          args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
        }).pipe(Effect.map((result) => JSON.parse(result.stdout))),
      checkoutPullRequest: (input) =>
        execute({
          cwd: input.cwd,
          args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
        }).pipe(Effect.asVoid),
      getPullRequestWithChecks: (input) =>
        execute({
          cwd: input.cwd,
          args: [
            "pr",
            "view",
            input.reference,
            "--json",
            `${PULL_REQUEST_SUMMARY_JSON_FIELDS},headRefOid,statusCheckRollup`,
          ],
        }).pipe(
          Effect.map((result) => ({
            summary: JSON.parse(result.stdout) as GitHubPullRequestSummary,
            checks: scenario.pullRequestChecks ?? [],
            headSha: scenario.pullRequestHeadSha ?? null,
          })),
        ),
      getPullRequestReviewComments: (input) => {
        ghCalls.push(
          `api graphql reviewThreads ${input.host}/${input.owner}/${input.repo}#${input.number}`,
        );
        return scenario.reviewCommentsError
          ? Effect.fail(scenario.reviewCommentsError)
          : Effect.succeed({
              comments: scenario.pullRequestReviewComments ?? [],
              truncated: scenario.pullRequestReviewCommentsTruncated ?? false,
            });
      },
      searchWorkItems: (input) => {
        ghCalls.push(`workItem search ${input.query ?? ""} --repo ${input.repository}`);
        return Effect.succeed({
          available: true,
          errorHint: null,
          items: scenario.workItems ?? [],
        });
      },
    },
    ghCalls,
  };
}

type FakeInboxNode = Record<string, unknown>;

/** Raw pull request node in the inbox GraphQL shape. Override any field per test. */
export function fakeInboxPullRequestNode(
  number: number,
  overrides: FakeInboxNode = {},
): FakeInboxNode {
  return {
    __typename: "PullRequest",
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    additions: 1,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    headRefName: `feature-${number}`,
    baseRefName: "main",
    reviewDecision: null,
    mergeable: "MERGEABLE",
    author: { __typename: "User", login: "someone", avatarUrl: null, url: null, name: null },
    reviewRequests: { nodes: [] },
    labels: { nodes: [] },
    assignees: { nodes: [] },
    comments: { totalCount: 0 },
    stackEntry: null,
    stack: null,
    ...overrides,
  };
}

/** Raw issue node in the inbox GraphQL shape. Override any field per test. */
export function fakeInboxIssueNode(number: number, overrides: FakeInboxNode = {}): FakeInboxNode {
  return {
    __typename: "Issue",
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/app/issues/${number}`,
    state: "OPEN",
    stateReason: null,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    closedAt: null,
    author: { __typename: "User", login: "someone", avatarUrl: null, url: null, name: null },
    labels: { nodes: [] },
    assignees: { nodes: [] },
    comments: { totalCount: 0 },
    ...overrides,
  };
}

/** Inbox GraphQL response body, as `gh api graphql` prints it. It carries the fields of both the
 * lists and the involvement documents, so one fixture answers both. */
export function fakeInboxGraphQlJson(input: {
  viewer?: string;
  pullRequests?: FakeInboxNode[];
  pullRequestTotalCount?: number;
  issues?: FakeInboxNode[];
  issueTotalCount?: number;
  /** Items matching `involves:@me`; read by the involvement document only. */
  mine?: FakeInboxNode[];
  mineIssueCount?: number;
  reviewRequested?: number[] | null;
  reviewRequestedCount?: number;
  rateLimit?: { cost?: number; remaining: number; resetAt: string } | null;
  errors?: Array<{ type?: string; message: string; path?: Array<string | number> }>;
}): string {
  const pullRequests = input.pullRequests ?? [];
  const issues = input.issues ?? [];
  const mine = input.mine ?? [];
  const reviewRequested = input.reviewRequested === undefined ? [] : input.reviewRequested;
  return JSON.stringify({
    data: {
      viewer: { login: input.viewer ?? "viewer" },
      rateLimit:
        input.rateLimit === undefined
          ? { cost: 5, remaining: 4_900, resetAt: "2026-07-15T01:00:00Z" }
          : input.rateLimit,
      repository: {
        pullRequests: {
          totalCount: input.pullRequestTotalCount ?? pullRequests.length,
          nodes: pullRequests,
        },
        issues: { totalCount: input.issueTotalCount ?? issues.length, nodes: issues },
      },
      mine: { issueCount: input.mineIssueCount ?? mine.length, nodes: mine },
      ...(reviewRequested === null
        ? {}
        : {
            reviewRequested: {
              issueCount: input.reviewRequestedCount ?? reviewRequested.length,
              nodes: reviewRequested.map((number) => ({ number })),
            },
          }),
    },
    ...(input.errors ? { errors: input.errors } : {}),
  });
}
