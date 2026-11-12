// FILE: settle-concurrently.ts
// Purpose: Runs two independent release stages at once without letting either
//          outlive the other's failure.
// Layer: Release/build helper

import { Effect, Result } from "effect";

/**
 * Runs two stages that share no inputs or outputs at the same time. Both always
 * settle before a failure is reported, so neither keeps a subprocess writing
 * into the stage after the build has failed. The first argument's failure wins;
 * a second simultaneous failure is logged rather than lost.
 */
export function settleConcurrently<A, E1, R1, B, E2, R2>(
  first: Effect.Effect<A, E1, R1>,
  second: Effect.Effect<B, E2, R2>,
): Effect.Effect<readonly [A, B], E1 | E2, R1 | R2> {
  return Effect.all([first, second], { concurrency: 2, mode: "result" }).pipe(
    Effect.flatMap(([firstResult, secondResult]): Effect.Effect<readonly [A, B], E1 | E2> => {
      if (Result.isFailure(firstResult)) {
        const alsoFailed = Result.isFailure(secondResult)
          ? Effect.logError("Concurrent stage also failed", secondResult.failure)
          : Effect.void;
        return alsoFailed.pipe(Effect.andThen(Effect.fail(firstResult.failure)));
      }
      if (Result.isFailure(secondResult)) return Effect.fail(secondResult.failure);
      return Effect.succeed([firstResult.success, secondResult.success] as const);
    }),
  );
}
