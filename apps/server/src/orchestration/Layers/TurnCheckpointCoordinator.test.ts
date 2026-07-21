import { ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";

import { TurnCheckpointCoordinator } from "../Services/TurnCheckpointCoordinator.ts";
import { TurnCheckpointCoordinatorLive } from "./TurnCheckpointCoordinator.ts";

it.layer(TurnCheckpointCoordinatorLive)("TurnCheckpointCoordinator", (it) => {
  it.effect("keeps a turn activation behind a validated checkpoint mutation", () =>
    Effect.gen(function* () {
      const coordinator = yield* TurnCheckpointCoordinator;
      const threadId = ThreadId.makeUnsafe("thread-revert-turn-exclusion");
      const validationFinished = yield* Deferred.make<void>();
      const resumeCheckpointMutation = yield* Deferred.make<void>();
      const turnActivationAttempted = yield* Deferred.make<void>();
      const order = yield* Ref.make<ReadonlyArray<string>>([]);

      const revertFiber = yield* coordinator
        .withThreadLease(
          threadId,
          Effect.gen(function* () {
            yield* Deferred.succeed(validationFinished, undefined);
            yield* Deferred.await(resumeCheckpointMutation);
            yield* Ref.update(order, (entries) => [...entries, "checkpoint-mutation"]);
          }),
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(validationFinished);
      const turnFiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(turnActivationAttempted, undefined);
        yield* coordinator.withThreadLease(
          threadId,
          Ref.update(order, (entries) => [...entries, "turn-activation"]),
        );
      }).pipe(Effect.forkChild);

      yield* Deferred.await(turnActivationAttempted);
      yield* Effect.yieldNow;
      assert.deepEqual(yield* Ref.get(order), []);

      yield* Deferred.succeed(resumeCheckpointMutation, undefined);
      yield* Fiber.join(revertFiber);
      yield* Fiber.join(turnFiber);

      assert.deepEqual(yield* Ref.get(order), ["checkpoint-mutation", "turn-activation"]);
    }),
  );
});
