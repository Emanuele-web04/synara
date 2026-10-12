import { EventId, ThreadId, type OrchestrationEvent } from "@synara/contracts";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, PubSub, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  makeCursorSafeSnapshotLiveStream,
  makeResnapshotEscalationTracker,
  ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT,
} from "./wsSnapshotLiveStream";

const event = (sequence: number) => ({ sequence }) as OrchestrationEvent;

const activityEvent = (
  sequence: number,
  data: string,
): Extract<OrchestrationEvent, { type: "thread.activity-appended" }> => ({
  sequence,
  eventId: EventId.makeUnsafe(`event-${sequence}`),
  aggregateKind: "thread",
  aggregateId: ThreadId.makeUnsafe("stream-thread"),
  occurredAt: "2026-10-06T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.activity-appended",
  payload: {
    threadId: ThreadId.makeUnsafe("stream-thread"),
    activity: {
      id: EventId.makeUnsafe(`activity-${sequence}`),
      tone: "info",
      kind: "tool.progress",
      summary: "Tool progress",
      payload: data,
      turnId: null,
      createdAt: "2026-10-06T00:00:00.000Z",
    },
  },
});

describe("makeCursorSafeSnapshotLiveStream", () => {
  it("delivers 1100 finite replay events with one millisecond acknowledgements", async () => {
    const rows = Array.from({ length: 1100 }, (_, index) => event(index + 1));
    const items = await Effect.runPromise(
      makeCursorSafeSnapshotLiveStream({
        subscribeLive: Effect.succeed(Stream.never),
        snapshot: Effect.succeed({ snapshotSequence: 0 }),
        snapshotSequence: (snapshot) => snapshot.snapshotSequence,
        getHighWaterSequence: Effect.succeed(rows.length),
        replay: () => Stream.fromIterable(rows),
      }).pipe(
        Stream.take(rows.length + 1),
        Stream.tap(() => Effect.sleep("1 millis")),
        Stream.runCollect,
        Effect.timeout("4 seconds"),
      ),
    );
    expect(items.length).toBe(1101);
    expect(items.slice(1).map((item) => item.kind === "event" && item.event.sequence)).toEqual(
      rows.map((row) => row.sequence),
    );
  });

  it("does not double charge 600 replay events and 600 distinct live duplicates", async () => {
    const rows = Array.from({ length: 600 }, (_, index) => event(index + 1));
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* Queue.unbounded<OrchestrationEvent>();
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: Effect.succeed(Stream.fromQueue(input)),
            snapshot: Queue.offerAll(
              input,
              rows.map((row) => event(row.sequence)),
            ).pipe(Effect.as({ snapshotSequence: 0 })),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(600),
            replay: () => Stream.fromIterable(rows),
          }).pipe(
            Stream.take(601),
            Stream.tap(() => Effect.sleep("1 millis")),
            Stream.runCollect,
            Effect.timeout("3 seconds"),
          );
        }),
      ),
    );
    expect(items.length).toBe(601);
  });

  it("discards live objects covered by the fence before charging their bytes", async () => {
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* Queue.unbounded<OrchestrationEvent>();
          const discarded = Array.from({ length: 20 }, () => activityEvent(2, "x".repeat(4096)));
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: Effect.succeed(Stream.fromQueue(input)),
            snapshot: Effect.succeed({ snapshotSequence: 0 }),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(2),
            replay: () =>
              Stream.fromEffect(
                Queue.offerAll(input, [...discarded, event(3)]).pipe(Effect.as(event(2))),
              ),
            liveBufferOptions: { capacity: 2, maxSerializedBytes: 1024 },
          }).pipe(Stream.take(3), Stream.runCollect, Effect.timeout("1 second"));
        }),
      ),
    );
    expect(items.map((item) => (item.kind === "event" ? item.event.sequence : "snapshot"))).toEqual(
      ["snapshot", 2, 3],
    );
  });

  it("preserves a completed live source's newer tail when pruning its fence", async () => {
    const items = await Effect.runPromise(
      makeCursorSafeSnapshotLiveStream({
        subscribeLive: Effect.succeed(Stream.make(event(2), event(3))),
        snapshot: Effect.sleep("10 millis").pipe(Effect.as({ snapshotSequence: 1 })),
        snapshotSequence: (snapshot) => snapshot.snapshotSequence,
        getHighWaterSequence: Effect.succeed(2),
        replay: () => Stream.succeed(event(2)),
      }).pipe(Stream.runCollect, Effect.timeout("1 second")),
    );
    expect(items.map((item) => (item.kind === "event" ? item.event.sequence : "snapshot"))).toEqual(
      ["snapshot", 2, 3],
    );
  });

  it("retains a completed live tail when bounded resume falls back to a snapshot", async () => {
    const oversized = activityEvent(1, "x".repeat(1024 * 1024));
    const items = await Effect.runPromise(
      makeCursorSafeSnapshotLiveStream({
        subscribeLive: Effect.succeed(Stream.make(event(1), event(2))),
        resumeFromSequence: 0,
        snapshot: Effect.succeed({ snapshotSequence: 1 }),
        snapshotSequence: (snapshot) => snapshot.snapshotSequence,
        getHighWaterSequence: Effect.succeed(1),
        replay: () => Stream.succeed(oversized).pipe(Stream.tap(() => Effect.sleep("10 millis"))),
      }).pipe(Stream.runCollect, Effect.timeout("1 second")),
    );
    expect(items).toEqual([
      { kind: "snapshot", snapshot: { snapshotSequence: 1 } },
      { kind: "event", event: event(2) },
    ]);
  });

  it("releases fenced live charges before a slow finite replay admits a newer tail", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* Queue.unbounded<OrchestrationEvent>();
          const replayStarted = yield* Deferred.make<void>();
          const releaseReplay = yield* Deferred.make<void>();
          const tailRead = yield* Deferred.make<void>();
          const reader = yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: Effect.succeed(
              Stream.fromQueue(input).pipe(
                Stream.tap((row) =>
                  row.sequence === 1200 ? Deferred.succeed(tailRead, undefined) : Effect.void,
                ),
              ),
            ),
            snapshot: Queue.offerAll(
              input,
              Array.from({ length: 600 }, (_, i) => event(i + 1)),
            ).pipe(Effect.as({ snapshotSequence: 0 })),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(600),
            replay: () =>
              Stream.fromEffect(
                Deferred.succeed(replayStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseReplay)),
                  Effect.as(event(600)),
                ),
              ),
          }).pipe(Stream.take(602), Stream.runCollect, Effect.forkChild);
          yield* Deferred.await(replayStarted).pipe(Effect.timeout("500 millis"));
          yield* Queue.offerAll(
            input,
            Array.from({ length: 600 }, (_, i) => event(i + 601)),
          );
          yield* Deferred.await(tailRead).pipe(Effect.timeout("500 millis"));
          yield* Deferred.succeed(releaseReplay, undefined);
          const items = yield* Fiber.join(reader).pipe(Effect.timeout("1 second"));
          expect(items.length).toBe(602);
        }),
      ),
    );
  });

  it("falls back to a snapshot without scanning a 129-event resume gap", async () => {
    let snapshotLoaded = false;
    let replayCalls = 0;
    const items = await Effect.runPromise(
      makeCursorSafeSnapshotLiveStream({
        subscribeLive: Effect.succeed(Stream.never),
        resumeFromSequence: 0,
        snapshot: Effect.sync(() => {
          snapshotLoaded = true;
          return { snapshotSequence: 129 };
        }),
        snapshotSequence: (snapshot) => snapshot.snapshotSequence,
        getHighWaterSequence: Effect.succeed(129),
        replay: (from) => {
          if (from !== 0) return Stream.empty;
          replayCalls += 1;
          return Stream.fromIterable(Array.from({ length: 129 }, (_, index) => event(index + 1)));
        },
      }).pipe(Stream.take(1), Stream.runCollect),
    );
    expect(snapshotLoaded).toBe(true);
    expect(replayCalls).toBe(0);
    expect(Array.from(items)).toEqual([{ kind: "snapshot", snapshot: { snapshotSequence: 129 } }]);
  });

  it("stops an oversized resume scan and falls back to the snapshot", async () => {
    let snapshotLoaded = false;
    let sourceClosed = false;
    let scannedAfterOverflow = false;
    const oversized = activityEvent(1, "x".repeat(1024 * 1024));
    const items = await Effect.runPromise(
      makeCursorSafeSnapshotLiveStream({
        subscribeLive: Effect.succeed(Stream.never),
        resumeFromSequence: 0,
        snapshot: Effect.sync(() => {
          snapshotLoaded = true;
          return { snapshotSequence: 1 };
        }),
        snapshotSequence: (snapshot) => snapshot.snapshotSequence,
        getHighWaterSequence: Effect.succeed(1),
        replay: (from) =>
          from === 0
            ? Stream.concat(
                Stream.succeed(oversized),
                Stream.fromEffect(
                  Effect.sync(() => {
                    scannedAfterOverflow = true;
                    return event(2);
                  }),
                ),
              ).pipe(
                Stream.ensuring(
                  Effect.sync(() => {
                    sourceClosed = true;
                  }),
                ),
              )
            : Stream.empty,
      }).pipe(Stream.take(1), Stream.runCollect),
    );
    expect(snapshotLoaded).toBe(true);
    expect(sourceClosed).toBe(true);
    expect(scannedAfterOverflow).toBe(false);
    expect(Array.from(items)).toEqual([{ kind: "snapshot", snapshot: { snapshotSequence: 1 } }]);
  });

  it("resumes 128 accepted events in order and emits a concurrent live duplicate exactly once", async () => {
    let snapshotLoaded = false;
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            resumeFromSequence: 0,
            snapshot: Effect.sync(() => {
              snapshotLoaded = true;
              return { snapshotSequence: 128 };
            }),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(128),
            replay: () =>
              Stream.fromIterable(Array.from({ length: 128 }, (_, index) => event(index + 1))).pipe(
                Stream.tap((row) =>
                  row.sequence === 128 ? PubSub.publishAll(live, [row, event(129)]) : Effect.void,
                ),
              ),
          }).pipe(Stream.take(129), Stream.runCollect, Effect.timeout("1 second"));
        }),
      ),
    );
    expect(snapshotLoaded).toBe(false);
    expect(
      Array.from(items).map((item) => (item.kind === "event" ? item.event.sequence : "snapshot")),
    ).toEqual(Array.from({ length: 129 }, (_, index) => index + 1));
  });

  it("accepts exactly one MiB of serialized resume events", async () => {
    let snapshotLoaded = false;
    const empty = activityEvent(1, "");
    const sized = activityEvent(
      1,
      "x".repeat(1024 * 1024 - Buffer.byteLength(JSON.stringify({ kind: "event", event: empty }))),
    );
    const items = await Effect.runPromise(
      makeCursorSafeSnapshotLiveStream({
        subscribeLive: Effect.succeed(Stream.never),
        resumeFromSequence: 0,
        snapshot: Effect.sync(() => {
          snapshotLoaded = true;
          return { snapshotSequence: 1 };
        }),
        snapshotSequence: (snapshot) => snapshot.snapshotSequence,
        getHighWaterSequence: Effect.succeed(1),
        replay: () => Stream.succeed(sized),
      }).pipe(Stream.take(1), Stream.runCollect),
    );
    expect(snapshotLoaded).toBe(false);
    expect(Array.from(items)).toEqual([{ kind: "event", event: sized }]);
  });

  it("preserves real database failures during resume preflight", async () => {
    let snapshotLoaded = false;
    const failure = new Error("resume database unavailable");
    const result = await Effect.runPromise(
      makeCursorSafeSnapshotLiveStream({
        subscribeLive: Effect.succeed(Stream.never),
        resumeFromSequence: 0,
        snapshot: Effect.sync(() => {
          snapshotLoaded = true;
          return { snapshotSequence: 1 };
        }),
        snapshotSequence: (snapshot) => snapshot.snapshotSequence,
        getHighWaterSequence: Effect.succeed(1),
        replay: () => Stream.fail(failure),
      }).pipe(Stream.runCollect, Effect.exit),
    );
    expect(snapshotLoaded).toBe(false);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(failure);
  });

  it("propagates live source failure while bootstrap waits for its fence", async () => {
    const failure = new Error("live source failed before fence");
    const result = await Effect.runPromise(
      makeCursorSafeSnapshotLiveStream({
        subscribeLive: Effect.succeed(Stream.fail(failure)),
        snapshot: Effect.never,
        snapshotSequence: () => 0,
        getHighWaterSequence: Effect.succeed(0),
        replay: () => Stream.empty,
      }).pipe(Stream.runCollect, Effect.exit, Effect.timeout("500 millis")),
    );
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(failure);
  });

  it("propagates source interruption and finalizes a blocked bootstrap pull", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snapshotStarted = yield* Deferred.make<void>();
          const snapshotClosed = yield* Deferred.make<void>();
          const sourceClosed = yield* Deferred.make<void>();
          const subscriptionClosed = yield* Deferred.make<void>();
          const reader = yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: Effect.acquireRelease(
              Effect.succeed(
                Stream.fromEffect(
                  Deferred.await(snapshotStarted).pipe(Effect.andThen(Effect.interrupt)),
                ).pipe(Stream.ensuring(Deferred.succeed(sourceClosed, undefined))),
              ),
              () => Deferred.succeed(subscriptionClosed, undefined),
            ),
            snapshot: Deferred.succeed(snapshotStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(snapshotClosed, undefined)),
            ),
            snapshotSequence: () => 0,
            getHighWaterSequence: Effect.succeed(0),
            replay: () => Stream.empty,
          }).pipe(Stream.runCollect, Effect.forkChild);
          const result = yield* Fiber.await(reader).pipe(Effect.timeout("500 millis"));
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) expect(Cause.hasInterruptsOnly(result.cause)).toBe(true);
          yield* Deferred.await(sourceClosed).pipe(Effect.timeout("500 millis"));
          yield* Deferred.await(subscriptionClosed).pipe(Effect.timeout("500 millis"));
          yield* Deferred.await(snapshotClosed).pipe(Effect.timeout("500 millis"));
        }),
      ),
    );
  });

  it("closes an overflowing live subscription while snapshot IO is blocked", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* Queue.unbounded<OrchestrationEvent>();
          const attached = yield* Deferred.make<void>();
          const subscriptionClosed = yield* Deferred.make<void>();
          const snapshotStarted = yield* Deferred.make<void>();
          const snapshotClosed = yield* Deferred.make<void>();
          const reader = yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: Effect.acquireRelease(
              Deferred.succeed(attached, undefined).pipe(Effect.as(Stream.fromQueue(input))),
              () => Deferred.succeed(subscriptionClosed, undefined),
            ),
            snapshot: Deferred.succeed(snapshotStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(snapshotClosed, undefined)),
            ),
            snapshotSequence: () => 0,
            getHighWaterSequence: Effect.succeed(0),
            replay: () => Stream.empty,
            liveBufferOptions: { capacity: 1 },
          }).pipe(Stream.runCollect, Effect.exit, Effect.forkScoped);
          yield* Deferred.await(attached);
          yield* Deferred.await(snapshotStarted);
          yield* Queue.offerAll(input, [event(1), event(2), event(3), event(4)]);
          yield* Deferred.await(subscriptionClosed).pipe(Effect.timeout("500 millis"));
          yield* Deferred.await(snapshotClosed).pipe(Effect.timeout("500 millis"));
          const result = yield* Fiber.join(reader);
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

  it.each(["count", "bytes"] as const)(
    "bounds the waiting live tail by %s and cancels blocked finite replay",
    async (limit) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const input = yield* Queue.unbounded<OrchestrationEvent>();
            const replayBlocked = yield* Deferred.make<void>();
            const replayClosed = yield* Deferred.make<void>();
            const subscriptionClosed = yield* Deferred.make<void>();
            const replayEvent = event(1);
            const liveEvent = event(2);
            const eventBytes = Buffer.byteLength(
              JSON.stringify({ kind: "event", event: replayEvent }),
            );
            const stream = makeCursorSafeSnapshotLiveStream({
              subscribeLive: Effect.acquireRelease(Effect.succeed(Stream.fromQueue(input)), () =>
                Deferred.succeed(subscriptionClosed, undefined),
              ),
              snapshot: Effect.succeed({ snapshotSequence: 0 }),
              snapshotSequence: (snapshot) => snapshot.snapshotSequence,
              getHighWaterSequence: Effect.succeed(1),
              replay: () =>
                Stream.concat(
                  Stream.succeed(replayEvent),
                  Stream.fromEffect(
                    Deferred.succeed(replayBlocked, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.ensuring(Deferred.succeed(replayClosed, undefined)),
                    ),
                  ).pipe(Stream.drain),
                ),
              liveBufferOptions:
                limit === "count"
                  ? { capacity: 1 }
                  : { capacity: 10, maxSerializedBytes: eventBytes * 2 - 1 },
            });
            const pull = yield* Stream.toPull(stream);
            yield* pull;
            yield* pull;
            const blockedPull = yield* Effect.forkChild(pull);
            yield* Deferred.await(replayBlocked).pipe(Effect.timeout("500 millis"));
            // Finite replay is demand-driven. Its blocked read must be cancelled
            // when the independent bounded live tail overflows.
            yield* Queue.offer(input, liveEvent);
            yield* Queue.offer(input, event(3));
            yield* Deferred.await(subscriptionClosed).pipe(Effect.timeout("500 millis"));
            const result = yield* Fiber.await(blockedPull);
            yield* Deferred.await(replayClosed).pipe(Effect.timeout("500 millis"));
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
    },
  );

  it("attaches before snapshot IO and deduplicates events covered by durable replay", async () => {
    const steps: string[] = [];
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const replayed = event(2);
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.tap(() => Effect.sync(() => steps.push("attached"))),
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: PubSub.publish(live, replayed).pipe(
              Effect.tap(() => Effect.sync(() => steps.push("snapshot"))),
              Effect.as({ snapshotSequence: 1 }),
            ),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(2),
            replay: () => Stream.succeed(replayed),
          }).pipe(Stream.take(2), Stream.runCollect);
        }),
      ),
    );

    expect(steps).toEqual(["attached", "snapshot"]);
    expect(Array.from(items)).toEqual([
      { kind: "snapshot", snapshot: { snapshotSequence: 1 } },
      { kind: "event", event: event(2) },
    ]);
  });

  it("emits the snapshot first, the fenced replay next, and newer live events last", async () => {
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const replayed = event(2);
          const newerLive = event(3);
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: PubSub.publish(live, replayed).pipe(Effect.as({ snapshotSequence: 1 })),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(2),
            replay: () =>
              Stream.concat(
                Stream.fromEffect(PubSub.publish(live, newerLive)).pipe(Stream.drain),
                Stream.succeed(replayed),
              ),
          }).pipe(Stream.take(3), Stream.runCollect);
        }),
      ),
    );

    expect(Array.from(items)).toEqual([
      { kind: "snapshot", snapshot: { snapshotSequence: 1 } },
      { kind: "event", event: event(2) },
      { kind: "event", event: event(3) },
    ]);
  });

  it("emits the snapshot before an event published during snapshot IO, losing nothing", async () => {
    // Regression: the live subscription must attach before snapshot IO starts,
    // so an event published while the (delayed) snapshot loads is delivered
    // after the snapshot instead of being dropped or duplicated.
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const publishedDuringSnapshot = event(2);
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: Effect.sleep(Duration.millis(20)).pipe(
              Effect.andThen(PubSub.publish(live, publishedDuringSnapshot)),
              Effect.as({ snapshotSequence: 1 }),
            ),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(1),
            replay: () => Stream.empty,
          }).pipe(Stream.take(2), Stream.runCollect);
        }),
      ),
    );

    expect(Array.from(items)).toEqual([
      { kind: "snapshot", snapshot: { snapshotSequence: 1 } },
      { kind: "event", event: event(2) },
    ]);
    // A short deadline: when the attach ordering regresses, this test fails by
    // losing the mid-snapshot event and would otherwise stall for the suite's
    // full 90s default before reporting.
  }, 15_000);

  it("resumes from a cursor by replaying exactly the gap without a snapshot", async () => {
    let snapshotLoaded = false;
    let replayRange: readonly [number, number] | null = null;
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const newerLive = event(6);
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: Effect.sync(() => {
              snapshotLoaded = true;
              return { snapshotSequence: 1 };
            }),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(5),
            resumeFromSequence: 3,
            replay: (fromSequenceExclusive, throughSequenceInclusive) => {
              replayRange = [fromSequenceExclusive, throughSequenceInclusive];
              return Stream.concat(
                Stream.fromEffect(PubSub.publish(live, newerLive)).pipe(Stream.drain),
                Stream.make(event(4), event(5)),
              );
            },
          }).pipe(Stream.take(3), Stream.runCollect);
        }),
      ),
    );

    expect(snapshotLoaded).toBe(false);
    expect(replayRange).toEqual([3, 5]);
    expect(Array.from(items)).toEqual([
      { kind: "event", event: event(4) },
      { kind: "event", event: event(5) },
      { kind: "event", event: event(6) },
    ]);
  });

  it("batches the resume gap into one replay item followed by live events", async () => {
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: Effect.die(new Error("cursor resume must not load the snapshot")),
            snapshotSequence: () => 0,
            getHighWaterSequence: Effect.succeed(5),
            resumeFromSequence: 3,
            batchReplay: true,
            replay: () =>
              Stream.concat(
                Stream.fromEffect(PubSub.publish(live, event(6))).pipe(Stream.drain),
                // Out-of-fence rows stay filtered out of the batch.
                Stream.make(event(3), event(4), event(5), event(6)),
              ),
          }).pipe(Stream.take(2), Stream.runCollect);
        }),
      ),
    );

    expect(Array.from(items)).toEqual([
      { kind: "replay", events: [event(4), event(5)] },
      { kind: "event", event: event(6) },
    ]);
  });

  it("emits no replay item when the batched resume gap is empty", async () => {
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: Effect.die(new Error("cursor resume must not load the snapshot")),
            snapshotSequence: () => 0,
            getHighWaterSequence: Effect.succeed(5),
            resumeFromSequence: 5,
            batchReplay: true,
            replay: () => Stream.fromEffect(PubSub.publish(live, event(6))).pipe(Stream.drain),
          }).pipe(Stream.take(1), Stream.runCollect);
        }),
      ),
    );

    expect(Array.from(items)).toEqual([{ kind: "event", event: event(6) }]);
  });

  it("keeps per-event replay after a snapshot even when batching is requested", async () => {
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: Effect.succeed({ snapshotSequence: 3 }),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(5),
            batchReplay: true,
            replay: () => Stream.make(event(4), event(5)),
          }).pipe(Stream.take(3), Stream.runCollect);
        }),
      ),
    );

    expect(Array.from(items)).toEqual([
      { kind: "snapshot", snapshot: { snapshotSequence: 3 } },
      { kind: "event", event: event(4) },
      { kind: "event", event: event(5) },
    ]);
  });

  it("does not lose an event published while the resume path reads the durable head", async () => {
    // The resume branch must share the snapshot path's attach-before-IO
    // discipline: the live subscription attaches before the durable head is
    // read, so an event published during that read lands in the live queue and
    // is delivered after the gap replay instead of being lost. Moving the
    // attach after the head read passes every other test in this file — only
    // this probe catches it.
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const publishedDuringHeadRead = event(6);
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: Effect.die(new Error("cursor resume must not load the snapshot")),
            snapshotSequence: () => 0,
            getHighWaterSequence: Effect.sleep(Duration.millis(20)).pipe(
              Effect.andThen(PubSub.publish(live, publishedDuringHeadRead)),
              Effect.as(5),
            ),
            resumeFromSequence: 3,
            replay: () => Stream.make(event(4), event(5)),
          }).pipe(Stream.take(3), Stream.runCollect);
        }),
      ),
    );

    expect(Array.from(items)).toEqual([
      { kind: "event", event: event(4) },
      { kind: "event", event: event(5) },
      { kind: "event", event: event(6) },
    ]);
  }, 15_000);

  it("falls back to the snapshot when the cursor gap exceeds the replay limit", async () => {
    const replayRanges: Array<readonly [number, number]> = [];
    const highWaterSequence = ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 10;
    const items = await Effect.runPromise(
      Effect.scoped(
        makeCursorSafeSnapshotLiveStream({
          subscribeLive: Effect.succeed(Stream.empty),
          snapshot: Effect.succeed({ snapshotSequence: highWaterSequence }),
          snapshotSequence: (snapshot) => snapshot.snapshotSequence,
          getHighWaterSequence: Effect.succeed(highWaterSequence),
          resumeFromSequence: 1,
          replay: (fromSequenceExclusive, throughSequenceInclusive) => {
            replayRanges.push([fromSequenceExclusive, throughSequenceInclusive]);
            return Stream.empty;
          },
        }).pipe(Stream.take(1), Stream.runCollect),
      ),
    );

    // Only the snapshot-fence replay ran; the overflowing cursor gap was never replayed.
    expect(replayRanges).toEqual([[highWaterSequence, highWaterSequence]]);
    expect(Array.from(items)).toEqual([
      { kind: "snapshot", snapshot: { snapshotSequence: highWaterSequence } },
    ]);
  });

  it("falls back to the snapshot when the cursor is ahead of the durable head", async () => {
    // A negative gap means the client cursor comes from a different event
    // journal (restored backup / reset DB); resuming from it would silently
    // skip history, so it must reset with a full snapshot.
    const replayRanges: Array<readonly [number, number]> = [];
    const items = await Effect.runPromise(
      Effect.scoped(
        makeCursorSafeSnapshotLiveStream({
          subscribeLive: Effect.succeed(Stream.empty),
          snapshot: Effect.succeed({ snapshotSequence: 2 }),
          snapshotSequence: (snapshot) => snapshot.snapshotSequence,
          getHighWaterSequence: Effect.succeed(2),
          resumeFromSequence: 100,
          replay: (fromSequenceExclusive, throughSequenceInclusive) => {
            replayRanges.push([fromSequenceExclusive, throughSequenceInclusive]);
            return Stream.empty;
          },
        }).pipe(Stream.take(1), Stream.runCollect),
      ),
    );

    // Only the snapshot-fence replay ran; the untrusted cursor was never replayed from.
    expect(replayRanges).toEqual([[2, 2]]);
    expect(Array.from(items)).toEqual([{ kind: "snapshot", snapshot: { snapshotSequence: 2 } }]);
  });

  it("falls back to the snapshot when the resume subject no longer exists", async () => {
    // A hard-purged thread leaves an in-range gap (unrelated events keep the
    // journal head above the cursor) but nothing to replay, so the resume
    // shortcut would stream silence forever instead of surfacing the deletion.
    const replayRanges: Array<readonly [number, number]> = [];
    const items = await Effect.runPromise(
      Effect.scoped(
        makeCursorSafeSnapshotLiveStream({
          subscribeLive: Effect.succeed(Stream.empty),
          snapshot: Effect.succeed({ snapshotSequence: 40 }),
          snapshotSequence: (snapshot) => snapshot.snapshotSequence,
          getHighWaterSequence: Effect.succeed(40),
          resumeFromSequence: 30,
          resumeSubjectExists: Effect.succeed(false),
          replay: (fromSequenceExclusive, throughSequenceInclusive) => {
            replayRanges.push([fromSequenceExclusive, throughSequenceInclusive]);
            return Stream.empty;
          },
        }).pipe(Stream.take(1), Stream.runCollect),
      ),
    );

    // The snapshot fence replayed, not the cursor gap.
    expect(replayRanges).toEqual([[40, 40]]);
    expect(Array.from(items)).toEqual([{ kind: "snapshot", snapshot: { snapshotSequence: 40 } }]);
  });

  it("resumes from the cursor when the subject still exists", async () => {
    const replayRanges: Array<readonly [number, number]> = [];
    const items = await Effect.runPromise(
      Effect.scoped(
        makeCursorSafeSnapshotLiveStream({
          subscribeLive: Effect.succeed(Stream.empty),
          snapshot: Effect.die("snapshot must not load on a valid resume"),
          snapshotSequence: (snapshot: { snapshotSequence: number }) => snapshot.snapshotSequence,
          getHighWaterSequence: Effect.succeed(40),
          resumeFromSequence: 30,
          resumeSubjectExists: Effect.succeed(true),
          replay: (fromSequenceExclusive, throughSequenceInclusive) => {
            replayRanges.push([fromSequenceExclusive, throughSequenceInclusive]);
            return Stream.empty;
          },
        }).pipe(Stream.runCollect),
      ),
    );

    expect(replayRanges).toEqual([[30, 40]]);
    expect(Array.from(items)).toEqual([]);
  });

  it("requires a fresh snapshot instead of replaying an unbounded attach gap", async () => {
    let replayStarted = false;
    const reports: Array<{
      readonly snapshotSequence: number;
      readonly highWaterSequence: number;
      readonly replayCount: number;
      readonly replayLimit: number;
    }> = [];
    const program = Effect.scoped(
      makeCursorSafeSnapshotLiveStream({
        subscribeLive: Effect.succeed(Stream.empty),
        snapshot: Effect.succeed({ snapshotSequence: 1 }),
        snapshotSequence: (snapshot) => snapshot.snapshotSequence,
        getHighWaterSequence: Effect.succeed(ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 2),
        onResnapshotRequired: (report) => Effect.sync(() => reports.push(report)),
        replay: () => {
          replayStarted = true;
          return Stream.empty;
        },
      }).pipe(Stream.runDrain),
    );

    await expect(Effect.runPromise(program)).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });
    expect(replayStarted).toBe(false);
    expect(reports).toEqual([
      {
        snapshotSequence: 1,
        highWaterSequence: ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 2,
        replayCount: ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 1,
        replayLimit: ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT,
      },
    ]);
  });

  it("escalates to a non-retryable failure when a restart re-demands the same fence", async () => {
    // Regression for the permanent resnapshot loop: a stalled or missing
    // projector froze the snapshot fence, so every stream restart demanded the
    // same unsatisfiable resnapshot forever. The second demand at a
    // non-advancing fence must be a distinguishable, non-retryable failure.
    const tracker = makeResnapshotEscalationTracker();
    const start = () =>
      Effect.runPromise(
        Effect.scoped(
          makeCursorSafeSnapshotLiveStream({
            resnapshotEscalation: { streamKey: "orchestration.shell", tracker },
            subscribeLive: Effect.succeed(Stream.empty),
            snapshot: Effect.succeed({ snapshotSequence: 1 }),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 2),
            replay: () => Stream.empty,
          }).pipe(Stream.runDrain),
        ),
      );

    await expect(start()).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });
    await expect(start()).rejects.toMatchObject({
      code: "ORCHESTRATION_SNAPSHOT_STALLED",
      retryable: false,
    });
  });

  it("tracks escalation per stream key so concurrent subscribers get independent chains", async () => {
    // Two clients demanding the same stale stream concurrently are two first
    // offenses: the caller keys the tracker per subscriber, and the tracker
    // must not bleed one subscriber's demand into another's restart chain.
    const tracker = makeResnapshotEscalationTracker();
    const start = (streamKey: string) =>
      Effect.runPromise(
        Effect.scoped(
          makeCursorSafeSnapshotLiveStream({
            resnapshotEscalation: { streamKey, tracker },
            subscribeLive: Effect.succeed(Stream.empty),
            snapshot: Effect.succeed({ snapshotSequence: 1 }),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 2),
            replay: () => Stream.empty,
          }).pipe(Stream.runDrain),
        ),
      );

    await expect(start("client-1:orchestration.shell")).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });
    // A different subscriber's first demand stays retryable.
    await expect(start("client-2:orchestration.shell")).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });
    // Each chain escalates independently on its own repeat.
    await expect(start("client-1:orchestration.shell")).rejects.toMatchObject({
      code: "ORCHESTRATION_SNAPSHOT_STALLED",
      retryable: false,
    });
  });

  it("keeps the retryable resnapshot demand while the fence advances between restarts", async () => {
    // An advancing fence means the projector is catching up: each restart is
    // making progress, so the demand must stay retryable.
    const tracker = makeResnapshotEscalationTracker();
    const start = (snapshotSequence: number) =>
      Effect.runPromise(
        Effect.scoped(
          makeCursorSafeSnapshotLiveStream({
            resnapshotEscalation: { streamKey: "orchestration.shell", tracker },
            subscribeLive: Effect.succeed(Stream.empty),
            snapshot: Effect.succeed({ snapshotSequence }),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT * 3),
            replay: () => Stream.empty,
          }).pipe(Stream.runDrain),
        ),
      );

    await expect(start(1)).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });
    await expect(start(ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT)).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });
  });

  it("clears escalation state after a healthy stream start", async () => {
    const tracker = makeResnapshotEscalationTracker();
    const failingStart = () =>
      Effect.runPromise(
        Effect.scoped(
          makeCursorSafeSnapshotLiveStream({
            resnapshotEscalation: { streamKey: "orchestration.shell", tracker },
            subscribeLive: Effect.succeed(Stream.empty),
            snapshot: Effect.succeed({ snapshotSequence: 1 }),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 2),
            replay: () => Stream.empty,
          }).pipe(Stream.runDrain),
        ),
      );

    await expect(failingStart()).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
    });

    // A healthy start (fence caught up) resets the loop detection.
    await Effect.runPromise(
      Effect.scoped(
        makeCursorSafeSnapshotLiveStream({
          resnapshotEscalation: { streamKey: "orchestration.shell", tracker },
          subscribeLive: Effect.succeed(Stream.empty),
          snapshot: Effect.succeed({ snapshotSequence: 5 }),
          snapshotSequence: (snapshot) => snapshot.snapshotSequence,
          getHighWaterSequence: Effect.succeed(5),
          replay: () => Stream.empty,
        }).pipe(Stream.take(1), Stream.runDrain),
      ),
    );

    // The next stale demand is a fresh first offense, retryable again.
    await expect(failingStart()).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });
  });
});
