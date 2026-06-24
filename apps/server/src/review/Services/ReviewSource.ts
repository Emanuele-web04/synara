import {
  ReviewAgentResult,
  ReviewBoardLanesResult,
  ReviewChangesetResult,
  ReviewCheckProjectAccessInput,
  ReviewGetProjectBoardInput,
  ReviewGetViewerInput,
  ReviewListProjectsInput,
  ReviewListProjectsResult,
  ReviewListPullRequestsInput,
  ReviewListPullRequestsResult,
  ReviewLoadBoardLanesInput,
  ReviewLoadChangesetInput,
  ReviewMoveProjectCardInput,
  ReviewMoveProjectCardResult,
  ReviewProjectAccessResult,
  ReviewConversationResult,
  ReviewProjectBoard,
  ReviewPullRequestHeader,
  ReviewPullRequestOverview,
  ReviewPullRequestQueryInput,
  ReviewPullRequestSurfaceInput,
  ReviewPullRequestSurfaceResult,
  ReviewRunAgentInput,
  ReviewGenerateWalkthroughInput,
  ReviewWalkthroughResult,
  ReviewViewerResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ReviewServiceError } from "../Errors.ts";

export interface ReviewSourceShape {
  readonly listPullRequests: (
    input: ReviewListPullRequestsInput,
  ) => Effect.Effect<ReviewListPullRequestsResult, ReviewServiceError>;

  readonly loadBoardLanes: (
    input: ReviewLoadBoardLanesInput,
  ) => Effect.Effect<ReviewBoardLanesResult, ReviewServiceError>;

  readonly getViewer: (
    input: ReviewGetViewerInput,
  ) => Effect.Effect<ReviewViewerResult, ReviewServiceError>;

  readonly loadChangeset: (
    input: ReviewLoadChangesetInput,
  ) => Effect.Effect<ReviewChangesetResult, ReviewServiceError>;

  readonly loadPullRequest: (
    input: ReviewPullRequestQueryInput,
  ) => Effect.Effect<ReviewPullRequestOverview, ReviewServiceError>;

  readonly loadPullRequestHeader: (
    input: ReviewPullRequestQueryInput,
  ) => Effect.Effect<ReviewPullRequestHeader, ReviewServiceError>;

  readonly loadConversation: (
    input: ReviewPullRequestQueryInput,
  ) => Effect.Effect<ReviewConversationResult, ReviewServiceError>;

  readonly loadPullRequestSurface: (
    input: ReviewPullRequestSurfaceInput,
  ) => Effect.Effect<ReviewPullRequestSurfaceResult, ReviewServiceError>;

  readonly runAgentReview: (
    input: ReviewRunAgentInput,
  ) => Effect.Effect<ReviewAgentResult, ReviewServiceError>;

  readonly generateWalkthrough: (
    input: ReviewGenerateWalkthroughInput,
  ) => Effect.Effect<ReviewWalkthroughResult, ReviewServiceError>;

  readonly checkProjectAccess: (
    input: ReviewCheckProjectAccessInput,
  ) => Effect.Effect<ReviewProjectAccessResult, ReviewServiceError>;

  readonly listProjects: (
    input: ReviewListProjectsInput,
  ) => Effect.Effect<ReviewListProjectsResult, ReviewServiceError>;

  readonly getProjectBoard: (
    input: ReviewGetProjectBoardInput,
  ) => Effect.Effect<ReviewProjectBoard, ReviewServiceError>;

  readonly moveProjectCard: (
    input: ReviewMoveProjectCardInput,
  ) => Effect.Effect<ReviewMoveProjectCardResult, ReviewServiceError>;
}

export class ReviewSource extends ServiceMap.Service<ReviewSource, ReviewSourceShape>()(
  "t3/review/Services/ReviewSource",
) {}
