import type {
  PullRequestActionInput,
  PullRequestActionResult,
  PullRequestCommentInput,
  PullRequestDetail,
  PullRequestDetailInput,
  PullRequestDiffResult,
  PullRequestSetPinnedInput,
  PullRequestSetPinnedResult,
  WorkItemAuthStatus,
  WorkItemSearchInput,
  WorkItemSearchResult,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

/** Pull request detail, diff, actions, comments, and pins. Listing lives in the GitHub inbox. */
export interface PullRequestServiceShape {
  readonly detail: (input: PullRequestDetailInput) => Effect.Effect<PullRequestDetail, unknown>;
  readonly diff: (input: PullRequestDetailInput) => Effect.Effect<PullRequestDiffResult, unknown>;
  readonly action: (
    input: PullRequestActionInput,
  ) => Effect.Effect<PullRequestActionResult, unknown>;
  readonly comment: (
    input: PullRequestCommentInput,
  ) => Effect.Effect<PullRequestActionResult, unknown>;
  /** Pins pull requests and issues alike; see the note in `githubInbox.ts`. */
  readonly setPinned: (
    input: PullRequestSetPinnedInput,
  ) => Effect.Effect<PullRequestSetPinnedResult, unknown>;
  /**
   * Search the project's GitHub repository for open issues and pull requests.
   */
  readonly searchWorkItems: (
    input: WorkItemSearchInput & { repository: string },
  ) => Effect.Effect<WorkItemSearchResult, unknown>;
  /**
   * Cheap probe for the composer attach affordance: reports whether gh is
   * installed and authenticated. Repository resolution stays with the caller.
   */
  readonly workItemsAuthStatus: (input: {
    cwd: string;
  }) => Effect.Effect<WorkItemAuthStatus, unknown>;
}

export class PullRequestService extends ServiceMap.Service<
  PullRequestService,
  PullRequestServiceShape
>()("synara/pullRequests/Services/PullRequestService/PullRequestService") {}
