import { Layer } from "effect";

import { GitCoreLive } from "../git/Layers/GitCore";
import { GitHubCliLive } from "../git/Layers/GitHubCli";
import { GitManagerLayerLive, TextGenerationLayerLive } from "../git/runtimeLayer";
import { ReviewCacheStoreLive } from "./Layers/ReviewCacheStore";
import { ReviewCommentStoreLive } from "./Layers/ReviewCommentStore";
import { ReviewSourceLive } from "./Layers/ReviewSource";
import { ReviewSubmissionLive } from "./Layers/ReviewSubmission";
import { ReviewUpdateBusLive } from "./Layers/ReviewUpdateBus";

const ReviewSourceDependencyLayerLive = Layer.mergeAll(ReviewCacheStoreLive, ReviewUpdateBusLive);

const ReviewSourceLayerLive = ReviewSourceLive.pipe(
  Layer.provideMerge(ReviewSourceDependencyLayerLive),
);

export const ReviewLayerLive = Layer.mergeAll(
  ReviewSourceLayerLive,
  ReviewSubmissionLive,
  ReviewCommentStoreLive,
).pipe(
  Layer.provide(
    Layer.mergeAll(GitCoreLive, GitHubCliLive, GitManagerLayerLive, TextGenerationLayerLive),
  ),
);
