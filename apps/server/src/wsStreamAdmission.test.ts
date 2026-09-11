import { Deferred, Effect, Fiber, Ref, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  MAX_STREAMS_PER_RPC_CLIENT,
  MAX_THREAD_STREAMS_PER_RPC_CLIENT,
  makeWsStreamAdmission,
} from "./wsStreamAdmission";

describe("WsStreamAdmission", () => {
  it("reports thread-scoped rejection evidence without changing admission semantics", async () => {
    const recorded: Array<Record<string, unknown>> = [];
    await Effect.gen(function* () {
      const rejectionRecorded = yield* Deferred.make<void>();
      const admission = yield* makeWsStreamAdmission({
        recordRejection: (incident) =>
          Effect.sync(() => recorded.push(incident)).pipe(
            Effect.andThen(Deferred.succeed(rejectionRecorded, undefined)),
          ),
      });
      const leases = yield* Effect.forEach(
        Array.from({ length: MAX_THREAD_STREAMS_PER_RPC_CLIENT }, (_, index) => index),
        (index) =>
          admission.acquire(1, {
            key: `orchestration.thread:thread-${index}`,
            threadId: `thread-${index}`,
          }),
      );
      const overflow = yield* admission
        .acquire(1, { key: "orchestration.thread:overflow", threadId: "overflow" })
        .pipe(Effect.exit);
      yield* Deferred.await(rejectionRecorded);
      expect(overflow._tag).toBe("Failure");
      expect(recorded).toEqual([
        expect.objectContaining({
          threadId: "overflow",
          reason: "thread-capacity",
          errorCode: "THREAD_STREAM_CAPACITY_EXCEEDED",
        }),
      ]);
      yield* Effect.forEach(leases, admission.release, { discard: true });
    }).pipe(Effect.runPromise);
  });

  it("returns a rejection without waiting for diagnostic persistence", async () => {
    await Effect.gen(function* () {
      const persistenceGate = yield* Deferred.make<void>();
      const admission = yield* makeWsStreamAdmission({
        recordRejection: () => Deferred.await(persistenceGate),
      });
      const leases = yield* Effect.forEach(
        Array.from({ length: MAX_STREAMS_PER_RPC_CLIENT }, (_, index) => index),
        (index) => admission.acquire(1, { key: `stream:${index}` }),
      );

      const outcome = yield* Effect.raceFirst(
        admission
          .acquire(1, { key: "stream:overflow" })
          .pipe(Effect.exit, Effect.as("rejected" as const)),
        Effect.sleep(100).pipe(Effect.as("timed-out" as const)),
      );

      expect(outcome).toBe("rejected");
      yield* Deferred.succeed(persistenceGate, undefined);
      yield* Effect.forEach(leases, admission.release, { discard: true });
    }).pipe(Effect.runPromise);
  });

  it("shares the lease on an identical resubscribe and ends every stream on release", async () => {
    await Effect.gen(function* () {
      const admission = yield* makeWsStreamAdmission();
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
      // An identical resubscribe — same client, same key — attaches to the
      // existing lease instead of tearing it down and replaying the stream.
      // Capacity accounting keeps seeing the single live lease.
      yield* Stream.runDrain(admission.guard(1, { key: "server.settings" }, Stream.empty));
      expect(yield* Ref.get(subscriptions)).toBe(1);
      expect(yield* admission.snapshot).toMatchObject({ active: 1, admittedTotal: 1 });
      // releaseKey (the unsubscribe path) completes the shared latch, so the
      // still-running first stream ends without manual interruption.
      yield* admission.releaseKey(1, "server.settings");
      yield* Fiber.join(fiber);
      expect(yield* admission.snapshot).toMatchObject({
        clients: 0,
        active: 0,
        admittedTotal: 1,
        releasedTotal: 1,
      });
    }).pipe(Effect.runPromise);
  });

  it("bounds live taps under repeated same-key resubscribes", async () => {
    await Effect.gen(function* () {
      const admission = yield* makeWsStreamAdmission();
      // Forks a guarded never-ending stream and waits until it is admitted, so
      // successive resubscribes attach in a deterministic order.
      const forkGuardedNever = () =>
        Effect.gen(function* () {
          const admitted = yield* Deferred.make<void>();
          const source = Stream.concat(
            Stream.fromEffect(Deferred.succeed(admitted, undefined)),
            Stream.never,
          );
          const fiber = yield* Effect.forkChild(
            Stream.runDrain(
              admission.guard(1, { key: "orchestration.thread:t", threadId: "t" }, source),
            ),
          );
          yield* Deferred.await(admitted);
          return fiber;
        });
      const first = yield* forkGuardedNever();
      const second = yield* forkGuardedNever();
      const third = yield* forkGuardedNever();
      // Every identical resubscribe shares the one live lease — none ends its
      // predecessor, and the ledger never counts more than one active slot.
      expect(yield* admission.snapshot).toMatchObject({
        active: 1,
        admittedTotal: 1,
      });
      // One unsubscribe ends every attached stream through the shared latch.
      yield* admission.releaseKey(1, "orchestration.thread:t");
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* Fiber.join(third);
      expect(yield* admission.snapshot).toMatchObject({
        clients: 0,
        active: 0,
        admittedTotal: 1,
        releasedTotal: 1,
      });
    }).pipe(Effect.runPromise);
  });

  it("atomically caps one RPC client without reducing another client's capacity", async () => {
    await Effect.gen(function* () {
      const admission = yield* makeWsStreamAdmission();
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

  it("returns the existing lease on a same-key resubscribe and counts per-holder releases", async () => {
    await Effect.gen(function* () {
      const admission = yield* makeWsStreamAdmission();
      const first = yield* admission.acquire(1, { key: "server.settings" });
      const shared = yield* admission.acquire(1, { key: "server.settings" });
      const otherClient = yield* admission.acquire(2, { key: "server.settings" });

      // Same client + key reuses the lease; another client's same-key claim is
      // an independent lease in its own ledger.
      expect(shared.leaseId).toBe(first.leaseId);
      expect(otherClient.leaseId).not.toBe(first.leaseId);
      expect(yield* admission.snapshot).toMatchObject({
        clients: 2,
        active: 2,
        admittedTotal: 2,
        replacedDuplicateTotal: 0,
      });

      // Each holder's release detaches; the shared lease survives until its
      // last holder lets go.
      yield* admission.release(first);
      expect(yield* admission.snapshot).toMatchObject({ active: 2, releasedTotal: 0 });

      yield* admission.release(shared);
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
      const admission = yield* makeWsStreamAdmission();
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
      expect((yield* admission.snapshot).active).toBe(MAX_THREAD_STREAMS_PER_RPC_CLIENT + 1);

      yield* admission.release(threadLeases[0]!);
      const replacement = yield* admission.acquire(7, {
        key: "orchestration.thread:replacement",
        threadId: "replacement",
      });
      yield* Effect.forEach([singleton, replacement, ...threadLeases.slice(1)], admission.release, {
        discard: true,
      });
      expect(yield* admission.snapshot).toMatchObject({ clients: 0, active: 0 });
    }).pipe(Effect.runPromise);
  });
});
