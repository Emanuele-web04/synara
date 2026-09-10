import { Deferred, Effect, Exit, Queue, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { makeBoundedCallbackIngress } from "./boundedCallbackIngress.ts";

type TestItem = {
  readonly id: string;
  readonly terminal?: boolean;
  readonly bytes?: number;
};

describe("makeBoundedCallbackIngress", () => {
  it("closes its scope even when downstream consumption has stopped", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const downstream = yield* Queue.bounded<TestItem>(1);
        yield* Queue.offer(downstream, { id: "full" });
        const started = yield* Deferred.make<void>();
        const ingress = yield* makeBoundedCallbackIngress<TestItem, never, never>(
          (item) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Queue.offer(downstream, item)),
              Effect.asVoid,
            ),
          {
            capacity: 4,
            maxBufferedBytes: 100,
            terminalReserve: 1,
            isTerminal: () => false,
            sizeOf: () => 1,
          },
        ).pipe(Effect.provideService(Scope.Scope, scope));
        ingress.offer({ id: "blocked" });
        yield* Deferred.await(started);
        ingress.offer({ id: "queued" });
        yield* Scope.close(scope, Exit.void).pipe(Effect.timeout("1 second"));
        expect(ingress.status()).toMatchObject({ accepting: false, queued: 0, queuedBytes: 0 });
        yield* Queue.shutdown(downstream);
      }),
    );
  });
  it("bounds synchronous callback admission without creating suspended offers", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const processed: string[] = [];
          const ingress = yield* makeBoundedCallbackIngress<TestItem, never, never>(
            (item) =>
              Effect.sync(() => processed.push(item.id)).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Deferred.await(release)),
              ),
            {
              capacity: 4,
              maxBufferedBytes: 1_000,
              terminalReserve: 1,
              isTerminal: (item) => item.terminal === true,
              sizeOf: (item) => item.bytes ?? 1,
            },
          );

          expect(ingress.offer({ id: "active" })).toBe("accepted");
          yield* Deferred.await(started);
          for (let index = 0; index < 10_000; index += 1) {
            ingress.offer({ id: `delta-${index}` });
          }

          expect(ingress.status()).toMatchObject({
            queued: 3,
            accepted: 4,
            dropped: 9_997,
            terminalOverflow: 0,
          });

          yield* Deferred.succeed(release, undefined);
          yield* ingress.stop;
          expect(processed).toHaveLength(4);
        }),
      ),
    );
  });

  it("reserves capacity and evicts only non-terminal work for terminal events", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const processed: string[] = [];
          const ingress = yield* makeBoundedCallbackIngress<TestItem, never, never>(
            (item) =>
              Effect.sync(() => processed.push(item.id)).pipe(
                Effect.andThen(
                  item.id === "active"
                    ? Deferred.succeed(started, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                      )
                    : Effect.void,
                ),
              ),
            {
              capacity: 3,
              maxBufferedBytes: 100,
              terminalReserve: 1,
              isTerminal: (item) => item.terminal === true,
              sizeOf: (item) => item.bytes ?? 1,
            },
          );

          ingress.offer({ id: "active" });
          yield* Deferred.await(started);
          expect(ingress.offer({ id: "delta-a" })).toBe("accepted");
          expect(ingress.offer({ id: "delta-b" })).toBe("accepted");
          expect(ingress.offer({ id: "terminal-a", terminal: true })).toBe("accepted");
          expect(ingress.offer({ id: "terminal-b", terminal: true })).toBe("evicted-for-terminal");

          expect(ingress.status()).toMatchObject({
            queued: 3,
            evictedForTerminal: 1,
            terminalOverflow: 0,
          });

          yield* Deferred.succeed(release, undefined);
          yield* ingress.stop;
          expect(processed).toContain("terminal-a");
          expect(processed).toContain("terminal-b");
        }),
      ),
    );
  });

  it("waits for accepted work during shutdown", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const processed: string[] = [];
          const ingress = yield* makeBoundedCallbackIngress<TestItem, never, never>(
            (item) =>
              Deferred.await(release).pipe(
                Effect.andThen(Effect.sync(() => processed.push(item.id))),
              ),
            {
              capacity: 2,
              maxBufferedBytes: 100,
              terminalReserve: 1,
              isTerminal: (item) => item.terminal === true,
              sizeOf: () => 1,
            },
          );
          ingress.offer({ id: "one" });
          ingress.offer({ id: "terminal", terminal: true });
          yield* Deferred.succeed(release, undefined);
          yield* ingress.stop;
          expect(ingress.offer({ id: "late" })).toBe("closed");
          expect(processed).toEqual(["one", "terminal"]);
        }),
      ),
    );
  });
});
