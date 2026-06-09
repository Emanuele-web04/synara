import type { ReviewUpdatedPayload } from "@t3tools/contracts";
import { Effect, Layer, PubSub, Stream } from "effect";

import { ReviewUpdateBus } from "../Services/ReviewUpdateBus.ts";

const makeReviewUpdateBus = Effect.gen(function* () {
  const pubSub = yield* PubSub.sliding<ReviewUpdatedPayload>(64);

  return {
    publish: (payload: ReviewUpdatedPayload) => PubSub.publish(pubSub, payload).pipe(Effect.asVoid),
    stream: Stream.fromPubSub(pubSub),
  };
});

export const ReviewUpdateBusLive = Layer.effect(ReviewUpdateBus, makeReviewUpdateBus);
