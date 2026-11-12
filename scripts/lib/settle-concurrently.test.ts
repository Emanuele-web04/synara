import { assert, it } from "@effect/vitest";
import { Effect, Exit, Ref } from "effect";

import { settleConcurrently } from "./settle-concurrently.ts";

it.live("runs both stages at once and returns both results", () =>
  Effect.gen(function* () {
    const running = yield* Ref.make(0);
    const peak = yield* Ref.make(0);
    const stage = <A>(value: A) =>
      Ref.updateAndGet(running, (count) => count + 1).pipe(
        Effect.tap((count) => Ref.update(peak, (max) => Math.max(max, count))),
        Effect.andThen(Effect.sleep("20 millis")),
        Effect.andThen(Ref.update(running, (count) => count - 1)),
        Effect.as(value),
      );
    assert.deepStrictEqual(yield* settleConcurrently(stage("native"), stage(42)), ["native", 42]);
    assert.equal(yield* Ref.get(peak), 2);
  }),
);

it.live("lets the other stage finish before reporting a failure", () =>
  Effect.gen(function* () {
    const otherFinished = yield* Ref.make(false);
    const other = Effect.sleep("20 millis").pipe(Effect.andThen(Ref.set(otherFinished, true)));
    const settles: ReadonlyArray<Effect.Effect<unknown, string>> = [
      settleConcurrently(Effect.fail("dmg"), other),
      settleConcurrently(other, Effect.fail("zip")),
    ];
    for (const settle of settles) {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(settle)));
      assert.isTrue(yield* Ref.getAndSet(otherFinished, false));
    }
  }),
);

it.effect("reports the first stage's failure when both fail", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(settleConcurrently(Effect.fail("dmg"), Effect.fail("zip")));
    assert.deepStrictEqual(exit, Exit.fail("dmg"));
    const second = yield* Effect.exit(settleConcurrently(Effect.succeed(1), Effect.fail("zip")));
    assert.deepStrictEqual(second, Exit.fail("zip"));
  }),
);
