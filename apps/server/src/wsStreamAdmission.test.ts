import { Deferred, Effect, Fiber, Ref, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  MAX_STREAMS_PER_RPC_CLIENT,
  MAX_THREAD_STREAMS_PER_RPC_CLIENT,
  makeWsStreamAdmission,
} from "./wsStreamAdmission";

describe("WsStreamAdmission", () => {
  it("holds a stream lease through interruption and releases it after finalization", async () => {
    await Effect.gen(function* () {
      const admission = yield* makeWsStreamAdmission;
      const started = yield* Deferred.make<void>();
      const subscriptions = yield* Ref.make(0);
      const source = Stream.concat(
        Stream.fromEffect(
          Ref.update(subscriptions, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
          ),
        ),
        Stream.never,
      );
      const fiber = yield* Effect.forkChild(
        Stream.runDrain(admission.guard(1, { key: "server.settings" }, source)),
      );

      yield* Deferred.await(started);
      expect(yield* admission.snapshot).toMatchObject({ active: 1, releasedTotal: 0 });
      const duplicate = yield* Stream.runDrain(
        admission.guard(1, { key: "server.settings" }, source),
      ).pipe(Effect.exit);
      expect(duplicate._tag).toBe("Failure");
      expect(yield* Ref.get(subscriptions)).toBe(1);
      yield* Fiber.interrupt(fiber);
      expect(yield* admission.snapshot).toMatchObject({
        clients: 0,
        active: 0,
        releasedTotal: 1,
      });
    }).pipe(Effect.runPromise);
  });

  it("atomically caps one RPC client without reducing another client's capacity", async () => {
    await Effect.gen(function* () {
      const admission = yield* makeWsStreamAdmission;
      const attempts = yield* Effect.forEach(
        Array.from({ length: MAX_STREAMS_PER_RPC_CLIENT + 4 }, (_, index) => index),
        (index) => admission.acquire(1, { key: `stream:${index}` }).pipe(Effect.exit),
        { concurrency: "unbounded" },
      );
      const admitted = attempts.filter((attempt) => attempt._tag === "Success");
      const rejected = attempts.filter((attempt) => attempt._tag === "Failure");

      expect(admitted).toHaveLength(MAX_STREAMS_PER_RPC_CLIENT);
      expect(rejected).toHaveLength(4);
      expect(yield* admission.snapshot).toMatchObject({
        clients: 1,
        active: MAX_STREAMS_PER_RPC_CLIENT,
        admittedTotal: MAX_STREAMS_PER_RPC_CLIENT,
        rejectedCapacityTotal: 4,
      });

      const independentLease = yield* admission.acquire(2, { key: "independent" });
      expect((yield* admission.snapshot).active).toBe(MAX_STREAMS_PER_RPC_CLIENT + 1);
      yield* admission.release(independentLease);
    }).pipe(Effect.runPromise);
  });

  it("rejects duplicate subscriptions only within the owning RPC client", async () => {
    await Effect.gen(function* () {
      const admission = yield* makeWsStreamAdmission;
      const first = yield* admission.acquire(1, { key: "server.settings" });
      const duplicate = yield* admission
        .acquire(1, { key: "server.settings" })
        .pipe(Effect.flip);
      const otherClient = yield* admission.acquire(2, { key: "server.settings" });

      expect(duplicate.code).toBe("STREAM_DUPLICATE_SUBSCRIPTION");
      expect(duplicate.retryable).toBe(false);
      expect(yield* admission.snapshot).toMatchObject({
        clients: 2,
        active: 2,
        rejectedDuplicateTotal: 1,
      });

      yield* admission.release(first);
      yield* admission.release(first);
      yield* admission.release(otherClient);
      expect(yield* admission.snapshot).toMatchObject({
        clients: 0,
        active: 0,
        admittedTotal: 2,
        releasedTotal: 2,
      });
    }).pipe(Effect.runPromise);
  });

  it("caps unique thread subscriptions independently and releases exact leases", async () => {
    await Effect.gen(function* () {
      const admission = yield* makeWsStreamAdmission;
      const singleton = yield* admission.acquire(7, { key: "server.lifecycle" });
      const threadLeases = yield* Effect.forEach(
        Array.from({ length: MAX_THREAD_STREAMS_PER_RPC_CLIENT }, (_, index) => index),
        (index) =>
          admission.acquire(7, {
            key: `orchestration.thread:thread-${index}`,
            threadId: `thread-${index}`,
          }),
      );
      const rejected = yield* admission
        .acquire(7, {
          key: "orchestration.thread:overflow",
          threadId: "overflow",
        })
        .pipe(Effect.flip);

      expect(rejected.code).toBe("THREAD_STREAM_CAPACITY_EXCEEDED");
      expect(rejected.retryable).toBe(true);
      expect((yield* admission.snapshot).active).toBe(
        MAX_THREAD_STREAMS_PER_RPC_CLIENT + 1,
      );

      yield* admission.release(threadLeases[0]!);
      const replacement = yield* admission.acquire(7, {
        key: "orchestration.thread:replacement",
        threadId: "replacement",
      });
      yield* Effect.forEach(
        [singleton, replacement, ...threadLeases.slice(1)],
        admission.release,
        { discard: true },
      );
      expect(yield* admission.snapshot).toMatchObject({ clients: 0, active: 0 });
    }).pipe(Effect.runPromise);
  });
});
