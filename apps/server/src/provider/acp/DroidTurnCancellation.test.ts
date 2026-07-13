import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { cancelDroidTurnAndWait } from "./DroidTurnCancellation.ts";

describe("cancelDroidTurnAndWait", () => {
  it("keeps the prompt fiber alive until Droid settles it", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const promptComplete = yield* Deferred.make<void>();
        const promptFiber = yield* Deferred.await(promptComplete).pipe(Effect.forkChild);
        const cancellationFiber = yield* cancelDroidTurnAndWait({
          cancel: Effect.void,
          promptFiber,
          graceMs: 5_000,
        }).pipe(Effect.forkChild);

        yield* Effect.yieldNow;
        expect(cancellationFiber.pollUnsafe()).toBeUndefined();

        yield* Deferred.succeed(promptComplete, undefined);
        expect(yield* Fiber.join(cancellationFiber)).toEqual({
          cancelRequest: "sent",
          prompt: "settled",
        });
      }),
    );
  });

  it("interrupts a prompt that does not settle within the grace window", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const promptFiber = yield* Effect.never.pipe(Effect.forkChild);
        const result = yield* cancelDroidTurnAndWait({
          cancel: Effect.void,
          promptFiber,
          graceMs: 10,
        });

        expect(result).toEqual({ cancelRequest: "sent", prompt: "timedOut" });
        expect(promptFiber.pollUnsafe()).toBeDefined();
      }),
    );
  });
});
