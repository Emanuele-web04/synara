import {
  ReviewLoadRemoteThreadsInput,
  ReviewRemoteThreadsResult,
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
}

export class ReviewSubmission extends ServiceMap.Service<ReviewSubmission, ReviewSubmissionShape>()(
  "t3/review/Services/ReviewSubmission",
) {}
