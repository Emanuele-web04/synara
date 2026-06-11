import type { ReviewUpdatedPayload } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export interface ReviewUpdateBusShape {
  readonly publish: (payload: ReviewUpdatedPayload) => Effect.Effect<void>;
  readonly stream: Stream.Stream<ReviewUpdatedPayload>;
}

export class ReviewUpdateBus extends ServiceMap.Service<ReviewUpdateBus, ReviewUpdateBusShape>()(
  "t3/review/Services/ReviewUpdateBus",
) {}
