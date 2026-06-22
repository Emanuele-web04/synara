import { Layer } from "effect";

import { GitCoreLive } from "../git/Layers/GitCore";
import { GitHubCliLive } from "../git/Layers/GitHubCli";
import { GitManagerLayerLive, TextGenerationLayerLive } from "../git/runtimeLayer";
import { ReviewCacheStoreLive } from "./Layers/ReviewCacheStore";
import { ReviewCommentStoreLive } from "./Layers/ReviewCommentStore";
import { ReviewPullRequestStoreLive } from "./Layers/ReviewPullRequestStore";
import { ReviewRemoteSourceLive } from "./Layers/ReviewRemoteSource";
import { ReviewSourceLive } from "./Layers/ReviewSource";
import { ReviewSubmissionLive } from "./Layers/ReviewSubmission";
import { ReviewSyncLive } from "./Layers/ReviewSync";
import { ReviewUpdateBusLive } from "./Layers/ReviewUpdateBus";

const ReviewSyncLayerLive = ReviewSyncLive.pipe(
  Layer.provideMerge(Layer.mergeAll(ReviewPullRequestStoreLive, ReviewRemoteSourceLive)),
);

const ReviewSourceDependencyLayerLive = Layer.mergeAll(
  ReviewCacheStoreLive,
  ReviewUpdateBusLive,
  ReviewSyncLayerLive,
);

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
