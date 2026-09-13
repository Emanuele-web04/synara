import type { GitStatusResult, OrchestrationThreadPullRequest } from "@synara/contracts";
import { ProjectId, ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  resolveThreadPullRequestFallback,
  useThreadPullRequests,
  type ThreadPullRequest,
  type ThreadPullRequestSource,
} from "./useThreadPullRequests";

const staleOpenPullRequest: OrchestrationThreadPullRequest = {
  number: 841,
  title: "Previous branch pull request",
  url: "https://github.com/acme/synara/pull/841",
  baseBranch: "main",
  headBranch: "feat/previous-branch",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 12,
  deletions: 4,
  changedFiles: 2,
};

describe("resolveThreadPullRequestFallback", () => {
  it("rejects a stale open PR for a dedicated worktree on another branch", () => {
    expect(
      resolveThreadPullRequestFallback({
        branch: "feat/current-branch",
        hasDedicatedWorktree: true,
        lastKnownPr: staleOpenPullRequest,
      }),
    ).toBeNull();
  });
});

describe("useThreadPullRequests requireLiveStatus", () => {
  const WORKTREE = "/tmp/wt-review";
  const PROJECT = ProjectId.makeUnsafe("project-1");
  const THREAD = ThreadId.makeUnsafe("thread-1");

  const openStoredPr: OrchestrationThreadPullRequest = {
    number: 42,
    title: "Open PR",
    url: "https://github.com/acme/repo/pull/42",
    baseBranch: "main",
    headBranch: "feat/x",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 3,
    deletions: 1,
    changedFiles: 2,
  };

  const liveStatusOnBranch: GitStatusResult = {
    branch: "feat/x",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    upstreamBranch: "origin/feat/x",
    aheadCount: 0,
    behindCount: 0,
    pr: null,
  };

  const threadSource = (
    overrides: Partial<ThreadPullRequestSource> = {},
  ): ThreadPullRequestSource => ({
    id: THREAD,
    projectId: PROJECT,
    branch: "feat/x",
    envMode: "worktree",
    worktreePath: WORKTREE,
    lastKnownPr: openStoredPr,
    ...overrides,
  });

  function readPullRequestMap(input: {
    threads: readonly ThreadPullRequestSource[];
    requireLiveStatus?: boolean;
    seed?: (queryClient: QueryClient) => void;
  }): ReadonlyMap<ThreadId, ThreadPullRequest> {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    input.seed?.(queryClient);
    const captured: { current: ReadonlyMap<ThreadId, ThreadPullRequest> | null } = {
      current: null,
    };
    function Probe(): ReactNode {
      captured.current = useThreadPullRequests({
        threads: input.threads,
        projectCwdById: new Map([[PROJECT, "/tmp/project"]]),
        ...(input.requireLiveStatus !== undefined
          ? { requireLiveStatus: input.requireLiveStatus }
          : {}),
      });
      return null;
    }
    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
    if (!captured.current) {
      throw new Error("Thread pull request probe did not render.");
    }
    return captured.current;
  }

  it("omits a thread whose live status has not resolved, persisted PR or not", () => {
    const map = readPullRequestMap({
      threads: [threadSource()],
      requireLiveStatus: true,
    });
    expect(map.has(THREAD)).toBe(false);
  });

  it("keeps the persisted fallback when requireLiveStatus is off", () => {
    const map = readPullRequestMap({ threads: [threadSource()] });
    expect(map.get(THREAD)?.number).toBe(42);
  });

  it("does not treat an unresolved stored-PR lookup as live confirmation", () => {
    const map = readPullRequestMap({
      threads: [threadSource()],
      requireLiveStatus: true,
      seed: (queryClient) => {
        queryClient.setQueryData(["git", "status", WORKTREE], liveStatusOnBranch);
      },
    });
    // Status resolved without a live PR and the stored-PR query has not
    // returned: the raw lastKnownPr must not badge the thread.
    expect(map.get(THREAD)).toBeNull();
  });

  it("surfaces a stored PR once the live resolve query returns it", () => {
    const map = readPullRequestMap({
      threads: [threadSource()],
      requireLiveStatus: true,
      seed: (queryClient) => {
        queryClient.setQueryData(["git", "status", WORKTREE], liveStatusOnBranch);
        queryClient.setQueryData(["git", "pull-request", WORKTREE, openStoredPr.url], {
          pullRequest: openStoredPr,
        });
      },
    });
    expect(map.get(THREAD)?.number).toBe(42);
  });
});
