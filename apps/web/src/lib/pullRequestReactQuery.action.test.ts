import type {
  GitPullRequestSnapshotResult,
  GitResolvedPullRequest,
  GitStatusResult,
  NativeApi,
  ProjectId,
} from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getGitStatus, getPullRequestSnapshot } = vi.hoisted(() => ({
  getGitStatus: vi.fn<NativeApi["git"]["status"]>(),
  getPullRequestSnapshot: vi.fn<NativeApi["git"]["pullRequestSnapshot"]>(),
}));

vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => ({
    git: { status: getGitStatus, pullRequestSnapshot: getPullRequestSnapshot },
  }),
}));

import {
  gitPullRequestSnapshotQueryOptions,
  gitQueryKeys,
  gitStatusQueryOptions,
} from "./gitReactQuery";
import { activePullRequestActionPatch } from "./pullRequestMutationCoordinator";
import { pullRequestActionMutationOptions, pullRequestQueryKeys } from "./pullRequestReactQuery";
import { deferred } from "./pullRequestReactQuery.testUtils";

describe("pullRequestActionMutationOptions", () => {
  beforeEach(() => {
    getGitStatus.mockReset();
    getPullRequestSnapshot.mockReset();
  });

  it.each(["ready", "draft"] as const)(
    "immediately applies %s to Environment caches across worktrees and rolls back only its fields",
    async (action) => {
      const queryClient = new QueryClient();
      const input = {
        projectId: "project-a" as ProjectId,
        repository: "acme/widgets",
        number: 42,
        action,
      };
      const pr = {
        number: 42,
        url: "https://github.com/Acme/Widgets/pull/42",
        state: "open",
        isDraft: action === "ready",
      };
      const statusKey = gitQueryKeys.status("/worktree");
      const snapshotKey = [...gitQueryKeys.pullRequest("/worktree"), "snapshot", pr.url];
      const otherSnapshotKey = [
        ...gitQueryKeys.pullRequest("/second-worktree"),
        "snapshot",
        pr.url,
      ];
      const unrelatedStatusKey = gitQueryKeys.status("/other-repo");
      queryClient.setQueryData(statusKey, { pr, aheadCount: 1 });
      for (const key of [snapshotKey, otherSnapshotKey]) {
        queryClient.setQueryData(key, { pullRequest: pr, checks: [] });
      }
      queryClient.setQueryData(unrelatedStatusKey, {
        pr: { ...pr, url: "https://github.com/other/repo/pull/42" },
      });
      const options = pullRequestActionMutationOptions(queryClient);
      const context = await Reflect.apply(options.onMutate!, undefined, [input, undefined]);

      expect(queryClient.getQueryData(statusKey)).toMatchObject({
        pr: { isDraft: action === "draft" },
      });
      for (const key of [snapshotKey, otherSnapshotKey]) {
        expect(queryClient.getQueryData(key)).toMatchObject({
          pullRequest: { isDraft: action === "draft" },
        });
      }
      expect(queryClient.getQueryData(unrelatedStatusKey)).toMatchObject({
        pr: { isDraft: pr.isDraft },
      });

      // Git activity and check updates must survive a failed status change.
      queryClient.setQueryData<Record<string, unknown>>(statusKey, (current) =>
        current ? { ...current, aheadCount: 2 } : current,
      );
      queryClient.setQueryData<Record<string, unknown>>(snapshotKey, (current) =>
        current ? { ...current, checks: ["new check"] } : current,
      );
      await Reflect.apply(options.onError!, undefined, [
        new Error("rejected"),
        input,
        context,
        undefined,
      ]);
      expect(queryClient.getQueryData(statusKey)).toMatchObject({ pr, aheadCount: 2 });
      expect(queryClient.getQueryData(snapshotKey)).toMatchObject({
        pullRequest: pr,
        checks: ["new check"],
      });
      for (const key of [statusKey, snapshotKey, otherSnapshotKey]) {
        expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
      }
      expect(queryClient.getQueryState(unrelatedStatusKey)?.isInvalidated).toBe(false);
      queryClient.clear();
    },
  );

  it.each([
    ["git-status", "success"],
    ["git-snapshot", "success"],
    ["git-status", "failure"],
    ["git-snapshot", "failure"],
  ] as const)(
    "fences a %s refetch launched during the action and reconciles %s",
    async (cache, outcome) => {
      const queryClient = new QueryClient();
      const cwd = "/worktree";
      const input = {
        projectId: "project-a" as ProjectId,
        repository: "acme/widgets",
        number: 42,
        action: "ready",
      } as const;
      const pullRequest = {
        number: 42,
        title: "Keep optimistic status stable",
        url: "https://github.com/acme/widgets/pull/42",
        baseBranch: "main",
        headBranch: "fix/status",
        state: "open",
        isDraft: true,
        mergeability: "unknown",
        additions: null,
        deletions: null,
        changedFiles: null,
      } satisfies GitResolvedPullRequest;
      const initialStatus = {
        branch: pullRequest.headBranch,
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: true,
        upstreamBranch: `origin/${pullRequest.headBranch}`,
        aheadCount: 0,
        behindCount: 0,
        pr: pullRequest,
      } satisfies GitStatusResult;
      const initialSnapshot = {
        pullRequest,
        checks: [],
        comments: [],
        commentsTruncated: false,
        commentsError: null,
      } satisfies GitPullRequestSnapshotResult;
      const statusQuery = gitStatusQueryOptions(cwd);
      const snapshotQuery = gitPullRequestSnapshotQueryOptions({
        cwd,
        reference: pullRequest.url,
      });
      const queryKey = cache === "git-status" ? statusQuery.queryKey : snapshotQuery.queryKey;
      const fetchCurrentQuery = () =>
        cache === "git-status"
          ? queryClient.fetchQuery({ ...statusQuery, staleTime: 0 })
          : queryClient.fetchQuery({ ...snapshotQuery, staleTime: 0 });
      queryClient.setQueryData(queryKey, cache === "git-status" ? initialStatus : initialSnapshot);
      const action = pullRequestActionMutationOptions(queryClient);
      const context = await Reflect.apply(action.onMutate!, undefined, [input, undefined]);

      getGitStatus.mockResolvedValue({ ...initialStatus, aheadCount: 2 });
      getPullRequestSnapshot.mockResolvedValue({
        ...initialSnapshot,
        checks: [{ name: "In-flight check", status: "pending", url: null }],
      });
      await fetchCurrentQuery();
      const inFlightCache = queryClient.getQueryData<
        GitStatusResult | GitPullRequestSnapshotResult
      >(queryKey);
      const inFlightPullRequest =
        inFlightCache &&
        ("pullRequest" in inFlightCache ? inFlightCache.pullRequest : inFlightCache.pr);
      expect(inFlightPullRequest?.isDraft).toBe(false);

      const statusRequest = deferred<GitStatusResult>();
      const snapshotRequest = deferred<GitPullRequestSnapshotResult>();
      getGitStatus.mockReturnValue(statusRequest.promise);
      getPullRequestSnapshot.mockReturnValue(snapshotRequest.promise);
      const callsBeforeLateRefetch =
        cache === "git-status"
          ? getGitStatus.mock.calls.length
          : getPullRequestSnapshot.mock.calls.length;
      const refetch = fetchCurrentQuery();
      await vi.waitFor(() =>
        expect(
          cache === "git-status"
            ? getGitStatus.mock.calls.length
            : getPullRequestSnapshot.mock.calls.length,
        ).toBe(callsBeforeLateRefetch + 1),
      );

      const mutationError = new Error("GitHub rejected the action");
      if (outcome === "success") {
        await Reflect.apply(action.onSuccess!, undefined, [
          { workspaceRoot: cwd },
          input,
          context,
          undefined,
        ]);
      } else {
        await Reflect.apply(action.onError!, undefined, [mutationError, input, context, undefined]);
      }
      Reflect.apply(action.onSettled!, undefined, [
        outcome === "success" ? { workspaceRoot: cwd } : undefined,
        outcome === "failure" ? mutationError : null,
        input,
        context,
        undefined,
      ]);

      statusRequest.resolve({ ...initialStatus, aheadCount: 3 });
      snapshotRequest.resolve({
        ...initialSnapshot,
        checks: [{ name: "Fresh check", status: "success", url: null }],
      });
      await refetch;

      const cached = queryClient.getQueryData<GitStatusResult | GitPullRequestSnapshotResult>(
        queryKey,
      );
      const cachedPullRequest =
        cached && ("pullRequest" in cached ? cached.pullRequest : cached.pr);
      expect(cachedPullRequest?.isDraft).toBe(outcome === "failure");
      if (cache === "git-status") {
        expect(cached).toMatchObject({ aheadCount: 3 });
      } else {
        expect(cached).toMatchObject({ checks: [{ name: "Fresh check" }] });
      }
      expect(activePullRequestActionPatch(queryClient, input)).toEqual({});
      queryClient.clear();
    },
  );

  it("cancels an uncached first-open snapshot by PR identity before a late stale response", async () => {
    const queryClient = new QueryClient();
    const input = {
      projectId: "project-a" as ProjectId,
      repository: "acme/widgets",
      number: 42,
      action: "ready",
    } as const;
    const matchingPullRequest = {
      number: 42,
      title: "First-open snapshot",
      url: "https://github.com/acme/widgets/pull/42",
      baseBranch: "main",
      headBranch: "fix/status",
      state: "open",
      isDraft: true,
      mergeability: "unknown",
      additions: null,
      deletions: null,
      changedFiles: null,
    } satisfies GitResolvedPullRequest;
    const otherNumberPullRequest = {
      ...matchingPullRequest,
      number: 43,
      url: "https://github.com/acme/widgets/pull/43",
    };
    const otherRepositoryPullRequest = {
      ...matchingPullRequest,
      url: "https://github.com/other/repository/pull/42",
    };
    const snapshot = (pullRequest: GitResolvedPullRequest) =>
      ({
        pullRequest,
        checks: [],
        comments: [],
        commentsTruncated: false,
        commentsError: null,
      }) satisfies GitPullRequestSnapshotResult;
    const matchingRequest = deferred<GitPullRequestSnapshotResult>();
    const otherNumberRequest = deferred<GitPullRequestSnapshotResult>();
    const otherRepositoryRequest = deferred<GitPullRequestSnapshotResult>();
    const requestsByReference = new Map([
      [matchingPullRequest.url, matchingRequest],
      [otherNumberPullRequest.url, otherNumberRequest],
      [otherRepositoryPullRequest.url, otherRepositoryRequest],
    ]);
    getPullRequestSnapshot.mockImplementation(({ reference }) => {
      const request = requestsByReference.get(reference);
      if (!request) throw new Error(`Unexpected snapshot reference: ${reference}`);
      return request.promise;
    });

    const matchingQuery = gitPullRequestSnapshotQueryOptions({
      cwd: "/matching-worktree",
      reference: matchingPullRequest.url,
    });
    const otherNumberQuery = gitPullRequestSnapshotQueryOptions({
      cwd: "/other-pr-worktree",
      reference: otherNumberPullRequest.url,
    });
    const otherRepositoryQuery = gitPullRequestSnapshotQueryOptions({
      cwd: "/other-repository-worktree",
      reference: otherRepositoryPullRequest.url,
    });
    const fetches = [matchingQuery, otherNumberQuery, otherRepositoryQuery].map((query) =>
      queryClient.fetchQuery(query).catch(() => undefined),
    );
    await vi.waitFor(() => expect(getPullRequestSnapshot).toHaveBeenCalledTimes(3));

    const action = pullRequestActionMutationOptions(queryClient);
    const context = await Reflect.apply(action.onMutate!, undefined, [input, undefined]);
    const fetchStatusesAfterMutation = [matchingQuery, otherNumberQuery, otherRepositoryQuery].map(
      (query) => queryClient.getQueryState(query.queryKey)?.fetchStatus,
    );
    await Reflect.apply(action.onSuccess!, undefined, [
      { workspaceRoot: "/project-root" },
      input,
      context,
      undefined,
    ]);
    Reflect.apply(action.onSettled!, undefined, [
      { workspaceRoot: "/project-root" },
      null,
      input,
      context,
      undefined,
    ]);

    matchingRequest.resolve(snapshot(matchingPullRequest));
    otherNumberRequest.resolve(snapshot(otherNumberPullRequest));
    otherRepositoryRequest.resolve(snapshot(otherRepositoryPullRequest));
    await Promise.all(fetches);

    const matchingData = queryClient.getQueryData(matchingQuery.queryKey);
    const otherNumberData = queryClient.getQueryData(otherNumberQuery.queryKey);
    const otherRepositoryData = queryClient.getQueryData(otherRepositoryQuery.queryKey);
    queryClient.clear();

    expect(fetchStatusesAfterMutation).toEqual(["idle", "fetching", "fetching"]);
    expect(matchingData).toBeUndefined();
    expect(otherNumberData).toEqual(snapshot(otherNumberPullRequest));
    expect(otherRepositoryData).toEqual(snapshot(otherRepositoryPullRequest));
  });

  it("refreshes the affected worktree caches after success even when the action returns the project root", async () => {
    const queryClient = new QueryClient();
    const input = {
      projectId: "project-a" as ProjectId,
      repository: "acme/widgets",
      number: 42,
      action: "ready",
    } as const;
    const pr = {
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
      state: "open",
      isDraft: true,
    };
    const keys = [
      gitQueryKeys.status("/worktree"),
      [...gitQueryKeys.pullRequest("/worktree"), "snapshot", pr.url],
    ];
    queryClient.setQueryData(keys[0]!, { pr });
    queryClient.setQueryData(keys[1]!, { pullRequest: pr });
    const options = pullRequestActionMutationOptions(queryClient);
    const context = await Reflect.apply(options.onMutate!, undefined, [input, undefined]);
    await Reflect.apply(options.onSuccess!, undefined, [
      { workspaceRoot: "/repo" },
      input,
      context,
      undefined,
    ]);
    for (const key of keys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    queryClient.clear();
  });

  it("preserves a different branch PR when an earlier action fails after checkout", async () => {
    const queryClient = new QueryClient();
    const input = {
      projectId: "project-a" as ProjectId,
      repository: "acme/widgets",
      number: 42,
      action: "draft",
    } as const;
    const statusKey = gitQueryKeys.status("/worktree");
    queryClient.setQueryData(statusKey, {
      pr: { number: 42, url: "https://github.com/acme/widgets/pull/42", isDraft: false },
    });
    const options = pullRequestActionMutationOptions(queryClient);
    const context = await Reflect.apply(options.onMutate!, undefined, [input, undefined]);
    const checkedOutStatus = {
      pr: { number: 43, url: "https://github.com/acme/widgets/pull/43", isDraft: true },
    };
    queryClient.setQueryData(statusKey, checkedOutStatus);

    await Reflect.apply(options.onError!, undefined, [
      new Error("rejected"),
      input,
      context,
      undefined,
    ]);

    expect(queryClient.getQueryData(statusKey)).toEqual(checkedOutStatus);
    expect(queryClient.getQueryState(statusKey)?.isInvalidated).toBe(false);
    queryClient.clear();
  });

  it.each(["list", "git-status", "git-snapshot"] as const)(
    "cancels an ordinary %s refetch before applying optimistic fields",
    async (cache) => {
      const queryClient = new QueryClient();
      const projectId = "project-a" as ProjectId;
      const identity = { projectId, repository: "acme/widgets", number: 42 } as const;
      const pr = {
        ...identity,
        url: "https://github.com/acme/widgets/pull/42",
        state: "open",
        isDraft: false,
      };
      const queryKey =
        cache === "list"
          ? pullRequestQueryKeys.list({ state: "open", projectId })
          : cache === "git-status"
            ? gitQueryKeys.status("/worktree")
            : [...gitQueryKeys.pullRequest("/worktree"), "snapshot", pr.url];
      queryClient.setQueryData(
        queryKey,
        cache === "git-status"
          ? { pr }
          : cache === "git-snapshot"
            ? { pullRequest: pr }
            : {
                entries: [{ ...identity, state: "open", isDraft: false, isPinned: false }],
              },
      );
      let requestAborted = false;
      const refetch = queryClient
        .fetchQuery({
          queryKey: queryKey,
          queryFn: ({ signal }) =>
            new Promise<never>((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                requestAborted = true;
                reject(new Error("aborted"));
              });
            }),
        })
        .catch(() => undefined);
      await vi.waitFor(() => expect(queryClient.isFetching({ queryKey: queryKey })).toBe(1));
      const input = { ...identity, action: "draft" } as const;
      const options = pullRequestActionMutationOptions(queryClient);
      if (!options.onMutate) throw new Error("Action onMutate hook is missing.");

      await Reflect.apply(options.onMutate, undefined, [input, undefined]);

      expect(requestAborted).toBe(true);
      expect(queryClient.getQueryData(queryKey)).toEqual(
        cache === "git-status"
          ? { pr: { ...pr, isDraft: true } }
          : cache === "git-snapshot"
            ? { pullRequest: { ...pr, isDraft: true } }
            : {
                entries: [{ ...identity, state: "open", isDraft: true, isPinned: false }],
              },
      );
      await refetch;
      queryClient.clear();
    },
  );

  it("invalidates only repository scopes, matching detail, and the affected git PR cache", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const otherProjectId = "project-b" as ProjectId;
    const input = {
      projectId,
      repository: "acme/widgets",
      number: 42,
      action: "ready",
    } as const;
    const listKey = pullRequestQueryKeys.list({ state: "open", projectId });
    const unrelatedListKey = pullRequestQueryKeys.list({
      state: "open",
      projectId: otherProjectId,
    });
    const detailKey = pullRequestQueryKeys.detail(input);
    const otherDetailKey = pullRequestQueryKeys.detail({
      projectId,
      repository: "acme/widgets",
      number: 7,
    });
    const diffKey = pullRequestQueryKeys.diff(input);
    const reviewCountKey = pullRequestQueryKeys.reviewRequestCount(null);
    const gitStatusKey = gitQueryKeys.status("/repo");
    const gitPullRequestKey = gitQueryKeys.pullRequest("/repo");
    const unrelatedGitPullRequestKey = gitQueryKeys.pullRequest("/other-repo");
    queryClient.setQueryData(listKey, {
      entries: [
        {
          projectId,
          repository: "acme/widgets",
          number: 42,
          state: "open",
          isDraft: true,
          isPinned: false,
        },
      ],
    });
    queryClient.setQueryData(unrelatedListKey, {
      entries: [
        {
          projectId: otherProjectId,
          repository: "other/repository",
          number: 9,
          state: "open",
          isDraft: false,
          isPinned: false,
        },
      ],
    });
    for (const key of [
      detailKey,
      otherDetailKey,
      diffKey,
      reviewCountKey,
      gitStatusKey,
      gitPullRequestKey,
      unrelatedGitPullRequestKey,
    ]) {
      queryClient.setQueryData(key, {});
    }
    const options = pullRequestActionMutationOptions(queryClient);
    if (!options.onMutate || !options.onSuccess) throw new Error("Action hooks are missing.");

    const context = await Reflect.apply(options.onMutate, undefined, [input, undefined]);
    await Reflect.apply(options.onSuccess, undefined, [
      { workspaceRoot: "/repo" },
      input,
      context,
      undefined,
    ]);

    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(unrelatedListKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherDetailKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(diffKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(reviewCountKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(gitStatusKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(gitPullRequestKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(unrelatedGitPullRequestKey)?.isInvalidated).toBe(false);
  });

  it("invalidates every cached detail in the repository after an atomic merge", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const input = {
      projectId,
      repository: "acme/widgets",
      number: 42,
      action: "merge",
      mergeMethod: "squash",
    } as const;
    const selectedDetail = pullRequestQueryKeys.detail(input);
    const lowerStackDetail = pullRequestQueryKeys.detail({
      projectId,
      repository: "acme/widgets",
      number: 41,
    });
    const unrelatedDetail = pullRequestQueryKeys.detail({
      projectId,
      repository: "acme/other",
      number: 41,
    });
    for (const key of [selectedDetail, lowerStackDetail, unrelatedDetail]) {
      queryClient.setQueryData(key, {});
    }

    const options = pullRequestActionMutationOptions(queryClient);
    if (!options.onMutate || !options.onSuccess) throw new Error("Action hooks are missing.");
    const context = await Reflect.apply(options.onMutate, undefined, [input, undefined]);
    await Reflect.apply(options.onSuccess, undefined, [
      { workspaceRoot: "/repo", mergeOutcome: "merged" },
      input,
      context,
      undefined,
    ]);

    expect(queryClient.getQueryState(selectedDetail)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(lowerStackDetail)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(unrelatedDetail)?.isInvalidated).toBe(false);
  });

  it("updates the global row when an action starts from another associated project", async () => {
    const queryClient = new QueryClient();
    const projectA = "project-a" as ProjectId;
    const projectB = "project-b" as ProjectId;
    const input = {
      projectId: projectA,
      repository: "acme/widgets",
      number: 42,
      action: "ready",
    } as const;
    const globalListKey = pullRequestQueryKeys.list({ state: "open", projectId: null });
    queryClient.setQueryData(globalListKey, {
      entries: [
        {
          projectId: projectB,
          repository: "acme/widgets",
          number: 42,
          state: "open",
          isDraft: true,
          isPinned: false,
        },
      ],
    });
    const options = pullRequestActionMutationOptions(queryClient);
    if (!options.onMutate || !options.onSuccess) throw new Error("Action hooks are missing.");

    const context = await Reflect.apply(options.onMutate, undefined, [input, undefined]);
    expect(queryClient.getQueryData(globalListKey)).toMatchObject({
      entries: [{ projectId: projectB, isDraft: false }],
    });
    await Reflect.apply(options.onSuccess, undefined, [
      { workspaceRoot: "/repo" },
      input,
      context,
      undefined,
    ]);
    expect(queryClient.getQueryState(globalListKey)?.isInvalidated).toBe(true);
  });

  it("does not keep an action pending on the passive review-count refresh", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const input = {
      projectId,
      repository: "acme/widgets",
      number: 42,
      action: "ready",
    } as const;
    const listKey = pullRequestQueryKeys.list({ state: "open", projectId });
    queryClient.setQueryData(listKey, {
      entries: [{ ...input, state: "open", isDraft: true, isPinned: false }],
    });
    const originalInvalidateQueries = queryClient.invalidateQueries.bind(queryClient);
    let reviewCountRefreshStarted = false;
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation((filters, options) => {
      if (filters?.queryKey === pullRequestQueryKeys.reviewRequestCounts) {
        reviewCountRefreshStarted = true;
        return new Promise<void>(() => undefined);
      }
      return originalInvalidateQueries(filters, options);
    });
    const mutation = pullRequestActionMutationOptions(queryClient);
    if (!mutation.onMutate || !mutation.onSuccess) throw new Error("Action hooks are missing.");

    const context = await Reflect.apply(mutation.onMutate, undefined, [input, undefined]);
    await Reflect.apply(mutation.onSuccess, undefined, [
      { workspaceRoot: "/repo" },
      input,
      context,
      undefined,
    ]);

    expect(reviewCountRefreshStarted).toBe(true);
  });

  it("invalidates the warm merged lists after a merge", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const input = {
      projectId,
      repository: "acme/widgets",
      number: 42,
      action: "merge",
    } as const;
    const openKey = pullRequestQueryKeys.list({ state: "open", projectId });
    const mergedKey = pullRequestQueryKeys.list({ state: "merged", projectId });
    const allProjectsMergedKey = pullRequestQueryKeys.list({ state: "merged", projectId: null });
    const mergedExactKey = pullRequestQueryKeys.exactList({
      involvement: "authored",
      state: "merged",
      projectId,
    });
    queryClient.setQueryData(openKey, {
      entries: [{ ...input, state: "open", isDraft: false, isPinned: false }],
    });
    queryClient.setQueryData(mergedKey, { entries: [] });
    queryClient.setQueryData(allProjectsMergedKey, { entries: [] });
    queryClient.setQueryData(mergedExactKey, { entries: [] });
    const options = pullRequestActionMutationOptions(queryClient);
    if (!options.onMutate || !options.onSuccess) throw new Error("Action hooks are missing.");

    const context = await Reflect.apply(options.onMutate, undefined, [input, undefined]);
    await Reflect.apply(options.onSuccess, undefined, [
      { workspaceRoot: "/repo" },
      input,
      context,
      undefined,
    ]);

    expect(queryClient.getQueryState(openKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(mergedKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(allProjectsMergedKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(mergedExactKey)?.isInvalidated).toBe(true);
  });

  it("rolls list-owned fields back even when no detail cache exists", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const identity = { projectId, repository: "acme/widgets", number: 42 } as const;
    const listKey = pullRequestQueryKeys.list({ state: "open", projectId });
    queryClient.setQueryData(listKey, {
      entries: [{ ...identity, state: "open", isDraft: false, isPinned: false, title: "before" }],
    });
    const input = { ...identity, action: "draft" } as const;
    const options = pullRequestActionMutationOptions(queryClient);
    if (!options.onMutate || !options.onError) throw new Error("Action hooks are missing.");

    const context = await Reflect.apply(options.onMutate, undefined, [input, undefined]);
    queryClient.setQueryData(listKey, (current: { entries: Array<Record<string, unknown>> }) => ({
      ...current,
      entries: current.entries.map((entry) => ({ ...entry, title: "fresh" })),
    }));
    await Reflect.apply(options.onError, undefined, [
      new Error("action failed"),
      input,
      context,
      undefined,
    ]);

    expect(queryClient.getQueryData(listKey)).toEqual({
      entries: [{ ...identity, state: "open", isDraft: false, isPinned: false, title: "fresh" }],
    });
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
  });
});
