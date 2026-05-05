import { Data, Deferred, Effect, Layer, Ref, ServiceMap } from "effect";

export class ServerRuntimeStartupError extends Data.TaggedError("ServerRuntimeStartupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ServerRuntimeStartupShape {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly markCommandReady: Effect.Effect<void>;
  readonly failCommandReady: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
  readonly enqueueCommand: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError, R>;
}

export class ServerRuntimeStartup extends ServiceMap.Service<
  ServerRuntimeStartup,
  ServerRuntimeStartupShape
>()("t3/serverRuntimeStartup") {}

type CommandReadinessState = "pending" | "ready" | ServerRuntimeStartupError;

export const makeServerRuntimeStartup = Effect.gen(function* () {
  const commandReady = yield* Deferred.make<void, ServerRuntimeStartupError>();
  const commandReadinessState = yield* Ref.make<CommandReadinessState>("pending");

  const markCommandReady = Ref.modify(commandReadinessState, (state) => {
    if (state !== "pending") {
      return [Effect.void, state] as const;
    }
    return [Deferred.succeed(commandReady, undefined).pipe(Effect.asVoid), "ready"] as const;
  }).pipe(Effect.flatten, Effect.orDie);

  const failCommandReady = (error: ServerRuntimeStartupError) =>
    Ref.modify(commandReadinessState, (state) => {
      if (state !== "pending") {
        return [Effect.void, state] as const;
      }
      return [Deferred.fail(commandReady, error).pipe(Effect.asVoid), error] as const;
    }).pipe(Effect.flatten, Effect.orDie);

  const enqueueCommand: ServerRuntimeStartupShape["enqueueCommand"] = (effect) =>
    Effect.gen(function* () {
      const readinessState = yield* Ref.get(commandReadinessState);
      if (readinessState === "ready") {
        return yield* effect;
      }
      if (readinessState !== "pending") {
        return yield* readinessState;
      }

      yield* Deferred.await(commandReady);
      return yield* effect;
    });

  return {
    awaitCommandReady: Deferred.await(commandReady),
    markCommandReady,
    failCommandReady,
    enqueueCommand,
  } satisfies ServerRuntimeStartupShape;
});

export const ServerRuntimeStartupLive = Layer.effect(
  ServerRuntimeStartup,
  makeServerRuntimeStartup,
);
