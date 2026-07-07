// FILE: fakeGitHubCli.ts
// Purpose: Shared test fake for the GitHubCli service — scripted `gh` responses (PR lists,
//          views, checkout, repo lookups) plus a call log for command assertions.
// Layer: Server test utility (imported by *.test.ts only; never by production code)
// Note: list responses decode through the live layer's decodePullRequestListJson so raw
//       gh-shaped fixtures ("OPEN", "CONFLICTING", …) normalize exactly like production.

import { spawnSync } from "node:child_process";

import { Effect } from "effect";
import type { GitPullRequestCheck, GitPullRequestComment } from "@t3tools/contracts";

import { GitHubCliError } from "../Errors.ts";
import { decodePullRequestListJson } from "../Layers/GitHubCli.ts";
import {
  type GitHubCliShape,
  type GitHubPullRequestSummary,
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
  pullRequestReviewComments?: GitPullRequestComment[];
  pullRequestReviewCommentsTruncated?: boolean;
  failWith?: GitHubCliError;
  reviewCommentsError?: GitHubCliError;
  createPullRequestError?: GitHubCliError;
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
          (scenario.createdPrUrl ?? "https://github.com/pingdotgg/codething-mvp/pull/101") + "\n",
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
        url: "https://github.com/pingdotgg/codething-mvp/pull/101",
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

  return {
    service: {
      execute,
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
            `${PULL_REQUEST_SUMMARY_JSON_FIELDS},statusCheckRollup`,
          ],
        }).pipe(
          Effect.map((result) => ({
            summary: JSON.parse(result.stdout) as GitHubPullRequestSummary,
            checks: scenario.pullRequestChecks ?? [],
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
    },
    ghCalls,
  };
}
