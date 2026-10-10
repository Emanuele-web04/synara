import type {
  GitHubViewerInvolvement,
  PullRequestActor,
  PullRequestListEntry,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
} from "@synara/contracts";

import type { GitHubInboxPullRequest } from "./git/Services/GitHubCli.ts";
export { isValidGitHubRepositoryNameWithOwner } from "@synara/shared/githubRepository";

/** Repository-wide PR identity used to coalesce the same remote lookup across local projects. */
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

/** One mapping from an inbox pull request to the wire entry, shared by the snapshot path and the
 * individual pinned-item recovery path so the two can never drift. */
export function buildPullRequestListEntry(input: {
  project: { id: PullRequestListEntry["projectId"]; title: string };
  repository: string;
  pullRequest: GitHubInboxPullRequest;
  viewerReviewRequested: boolean;
  viewerInvolvement: GitHubViewerInvolvement;
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
    commentCount: pullRequest.commentCount,
    assignees: pullRequest.assignees,
    viewerInvolvement: input.viewerInvolvement,
  };
}

/** Pinned work is the first thing the user sees; each section otherwise retains the existing
 * newest-updated-first ordering. */
export function orderPullRequestListEntries<
  T extends { readonly isPinned?: boolean | undefined; readonly updatedAt: string },
>(entries: readonly T[]): T[] {
  return [...entries].toSorted(
    (left, right) =>
      Number(right.isPinned === true) - Number(left.isPinned === true) ||
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

export function isPullRequestMergeMethodAllowed(
  capabilities: PullRequestMergeCapabilities,
  method: PullRequestMergeMethod,
): boolean {
  return capabilities[method];
}
