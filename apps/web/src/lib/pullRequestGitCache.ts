// Synchronizes Git-backed PR badges and Environment snapshots with PR actions.
// Remote identity reaches every cached worktree without touching unrelated repositories.
import type {
  GitPullRequestSnapshotResult,
  GitStatusResult,
  PullRequestDetailInput,
} from "@synara/contracts";
import { parseGitHubRepositoryNameWithOwnerFromPullRequestUrl } from "@synara/shared/githubRepository";
import type { QueryClient, QueryFilters, QueryKey } from "@tanstack/react-query";

import type { PullRequestActionListPatch } from "./pullRequestCache";

type GitPullRequestCache = GitStatusResult | GitPullRequestSnapshotResult;
type GitPullRequest = NonNullable<GitStatusResult["pr"]>;
type PullRequestIdentity = Pick<PullRequestDetailInput, "repository" | "number">;

export type GitPullRequestActionRollback = {
  queryKey: QueryKey;
  previousFields: PullRequestActionListPatch;
};

function cachedPullRequest(data: GitPullRequestCache | undefined): GitPullRequest | null {
  if (!data) return null;
  return ("pullRequest" in data ? data.pullRequest : data.pr) ?? null;
}

function matchesPullRequest(pr: GitPullRequest | null, input: PullRequestIdentity): boolean {
  return (
    pr !== null &&
    pr.number === input.number &&
    parseGitHubRepositoryNameWithOwnerFromPullRequestUrl(pr.url)?.toLowerCase() ===
      input.repository.toLowerCase()
  );
}

export function pullRequestGitQueryFilters(
  input: PullRequestIdentity,
  workspaceRoot?: string,
): QueryFilters {
  return {
    queryKey: ["git"],
    predicate: (query) => {
      const key = query.queryKey;
      // Include the existing project-root PR invalidation in the same pass, avoiding
      // duplicate refetches when the open Environment belongs to that root.
      if (workspaceRoot !== undefined && key[1] === "pull-request" && key[2] === workspaceRoot) {
        return true;
      }
      return (
        (key[1] === "status" || (key[1] === "pull-request" && key[3] === "snapshot")) &&
        matchesPullRequest(
          cachedPullRequest(query.state.data as GitPullRequestCache | undefined),
          input,
        )
      );
    },
  };
}

function patchCachedPullRequest(
  data: GitPullRequestCache,
  patch: PullRequestActionListPatch,
): GitPullRequestCache {
  if ("pullRequest" in data) return { ...data, pullRequest: { ...data.pullRequest, ...patch } };
  return data.pr ? { ...data, pr: { ...data.pr, ...patch } } : data;
}

// Called after cancelling matching reads so their old response cannot erase the optimistic state.
export function optimisticallyPatchPullRequestGitCaches(
  queryClient: QueryClient,
  input: PullRequestIdentity,
  patch: PullRequestActionListPatch,
): GitPullRequestActionRollback[] {
  if (Object.keys(patch).length === 0) return [];
  const rollback: GitPullRequestActionRollback[] = [];
  for (const [queryKey, data] of queryClient.getQueriesData<GitPullRequestCache>(
    pullRequestGitQueryFilters(input),
  )) {
    const pr = cachedPullRequest(data);
    if (!data || !pr) continue;
    rollback.push({
      queryKey,
      previousFields: {
        ...(patch.state !== undefined ? { state: pr.state } : {}),
        ...(patch.isDraft !== undefined ? { isDraft: pr.isDraft } : {}),
      },
    });
    queryClient.setQueryData(queryKey, patchCachedPullRequest(data, patch));
  }
  return rollback;
}

// Restore only action-owned fields; a checkout or newer Git/check data must survive failure.
export function rollbackPullRequestGitCaches(input: {
  queryClient: QueryClient;
  identity: PullRequestIdentity;
  optimisticPatch: PullRequestActionListPatch;
  rollback: ReadonlyArray<GitPullRequestActionRollback>;
}) {
  for (const { queryKey, previousFields } of input.rollback) {
    input.queryClient.setQueryData<GitPullRequestCache>(queryKey, (current) => {
      const pr = cachedPullRequest(current);
      if (!current || !pr || !matchesPullRequest(pr, input.identity)) return current;
      return patchCachedPullRequest(current, {
        ...(previousFields.state !== undefined && pr.state === input.optimisticPatch.state
          ? { state: previousFields.state }
          : {}),
        ...(previousFields.isDraft !== undefined && pr.isDraft === input.optimisticPatch.isDraft
          ? { isDraft: previousFields.isDraft }
          : {}),
      });
    });
  }
}
