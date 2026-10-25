// Compatibility facade for the pull-request React Query layer. Keep callers on this stable
// entrypoint while focused modules own query definitions, cache transforms, and mutation flows.
// Lists come from the GitHub inbox query, re-exported here for the pull request surfaces.
export {
  GITHUB_INBOX_STATES,
  githubInboxListQueryOptions,
  githubInboxQueryKeys,
  githubInboxReviewBadgeQueryOptions,
} from "./githubInboxQueryOptions";

export {
  pullRequestAutoFixQueryOptions,
  pullRequestDetailQueryOptions,
  pullRequestDiffQueryOptions,
  pullRequestQueryErrorState,
  pullRequestQueryKeys,
} from "./pullRequestQueryOptions";

export { githubInboxStateForPullRequestState } from "./pullRequestCache";

export {
  pullRequestActionMutationOptions,
  pullRequestCommentMutationOptions,
  pullRequestMutationKeys,
  pullRequestsForceRefreshMutationOptions,
  pullRequestSetAutoFixMutationOptions,
  pullRequestSetPinnedMutationOptions,
} from "./pullRequestMutationOptions";
