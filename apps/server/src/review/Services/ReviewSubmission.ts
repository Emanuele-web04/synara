import {
  ReviewLoadRemoteThreadsInput,
  ReviewRemoteThreadsResult,
  ReviewReplyThreadInput,
  ReviewReplyThreadResult,
  ReviewResolveThreadInput,
  ReviewResolveThreadResult,
  ReviewUpdateThreadCommentInput,
  ReviewDeleteThreadCommentInput,
  ReviewThreadCommentMutationResult,
  ReviewSubmitInput,
  ReviewSubmitResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ReviewServiceError } from "../Errors.ts";

export interface ReviewSubmissionShape {
  readonly submit: (
    input: ReviewSubmitInput,
  ) => Effect.Effect<ReviewSubmitResult, ReviewServiceError>;

  readonly loadThreads: (
    input: ReviewLoadRemoteThreadsInput,
  ) => Effect.Effect<ReviewRemoteThreadsResult, ReviewServiceError>;

  readonly resolveThread: (
    input: ReviewResolveThreadInput,
  ) => Effect.Effect<ReviewResolveThreadResult, ReviewServiceError>;

  readonly replyThread: (
    input: ReviewReplyThreadInput,
  ) => Effect.Effect<ReviewReplyThreadResult, ReviewServiceError>;

  readonly updateThreadComment: (
    input: ReviewUpdateThreadCommentInput,
  ) => Effect.Effect<ReviewThreadCommentMutationResult, ReviewServiceError>;

  readonly deleteThreadComment: (
    input: ReviewDeleteThreadCommentInput,
  ) => Effect.Effect<ReviewThreadCommentMutationResult, ReviewServiceError>;
}

export class ReviewSubmission extends ServiceMap.Service<ReviewSubmission, ReviewSubmissionShape>()(
  "t3/review/Services/ReviewSubmission",
) {}
