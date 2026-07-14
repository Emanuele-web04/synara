import type {
  ProjectId,
  PullRequestActionInput,
  PullRequestDetailInput,
  PullRequestInvolvement,
  PullRequestsListInput,
  PullRequestState,
} from "@synara/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import { gitQueryKeys } from "~/lib/gitReactQuery";
import { ensureNativeApi } from "~/nativeApi";

export const pullRequestQueryKeys = {
  all: ["pull-requests"] as const,
  list: (input: {
    involvement: PullRequestInvolvement;
    state: PullRequestState;
    projectId: ProjectId | null;
  }) => ["pull-requests", "list", input.involvement, input.state, input.projectId] as const,
  detail: (input: PullRequestDetailInput | null) =>
    [
      "pull-requests",
      "detail",
      input?.projectId ?? null,
      input?.repository ?? null,
      input?.number ?? null,
    ] as const,
  diff: (input: PullRequestDetailInput | null) =>
    [
      "pull-requests",
      "diff",
      input?.projectId ?? null,
      input?.repository ?? null,
      input?.number ?? null,
    ] as const,
};

function normalizePullRequestListKeyInput(input: {
  involvement?: PullRequestInvolvement | undefined;
  state: PullRequestState;
  projectId?: ProjectId | null | undefined;
}) {
  return {
    involvement: input.involvement ?? "all",
    state: input.state,
    projectId: input.projectId ?? null,
  };
}

export function pullRequestsListQueryOptions(input: {
  involvement: PullRequestInvolvement;
  state: PullRequestState;
  projectId: ProjectId | null;
}) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.list(input),
    queryFn: () => ensureNativeApi().pullRequests.list(input),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: "always",
  });
}

export function pullRequestDetailQueryOptions(input: PullRequestDetailInput | null) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.detail(input),
    queryFn: () => {
      if (!input) throw new Error("Pull request detail is unavailable.");
      return ensureNativeApi().pullRequests.detail(input);
    },
    enabled: input !== null,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function pullRequestDiffQueryOptions(input: PullRequestDetailInput | null) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.diff(input),
    queryFn: () => {
      if (!input) throw new Error("Pull request diff is unavailable.");
      return ensureNativeApi().pullRequests.diff(input);
    },
    enabled: input !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

export function pullRequestActionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ["pull-requests", "action"] as const,
    mutationFn: (input: PullRequestActionInput) => ensureNativeApi().pullRequests.action(input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: pullRequestQueryKeys.all }),
        // A PR pane can be opened from a worktree while the action RPC resolves through the
        // owning project's root, so invalidate every active status/snapshot view of the PR.
        queryClient.invalidateQueries({ queryKey: gitQueryKeys.statuses }),
        queryClient.invalidateQueries({ queryKey: gitQueryKeys.pullRequests }),
      ]);
    },
  });
}

export function pullRequestsForceRefreshMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ["pull-requests", "force-refresh"] as const,
    mutationFn: (input: Omit<PullRequestsListInput, "forceRefresh">) =>
      ensureNativeApi().pullRequests.list({ ...input, forceRefresh: true }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({
        queryKey: pullRequestQueryKeys.list(normalizePullRequestListKeyInput(input)),
        exact: true,
      });
    },
    onSuccess: async (result, input) => {
      queryClient.setQueryData(
        pullRequestQueryKeys.list(normalizePullRequestListKeyInput(input)),
        result,
      );
      await queryClient.invalidateQueries({ queryKey: pullRequestQueryKeys.all });
    },
  });
}
