import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS,
  gitQueryKeys,
  gitStatusQueryOptions,
  gitWorkingTreeDiffQueryOptions,
  invalidateGitQueries,
  invalidateGitQueriesForCwds,
  gitMutationKeys,
  gitPreparePullRequestThreadMutationOptions,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
} from "./gitReactQuery";

describe("gitMutationKeys", () => {
  it("scopes stacked action keys by cwd", () => {
    expect(gitMutationKeys.runStackedAction("/repo/a")).not.toEqual(
      gitMutationKeys.runStackedAction("/repo/b"),
    );
  });

  it("scopes pull keys by cwd", () => {
    expect(gitMutationKeys.pull("/repo/a")).not.toEqual(gitMutationKeys.pull("/repo/b"));
  });

  it("scopes pull request thread preparation keys by cwd", () => {
    expect(gitMutationKeys.preparePullRequestThread("/repo/a")).not.toEqual(
      gitMutationKeys.preparePullRequestThread("/repo/b"),
    );
  });
});

describe("git mutation options", () => {
  const queryClient = new QueryClient();

  it("attaches cwd-scoped mutation key for runStackedAction", () => {
    const options = gitRunStackedActionMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.runStackedAction("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for pull", () => {
    const options = gitPullMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.pull("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for preparePullRequestThread", () => {
    const options = gitPreparePullRequestThreadMutationOptions({
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(gitMutationKeys.preparePullRequestThread("/repo/a"));
  });
});

describe("git query invalidation", () => {
  it("invalidates all git query families for broad refreshes", async () => {
    const queryClient = new QueryClient();
    const cwd = "/repo/all";
    const keys = [
      gitQueryKeys.githubRepository(cwd),
      gitQueryKeys.status(cwd),
      gitQueryKeys.branches(cwd),
      gitQueryKeys.workingTreeDiff(cwd, "workingTree"),
      ["git", "pull-request", cwd, "https://example.test/pr/1"] as const,
    ];

    for (const key of keys) {
      queryClient.setQueryData(key, {});
    }

    await invalidateGitQueries(queryClient);

    for (const key of keys) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });

  it("invalidates only queries for the affected cwd", async () => {
    const queryClient = new QueryClient();
    const cwdA = "/repo/a";
    const cwdB = "/repo/b";
    const cwdAKeys = [
      gitQueryKeys.githubRepository(cwdA),
      gitQueryKeys.status(cwdA),
      gitQueryKeys.branches(cwdA),
      gitQueryKeys.workingTreeDiff(cwdA, "workingTree"),
      gitQueryKeys.workingTreeDiff(cwdA, "staged"),
      ["git", "pull-request", cwdA, "https://example.test/pr/1"] as const,
    ];
    const cwdBKeys = [
      gitQueryKeys.githubRepository(cwdB),
      gitQueryKeys.status(cwdB),
      gitQueryKeys.branches(cwdB),
      gitQueryKeys.workingTreeDiff(cwdB, "workingTree"),
      ["git", "pull-request", cwdB, "https://example.test/pr/2"] as const,
    ];

    for (const key of [...cwdAKeys, ...cwdBKeys]) {
      queryClient.setQueryData(key, {});
    }

    await invalidateGitQueriesForCwds(queryClient, [cwdA]);

    for (const key of cwdAKeys) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
    for (const key of cwdBKeys) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    }
  });

  it("scopes status caches by GitHub account while preserving cwd-prefix invalidation", async () => {
    const queryClient = new QueryClient();
    const cwd = "/repo/account";
    const first = gitQueryKeys.status(cwd, { host: "github.com", login: "octo-one" });
    const second = gitQueryKeys.status(cwd, { host: "github.com", login: "octo-two" });
    queryClient.setQueryData(first, {});
    queryClient.setQueryData(second, {});

    await queryClient.invalidateQueries({ queryKey: gitQueryKeys.status(cwd) });

    expect(first).not.toEqual(second);
    expect(queryClient.getQueryState(first)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(second)?.isInvalidated).toBe(true);
  });

  it("does not immediately retry failed status reads", () => {
    const options = gitStatusQueryOptions("/repo/a");

    expect(options.retry).toBe(false);
  });
});

describe("git working tree diff query options", () => {
  it("accepts a live refetch interval for active diff badges", () => {
    const options = gitWorkingTreeDiffQueryOptions({
      cwd: "/repo/a",
      refetchInterval: GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS,
    });

    expect(GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS).toBe(4_000);
    expect(options.refetchInterval).toBe(GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS);
  });
});
