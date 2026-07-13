import type { PullRequestInvolvement, PullRequestState } from "@synara/contracts";
export { isValidGitHubRepositoryNameWithOwner } from "@synara/shared/githubRepository";

export function pullRequestListCacheKey(
  repository: string,
  state: PullRequestState,
  involvement: PullRequestInvolvement,
  viewer: string,
): string {
  return `${repository.trim().toLowerCase()}:${state}:${involvement}:${viewer.trim().toLowerCase()}`;
}
