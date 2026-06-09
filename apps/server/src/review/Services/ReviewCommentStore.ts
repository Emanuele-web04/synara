import {
  ReviewAddCommentInput,
  ReviewCommentList,
  ReviewListCommentsInput,
  ReviewLocalComment,
  ReviewRemoveCommentInput,
  ReviewRemoveCommentResult,
  ReviewUpdateCommentInput,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ReviewServiceError } from "../Errors.ts";

export interface ReviewCommentStoreShape {
  readonly list: (
    input: ReviewListCommentsInput,
  ) => Effect.Effect<ReviewCommentList, ReviewServiceError>;

  readonly add: (
    input: ReviewAddCommentInput,
  ) => Effect.Effect<ReviewLocalComment, ReviewServiceError>;

  readonly update: (
    input: ReviewUpdateCommentInput,
  ) => Effect.Effect<ReviewLocalComment, ReviewServiceError>;

  readonly remove: (
    input: ReviewRemoveCommentInput,
  ) => Effect.Effect<ReviewRemoveCommentResult, ReviewServiceError>;
}

export class ReviewCommentStore extends ServiceMap.Service<
  ReviewCommentStore,
  ReviewCommentStoreShape
>()("t3/review/Services/ReviewCommentStore") {}
