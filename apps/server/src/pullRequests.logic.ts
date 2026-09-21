import type {
  PullRequestActor,
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestState,
} from "@synara/contracts";

import type { GitHubPullRequestListItem } from "./git/Services/GitHubCli.ts";
export { isValidGitHubRepositoryNameWithOwner } from "@synara/shared/githubRepository";

export function pullRequestListCacheKey(
  repository: string,
  state: PullRequestState,
  involvement: PullRequestInvolvement,
  viewer: string,
): string {
  return `${repository.trim().toLowerCase()}:${state}:${involvement}:${viewer.trim().toLowerCase()}`;
}

/** a force refresh invalidates every sibling involvement cache for the same repo/state — the caller still decides which queries are needed */
export function pullRequestListForceRefreshCacheKeys(input: {
  repository: string;
  state: PullRequestState;
  viewer: string;
}): string[] {
  return (["all", "authored", "reviewing"] as const).map((involvement) =>
    pullRequestListCacheKey(input.repository, input.state, involvement, input.viewer),
  );
}

export function repositoryPullRequestIdentityKey(input: {
  repository: string;
  number: number;
}): string {
  return `${input.repository.trim().toLowerCase()}\u0000${input.number}`;
}

/** repo casing isn't significant on GitHub while the project id stays in the key so two projects on the same repo can prioritize the same PR independently */
export function projectPullRequestIdentityKey(input: {
  projectId: string;
  repository: string;
  number: number;
}): string {
  return `${input.projectId}\u0000${input.repository.trim().toLowerCase()}\u0000${input.number}`;
}

/** only pins whose own batch was cut off by the list cap — keeps recovery from probing complete lists and prevents a stale project pin borrowing a repo configured by a different project */
export function selectRecoverablePullRequestPins<
  P extends string,
  T extends { projectId: P; repositoryKey: string; number: number },
>(input: {
  pins: ReadonlyArray<T>;
  presentKeys: ReadonlySet<string>;
  repositoryKeysByProject: ReadonlyMap<P, ReadonlySet<string>>;
  batches: ReadonlyArray<{
    repository: string;
    truncated: boolean;
    projectIds: ReadonlyArray<P>;
  }>;
}): T[] {
  const batches = new Map(
    input.batches.map((batch) => [batch.repository.trim().toLowerCase(), batch] as const),
  );
  return input.pins.filter((pin) => {
    const repository = pin.repositoryKey.trim().toLowerCase();
    const batch = batches.get(repository);
    return (
      batch?.truncated === true &&
      batch.projectIds.includes(pin.projectId) &&
      input.repositoryKeysByProject.get(pin.projectId)?.has(repository) === true &&
      !input.presentKeys.has(
        projectPullRequestIdentityKey({
          projectId: pin.projectId,
          repository,
          number: pin.number,
        }),
      )
    );
  });
}

/** one mapping shared by the capped batch path and pinned-PR recovery so the two can never drift */
export function buildPullRequestListEntry(input: {
  project: { id: PullRequestListEntry["projectId"]; title: string };
  repository: string;
  pullRequest: GitHubPullRequestListItem;
  viewerReviewRequested: boolean;
  isPinned: boolean;
}): PullRequestListEntry {
  const { pullRequest } = input;
  return {
    projectId: input.project.id,
    projectTitle: input.project.title,
    repository: input.repository,
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    author: pullRequest.author,
    headBranch: pullRequest.headBranch,
    baseBranch: pullRequest.baseBranch,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    reviewDecision: pullRequest.reviewDecision,
    viewerReviewRequested: input.viewerReviewRequested,
    isPinned: input.isPinned,
    projectContexts: [
      {
        projectId: input.project.id,
        projectTitle: input.project.title,
        isPinned: input.isPinned,
      },
    ],
    mergeability: pullRequest.mergeability,
    stack: pullRequest.stack,
    labels: pullRequest.labels,
  };
}

/** pinned work is first; each section otherwise keeps newest-updated-first */
export function orderPullRequestListEntries(
  entries: readonly PullRequestListEntry[],
): PullRequestListEntry[] {
  return [...entries].toSorted(
    (left, right) =>
      Number(right.isPinned) - Number(left.isPinned) ||
      right.updatedAt.localeCompare(left.updatedAt),
  );
}

export function isViewerReviewRequested(
  author: PullRequestActor | null,
  reviewRequestLogins: ReadonlyArray<string>,
  viewer: string,
  matchedReviewingQuery = false,
): boolean {
  const normalizedViewer = viewer.trim().toLowerCase();
  return (
    author?.login.trim().toLowerCase() !== normalizedViewer &&
    (matchedReviewingQuery ||
      reviewRequestLogins.some((login) => login.trim().toLowerCase() === normalizedViewer))
  );
}

/** matchedReviewingQuery carries GitHub's authoritative result incl. team review requests not inferable from the PR's user-only logins */
export function pullRequestMatchesInvolvement(
  pullRequest: Pick<GitHubPullRequestListItem, "author" | "reviewRequestLogins">,
  involvement: PullRequestInvolvement,
  viewer: string,
  matchedReviewingQuery = false,
): boolean {
  if (involvement === "all") return true;
  if (involvement === "reviewing") {
    return isViewerReviewRequested(
      pullRequest.author,
      pullRequest.reviewRequestLogins,
      viewer,
      matchedReviewingQuery,
    );
  }
  return pullRequest.author?.login.trim().toLowerCase() === viewer.trim().toLowerCase();
}

/** closed/merged PRs can't have an active review request so the companion query only adds info to the open list */
export function shouldLoadReviewingCompanion(
  state: PullRequestState,
  involvement: PullRequestInvolvement,
): boolean {
  return state === "open" && involvement === "all";
}

export function isPullRequestMergeMethodAllowed(
  capabilities: PullRequestMergeCapabilities,
  method: PullRequestMergeMethod,
): boolean {
  return capabilities[method];
}
