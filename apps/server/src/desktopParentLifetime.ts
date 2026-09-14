import type { Readable } from "node:stream";

import { Deferred, Effect } from "effect";

/** Consume the desktop-only marker before provider children can inherit it. */
export function consumeDesktopParentInput(
  env: NodeJS.ProcessEnv,
  input: () => Readable,
): Readable | undefined {
  const enabled = env.SYNARA_DESKTOP_PARENT_STDIN === "1";
  delete env.SYNARA_DESKTOP_PARENT_STDIN;
  return enabled ? input() : undefined;
}

/** The desktop holds stdin open for exactly its own lifetime, including crashes. */
export function withDesktopParentLifetime<A, E, R>(
  program: Effect.Effect<A, E, R>,
  input: Readable | undefined,
  shutdownTimeoutMs = 20_000,
): Effect.Effect<A | void, E, R> {
  if (!input) return program;

  return Effect.gen(function* () {
    const disconnected = yield* Deferred.make<void>();
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    let ownerLost = false;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const onDisconnect = () => {
          if (ownerLost) return;
          ownerLost = true;
          Deferred.doneUnsafe(disconnected, Effect.void);
          // The desktop's usual shutdown watchdog is gone. Bound hung runtime
          // finalizers without touching another process or bypassing its lock.
          shutdownTimer = setTimeout(() => {
            process.stderr.write("Desktop owner lost: backend shutdown timed out.\n");
            process.exit(1);
          }, shutdownTimeoutMs);
          shutdownTimer.unref();
        };
        input.on("end", onDisconnect);
        input.on("close", onDisconnect);
        input.on("error", onDisconnect);
        input.resume();
        if (input.readableEnded || input.destroyed) onDisconnect();
        return onDisconnect;
      }),
      (onDisconnect) =>
        Effect.sync(() => {
          if (shutdownTimer) clearTimeout(shutdownTimer);
          input.off("end", onDisconnect);
          input.off("close", onDisconnect);
          input.off("error", onDisconnect);
          input.pause();
        }),
    );

    // Install the watcher before startup acquires the database or any children.
    if (ownerLost) return;
    return yield* Effect.raceFirst(
      program,
      Deferred.await(disconnected).pipe(
        Effect.andThen(Effect.logInfo("Desktop owner connection closed; shutting down backend")),
      ),
    );
  }).pipe(Effect.scoped);
}
