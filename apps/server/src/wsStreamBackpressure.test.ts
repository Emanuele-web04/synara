import { WsRpcError } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Queue, Stream } from "effect";

import {
  bufferLiveUiStream,
  makeLiveUiStreamLagState,
  makeLiveUiStreamBudget,
  normalizeLiveUiStreamBufferCapacity,
  recordLiveUiStreamIngress,
} from "./wsStreamBackpressure";

describe("wsStreamBackpressure", () => {
  it("normalizes invalid buffer capacities to safe positive values", () => {
    expect(normalizeLiveUiStreamBufferCapacity(2.9)).toBe(2);
    expect(normalizeLiveUiStreamBufferCapacity(0)).toBe(1);
    expect(normalizeLiveUiStreamBufferCapacity(Number.NaN)).toBeGreaterThan(1);
  });

  it("keeps the newest live UI events when the buffer overflows", async () => {
    const values = await Effect.runPromise(
      Stream.fromIterable([1, 2, 3, 4, 5]).pipe(
        (stream) => bufferLiveUiStream(stream, { capacity: 2 }),
        Stream.runCollect,
      ),
    );

    expect(Array.from(values)).toEqual([4, 5]);
  });

  it("can fail on overflow so snapshot-backed streams restart", async () => {
    await expect(
      Effect.runPromise(
        Stream.fromIterable([1, 2, 3]).pipe(
          (stream) =>
            bufferLiveUiStream(stream, {
              capacity: 1,
              onDroppedEvents: () => Effect.fail(new Error("resync")),
            }),
          Stream.runCollect,
        ),
      ),
    ).rejects.toThrow("resync");
  });

  it("preserves unrelated sliding-hook errors without orchestration overflow metadata", async () => {
    const failure = new WsRpcError({ message: "dev-server resubscribe failed" });
    const result = await Effect.runPromise(
      bufferLiveUiStream(Stream.make(1, 2), {
        capacity: 1,
        onDroppedEvents: () => Effect.fail(failure),
      }).pipe(Stream.runCollect, Effect.exit),
    );
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(failure);
  });

  it("fails bounded orchestration streams instead of dropping accepted events", async () => {
    const result = await Effect.runPromise(
      Stream.make({ sequence: 1 }, { sequence: 2 }).pipe(
        (stream) => bufferLiveUiStream(stream, { capacity: 1, overflowStrategy: "fail" }),
        Stream.runCollect,
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(Cause.squash(result.cause)).toMatchObject({
        code: "ORCHESTRATION_STREAM_OVERFLOW",
        retryable: true,
      });
    }
  });

  it("preserves canonical overflow when a legacy notification hook fails", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* Queue.unbounded<{ sequence: number }>();
          const hookCalled = yield* Deferred.make<void>();
          const pull = yield* Stream.toPull(
            bufferLiveUiStream(Stream.fromQueue(input), {
              capacity: 1,
              overflowStrategy: "fail",
              onDroppedEvents: () =>
                Deferred.succeed(hookCalled, undefined).pipe(
                  Effect.andThen(Effect.fail(new WsRpcError({ message: "legacy resubscribe" }))),
                ),
            }),
          );
          yield* Queue.offer(input, { sequence: 1 });
          yield* pull;
          yield* Queue.offer(input, { sequence: 2 });
          yield* Deferred.await(hookCalled).pipe(Effect.timeout("500 millis"));
          const result = yield* Effect.exit(pull);
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            expect(Cause.squash(result.cause)).toMatchObject({
              code: "ORCHESTRATION_STREAM_OVERFLOW",
              retryable: true,
            });
          }
        }),
      ),
    );
  });

  it("bounds stage storage when a source repeats the same retained object", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repeated = { sequence: 1 };
          const sixthProduced = yield* Deferred.make<void>();
          let produced = 0;
          const pull = yield* Stream.toPull(
            bufferLiveUiStream(
              Stream.fromIterable(Array.from({ length: 20 }, () => repeated)).pipe(
                Stream.tap(() =>
                  Effect.gen(function* () {
                    produced += 1;
                    if (produced === 6) yield* Deferred.succeed(sixthProduced, undefined);
                    yield* Effect.yieldNow;
                  }),
                ),
              ),
              { capacity: 2, overflowStrategy: "fail" },
            ),
          );
          yield* pull;
          // Identity-based stage transfers share a charge. Repeated references
          // must still have bounded queue storage while the last batch lacks an ACK.
          const excessiveProduction = yield* Deferred.await(sixthProduced).pipe(
            Effect.timeout("50 millis"),
            Effect.exit,
          );
          expect(Exit.isFailure(excessiveProduction)).toBe(true);
          expect(produced).toBeLessThanOrEqual(5);
        }),
      ),
    );
  });

  it("closes its source without an ACK when an overflow notification never finishes", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* Queue.unbounded<{ sequence: number }>();
          const sourceClosed = yield* Deferred.make<void>();
          const hookStarted = yield* Deferred.make<void>();
          const pull = yield* Stream.toPull(
            bufferLiveUiStream(
              Stream.fromQueue(input).pipe(
                Stream.ensuring(Deferred.succeed(sourceClosed, undefined)),
              ),
              {
                capacity: 1,
                overflowStrategy: "fail",
                onDroppedEvents: () =>
                  Deferred.succeed(hookStarted, undefined).pipe(Effect.andThen(Effect.never)),
              },
            ),
          );
          yield* Queue.offer(input, { sequence: 1 });
          expect(yield* pull).toEqual([{ sequence: 1 }]);
          yield* Queue.offer(input, { sequence: 2 });
          yield* Deferred.await(hookStarted).pipe(Effect.timeout("500 millis"));
          yield* Deferred.await(sourceClosed).pipe(Effect.timeout("500 millis"));
          const result = yield* Effect.exit(pull);
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            expect(Cause.squash(result.cause)).toMatchObject({
              code: "ORCHESTRATION_STREAM_OVERFLOW",
            });
          }
        }),
      ),
    );
  });

  it("measures serialized UTF-8 bytes rather than character count", async () => {
    // {"text":"😀"} is 15 UTF-8 bytes, but only 13 JavaScript characters.
    for (const [maxSerializedBytes, succeeds] of [
      [14, false],
      [15, true],
    ] as const) {
      const result = await Effect.runPromise(
        Stream.succeed({ text: "😀" }).pipe(
          (stream) => bufferLiveUiStream(stream, { overflowStrategy: "fail", maxSerializedBytes }),
          Stream.runCollect,
          Effect.exit,
        ),
      );
      expect(Exit.isSuccess(result)).toBe(succeeds);
      if (Exit.isFailure(result)) {
        expect(Cause.squash(result.cause)).toMatchObject({ code: "ORCHESTRATION_STREAM_OVERFLOW" });
      }
    }
  });

  it("retains an unacknowledged batch and closes its source before the next pull", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* Queue.unbounded<{ sequence: number }>();
          const sourceClosed = yield* Deferred.make<void>();
          const pull = yield* Stream.toPull(
            bufferLiveUiStream(
              Stream.fromQueue(input).pipe(
                Stream.ensuring(Deferred.succeed(sourceClosed, undefined)),
              ),
              { capacity: 1, overflowStrategy: "fail" },
            ),
          );
          yield* Queue.offer(input, { sequence: 1 });
          expect(yield* pull).toEqual([{ sequence: 1 }]);
          yield* Queue.offer(input, { sequence: 2 });
          // No next pull/ACK: sequence 1 must still occupy the only slot.
          yield* Deferred.await(sourceClosed).pipe(Effect.timeout("500 millis"));
          const result = yield* pull.pipe(Effect.exit);
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            expect(Cause.squash(result.cause)).toMatchObject({
              code: "ORCHESTRATION_STREAM_OVERFLOW",
            });
          }
        }),
      ),
    );
  });

  it("releases the acknowledged batch so a healthy consumer can continue", async () => {
    const values = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* Queue.unbounded<{ sequence: number }>();
          const pull = yield* Stream.toPull(
            bufferLiveUiStream(Stream.fromQueue(input), { capacity: 1, overflowStrategy: "fail" }),
          );
          yield* Queue.offer(input, { sequence: 1 });
          const first = yield* pull;
          const next = yield* pull.pipe(Effect.forkScoped);
          // Starting the next pull acknowledges and releases sequence 1.
          yield* Effect.yieldNow;
          yield* Queue.offer(input, { sequence: 2 });
          return [...first, ...(yield* Fiber.join(next))];
        }),
      ),
    );
    expect(values).toEqual([{ sequence: 1 }, { sequence: 2 }]);
  });

  it("keeps a transferred event charged until every stage releases its reference", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const budget = yield* makeLiveUiStreamBudget({ capacity: 1, maxSerializedBytes: 15 });
          const event = { text: "😀" };
          const ingress = yield* budget.acquire(event, 15);
          const delivery = yield* budget.acquire(event, 15);
          ingress.release();
          ingress.release(); // Releasing a stage twice must not release delivery's charge.
          const result = yield* Effect.exit(budget.acquire({}, 1));
          expect(Exit.isFailure(result)).toBe(true);
          delivery.release(); // Cleanup after failure is also idempotent.
          delivery.release();
          const afterFailure = yield* Effect.exit(budget.acquire(event, 15));
          expect(Exit.isFailure(afterFailure)).toBe(true);
        }),
      ),
    );
  });

  it("reclaims a shared charge after the final stage acknowledges it", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const budget = yield* makeLiveUiStreamBudget({ capacity: 1, maxSerializedBytes: 15 });
          const event = { text: "😀" };
          const ingress = yield* budget.acquire(event, 15);
          const delivery = yield* budget.acquire(event, 15);
          ingress.release();
          delivery.release();
          const next = yield* budget.acquire({}, 15);
          next.release();
        }),
      ),
    );
  });

  it("reports nothing while the subscriber keeps up", () => {
    const state = makeLiveUiStreamLagState();
    expect(recordLiveUiStreamIngress(state, 2)).toBeNull();
    state.egressCount += 1;
    expect(recordLiveUiStreamIngress(state, 2)).toBeNull();
    expect(recordLiveUiStreamIngress(state, 2)).toBeNull();
  });

  it("reports the first overflow and then only growth past the step", () => {
    const state = makeLiveUiStreamLagState();
    expect(recordLiveUiStreamIngress(state, 1, 3)).toBeNull();
    expect(recordLiveUiStreamIngress(state, 1, 3)).toBe(1);
    expect(recordLiveUiStreamIngress(state, 1, 3)).toBeNull();
    expect(recordLiveUiStreamIngress(state, 1, 3)).toBeNull();
    expect(recordLiveUiStreamIngress(state, 1, 3)).toBe(4);
  });

  it("stops reporting once egress catches the lag back up", () => {
    const state = makeLiveUiStreamLagState();
    expect(recordLiveUiStreamIngress(state, 1, 1)).toBeNull();
    expect(recordLiveUiStreamIngress(state, 1, 1)).toBe(1);
    state.egressCount += 2;
    expect(recordLiveUiStreamIngress(state, 1, 1)).toBeNull();
  });
});
