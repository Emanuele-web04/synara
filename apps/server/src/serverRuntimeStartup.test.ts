import { Effect, Fiber, Ref } from "effect";
import { describe, expect, it } from "vitest";

import {
  ServerRuntimeStartup,
  ServerRuntimeStartupError,
  ServerRuntimeStartupLive,
} from "./serverRuntimeStartup";

const runWithStartup = <A, E>(effect: Effect.Effect<A, E, ServerRuntimeStartup>) =>
  Effect.runPromise(effect.pipe(Effect.provide(ServerRuntimeStartupLive)));

describe("ServerRuntimeStartup", () => {
  it("holds commands until command readiness is marked", async () => {
    const result = await runWithStartup(
      Effect.gen(function* () {
        const startup = yield* ServerRuntimeStartup;
        const counter = yield* Ref.make(0);
        const fiber = yield* startup
          .enqueueCommand(Ref.update(counter, (value) => value + 1).pipe(Effect.as("done")))
          .pipe(Effect.forkChild);
        const beforeReady = yield* Ref.get(counter);

        yield* startup.markCommandReady;
        const commandResult = yield* Fiber.join(fiber);
        const afterReady = yield* Ref.get(counter);

        return { beforeReady, commandResult, afterReady };
      }),
    );

    expect(result).toEqual({
      beforeReady: 0,
      commandResult: "done",
      afterReady: 1,
    });
  });

  it("fails queued commands when startup readiness fails", async () => {
    const result = await runWithStartup(
      Effect.gen(function* () {
        const startup = yield* ServerRuntimeStartup;
        yield* startup.failCommandReady(
          new ServerRuntimeStartupError({ message: "startup failed" }),
        );
        return yield* Effect.exit(startup.enqueueCommand(Effect.succeed("unreachable")));
      }),
    );

    expect(result._tag).toBe("Failure");
  });
});
