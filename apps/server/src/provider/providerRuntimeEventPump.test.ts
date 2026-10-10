import { Cause, Deferred, Effect, Fiber, Option, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  EventId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import { it as effectIt } from "@effect/vitest";
import { TestClock } from "effect/testing";

import {
  makeProviderRuntimeEventPumpHealthRegistry,
  runProviderRuntimeEventPump,
} from "./providerRuntimeEventPump.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-runtime-pump");
const TURN_ID = TurnId.makeUnsafe("turn-runtime-pump");
type TextEvent = Extract<ProviderRuntimeEvent, { readonly type: "content.delta" }>;

function completedEvent(eventId: string): ProviderRuntimeEvent {
  return {
    type: "turn.completed",
    eventId: EventId.makeUnsafe(eventId),
    provider: "codex",
    createdAt: "2026-07-23T20:00:00.000Z",
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: { state: "completed" },
  };
}

function textEvent(eventId: string, delta: string): TextEvent {
  return {
    ...completedEvent(eventId),
    type: "content.delta",
    itemId: RuntimeItemId.makeUnsafe("item-runtime-pump"),
    payload: { streamKind: "assistant_text", delta },
    raw: { source: "claude.sdk.message", method: "text_delta", payload: {} },
  };
}

async function processTextBurst(events: ReadonlyArray<ProviderRuntimeEvent>) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const processed: ProviderRuntimeEvent[] = [];
        const completed = yield* Deferred.make<void>();
        const terminal = completedEvent("burst-terminal");
        yield* runProviderRuntimeEventPump({
          provider: "codex",
          stream: Stream.fromIterable([...events, terminal]),
          batchAssistantText: true,
          processEvent: (event) =>
            Effect.sync(() => processed.push(event)).pipe(
              Effect.andThen(
                event.eventId === terminal.eventId
                  ? Deferred.succeed(completed, undefined)
                  : Effect.void,
              ),
              Effect.asVoid,
            ),
          updateHealth: () => {},
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(completed);
        return processed.slice(0, -1);
      }),
    ),
  );
}

describe("providerRuntimeEventPump assistant text batching", () => {
  it("accepts contiguous text as one immutable event before a terminal boundary", async () => {
    const first = textEvent("text-first", "Hello ");
    const second = { ...textEvent("text-second", "world"), createdAt: "2026-07-23T20:00:00.005Z" };
    expect(await processTextBurst([first, second])).toEqual([
      { ...first, payload: { streamKind: "assistant_text", delta: "Hello world" } },
    ]);
  });

  effectIt.effect("flushes within 25 ms of the first delta without extending its deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
        const admitted = yield* Deferred.make<void>();
        const processed = yield* Deferred.make<ProviderRuntimeEvent>();
        let accepts = 0;
        yield* runProviderRuntimeEventPump({
          provider: "codex",
          stream: Stream.fromQueue(queue).pipe(
            Stream.tap(() => Deferred.succeed(admitted, undefined)),
          ),
          batchAssistantText: true,
          processEvent: (event) =>
            Effect.sync(() => {
              accepts += 1;
            }).pipe(Effect.andThen(Deferred.succeed(processed, event)), Effect.asVoid),
          updateHealth: () => {},
        }).pipe(Effect.forkScoped);
        yield* Queue.offer(queue, textEvent("deadline-first", "A"));
        yield* Deferred.await(admitted);
        yield* TestClock.adjust("24 millis");
        expect(accepts).toBe(0);
        yield* Queue.offer(queue, textEvent("deadline-second", "B"));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 millis");
        expect((yield* Deferred.await(processed)).payload).toEqual({
          streamKind: "assistant_text",
          delta: "AB",
        });
        expect(accepts).toBe(1);
      }),
    ),
  );

  it.each([
    [
      "thread",
      (event: TextEvent) => ({
        ...event,
        threadId: ThreadId.makeUnsafe("other-thread"),
      }),
    ],
    ["turn", (event: TextEvent) => ({ ...event, turnId: TurnId.makeUnsafe("other-turn") })],
    [
      "item",
      (event: TextEvent) => ({
        ...event,
        itemId: RuntimeItemId.makeUnsafe("other-item"),
      }),
    ],
    ["generation", (event: TextEvent) => ({ ...event, lifecycleGeneration: "other-generation" })],
    [
      "refs",
      (event: TextEvent) => ({
        ...event,
        providerRefs: { providerParentThreadId: "child-parent" },
      }),
    ],
    [
      "reasoning",
      (event: TextEvent) => ({
        ...event,
        payload: { streamKind: "reasoning_text" as const, delta: "B" },
      }),
    ],
    [
      "content index",
      (event: TextEvent) => ({
        ...event,
        payload: { streamKind: "assistant_text" as const, delta: "B", contentIndex: 1 },
      }),
    ],
    [
      "unknown raw metadata",
      (event: TextEvent) => ({
        ...event,
        raw: { source: "claude.sdk.message" as const, payload: { signature: "opaque" } },
      }),
    ],
    [
      "unknown payload metadata",
      (event: TextEvent) => ({
        ...event,
        payload: { streamKind: "assistant_text" as const, delta: "B", providerOnly: true },
      }),
    ],
    ["unknown envelope metadata", (event: TextEvent) => ({ ...event, providerOnly: true })],
    [
      "unknown refs metadata",
      (event: TextEvent) =>
        ({ ...event, providerRefs: { providerOnly: true } }) as unknown as ProviderRuntimeEvent,
    ],
  ] as const)("preserves %s boundaries without coalescing", async (_name, change) => {
    const first = textEvent("boundary-first", "A");
    const second = change(textEvent("boundary-second", "B"));
    expect(await processTextBurst([first, second])).toEqual([first, second]);
  });

  it("passes turnless deltas and unknown metadata through unchanged", async () => {
    const { turnId: _turnId, ...turnless } = textEvent("turnless-first", "A");
    const first = {
      ...turnless,
      raw: { source: "claude.sdk.message" as const, payload: { signature: "same" } },
    };
    const second = {
      ...first,
      eventId: EventId.makeUnsafe("turnless-second"),
      payload: { streamKind: "assistant_text" as const, delta: "B" },
    };
    expect(await processTextBurst([first, second])).toEqual([first, second]);
  });

  it.each(["raw", "payload", "envelope", "refs"] as const)(
    "does not coalesce even identical unknown %s metadata",
    async (where) => {
      const known = textEvent("opaque-first", "A");
      const first = {
        ...known,
        ...(where === "raw"
          ? { raw: { source: "claude.sdk.message", payload: { signature: "opaque" } } }
          : {}),
        ...(where === "payload"
          ? { payload: { streamKind: "assistant_text", delta: "A", opaque: "same" } }
          : {}),
        ...(where === "envelope" ? { opaque: "same" } : {}),
        ...(where === "refs" ? { providerRefs: { opaque: "same" } } : {}),
      } as ProviderRuntimeEvent;
      const second = { ...first, eventId: EventId.makeUnsafe("opaque-second") };
      expect(await processTextBurst([first, second])).toEqual([first, second]);
    },
  );

  it("preserves opaque raw payload objects without enumerable keys", async () => {
    const first = {
      ...textEvent("opaque-object-first", "A"),
      raw: { source: "claude.sdk.message" as const, payload: new Date(0) },
    };
    const second = { ...first, eventId: EventId.makeUnsafe("opaque-object-second") };
    expect(await processTextBurst([first, second])).toEqual([first, second]);
  });

  it("bounds UTF-8 text at 32 KiB and source events at 256", async () => {
    const bytes = await processTextBurst([
      textEvent("bytes-first", "é".repeat(8192)),
      textEvent("bytes-second", "é".repeat(8192)),
      textEvent("bytes-last", "x"),
    ]);
    expect(
      bytes.map((event) =>
        event.type === "content.delta" ? Buffer.byteLength(event.payload.delta) : 0,
      ),
    ).toEqual([32768, 1]);
    const events = await processTextBurst(
      Array.from({ length: 257 }, (_, index) => textEvent(`count-${index}`, "x")),
    );
    expect(
      events.map((event) => (event.type === "content.delta" ? event.payload.delta.length : 0)),
    ).toEqual([256, 1]);
  });

  it("retries the same combined envelope after an uncertain commit before terminal acceptance", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const done = yield* Deferred.make<void>();
          const attempts: ProviderRuntimeEvent[] = [];
          const first = textEvent("retry-first", "A");
          yield* runProviderRuntimeEventPump({
            provider: "codex",
            stream: Stream.fromIterable([
              first,
              textEvent("retry-second", "B"),
              completedEvent("retry-terminal"),
            ]),
            batchAssistantText: true,
            processEvent: (event) =>
              Effect.gen(function* () {
                attempts.push(event);
                if (attempts.length === 1)
                  return yield* Effect.fail(new Error("commit result uncertain"));
                if (event.type === "turn.completed") yield* Deferred.succeed(done, undefined);
              }),
            updateHealth: () => {},
            retryBaseDelayMs: 1,
            retryMaxDelayMs: 1,
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(done);
          expect(attempts).toHaveLength(3);
          expect(attempts[0]).toBe(attempts[1]);
          expect(attempts[0]?.payload).toEqual({ streamKind: "assistant_text", delta: "AB" });
          expect(attempts[2]?.type).toBe("turn.completed");
        }),
      ),
    );
  });

  effectIt.effect("flushes buffered text on scope interruption", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
        const admitted = yield* Deferred.make<void>();
        const events: ProviderRuntimeEvent[] = [];
        const fiber = yield* runProviderRuntimeEventPump({
          provider: "codex",
          stream: Stream.fromQueue(queue).pipe(
            Stream.tap(() => Deferred.succeed(admitted, undefined)),
          ),
          batchAssistantText: true,
          processEvent: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          updateHealth: () => {},
        }).pipe(Effect.forkScoped);
        const event = textEvent("cancel-buffer", "Keep me");
        yield* Queue.offer(queue, event);
        yield* Deferred.await(admitted);
        yield* Effect.yieldNow;
        expect(events).toEqual([]);
        yield* Fiber.interrupt(fiber);
        expect(events).toEqual([event]);
      }),
    ),
  );

  it.each(["end", "defect"] as const)(
    "flushes pending text before a stream %s and its restart",
    async (mode) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            let subscriptions = 0;
            const events: ProviderRuntimeEvent[] = [];
            const done = yield* Deferred.make<void>();
            yield* runProviderRuntimeEventPump({
              provider: "codex",
              stream: Stream.unwrap(
                Effect.sync(() => {
                  subscriptions += 1;
                  if (subscriptions > 1) return Stream.succeed(completedEvent("restart-terminal"));
                  const source = Stream.make(
                    textEvent("restart-first", "A"),
                    textEvent("restart-second", "B"),
                  );
                  return mode === "end"
                    ? source
                    : Stream.concat(source, Stream.die(new Error("source died")));
                }),
              ),
              batchAssistantText: true,
              processEvent: (event) =>
                Effect.sync(() => {
                  events.push(event);
                }).pipe(
                  Effect.andThen(
                    event.type === "turn.completed"
                      ? Deferred.succeed(done, undefined)
                      : Effect.void,
                  ),
                  Effect.asVoid,
                ),
              updateHealth: () => {},
              retryBaseDelayMs: 1,
              retryMaxDelayMs: 1,
            }).pipe(Effect.forkScoped);
            yield* Deferred.await(done);
            expect(events).toHaveLength(2);
            expect(events[0]?.payload).toEqual({ streamKind: "assistant_text", delta: "AB" });
            expect(events[1]?.type).toBe("turn.completed");
          }),
        ),
      );
    },
  );
});

describe("providerRuntimeEventPump", () => {
  it("retries the current event before consuming the next queue item", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const completed = yield* Deferred.make<void>();
          const health = makeProviderRuntimeEventPumpHealthRegistry(["codex"]);
          const processed: string[] = [];
          let attempts = 0;

          const fiber = yield* runProviderRuntimeEventPump({
            provider: "codex",
            stream: Stream.fromQueue(queue),
            processEvent: (event) =>
              Effect.gen(function* () {
                attempts += 1;
                if (attempts === 1) {
                  return yield* Effect.fail(new Error("sqlite busy"));
                }
                processed.push(event.eventId);
                yield* Deferred.succeed(completed, undefined);
              }),
            updateHealth: health.update,
            retryBaseDelayMs: 1,
            retryMaxDelayMs: 2,
          }).pipe(Effect.forkScoped);

          yield* Queue.offer(queue, completedEvent("event-retried"));
          yield* Deferred.await(completed);
          yield* Effect.sleep(5);
          yield* Fiber.interrupt(fiber);

          expect(attempts).toBe(2);
          expect(processed).toEqual(["event-retried"]);
          expect(health.snapshot()[0]).toMatchObject({
            provider: "codex",
            status: "healthy",
            consecutiveFailures: 0,
          });
        }),
      ),
    );
  });

  it("restarts an Adapter stream that dies unexpectedly", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const completed = yield* Deferred.make<void>();
          const health = makeProviderRuntimeEventPumpHealthRegistry(["codex"]);
          let subscriptions = 0;

          const stream = Stream.unwrap(
            Effect.sync(() => {
              subscriptions += 1;
              return subscriptions === 1
                ? Stream.die(new Error("adapter stream defect"))
                : Stream.fromQueue(queue);
            }),
          );
          const fiber = yield* runProviderRuntimeEventPump({
            provider: "codex",
            stream,
            processEvent: () => Deferred.succeed(completed, undefined).pipe(Effect.asVoid),
            updateHealth: health.update,
            retryBaseDelayMs: 1,
            retryMaxDelayMs: 2,
          }).pipe(Effect.forkScoped);

          yield* Queue.offer(queue, completedEvent("event-after-restart"));
          yield* Deferred.await(completed);
          yield* Effect.sleep(5);
          yield* Fiber.interrupt(fiber);

          expect(subscriptions).toBeGreaterThanOrEqual(2);
          expect(health.snapshot()[0]?.status).toBe("healthy");
        }),
      ),
    );
  });

  it("quarantines a permanent event failure and continues with later events", async () => {
    class PermanentEventError extends Error {}

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const completed = yield* Deferred.make<void>();
          const health = makeProviderRuntimeEventPumpHealthRegistry(["codex"]);
          const processed: string[] = [];
          const quarantined: string[] = [];

          const fiber = yield* runProviderRuntimeEventPump({
            provider: "codex",
            stream: Stream.fromQueue(queue),
            processEvent: (event) =>
              event.eventId === "event-poison"
                ? Effect.fail(new PermanentEventError("invalid canonical event"))
                : Effect.sync(() => processed.push(event.eventId)).pipe(
                    Effect.andThen(Deferred.succeed(completed, undefined)),
                    Effect.asVoid,
                  ),
            updateHealth: health.update,
            isPermanentFailure: (cause) =>
              Option.match(Cause.findErrorOption(cause), {
                onNone: () => false,
                onSome: (error) => error instanceof PermanentEventError,
              }),
            quarantineEvent: (event) =>
              Effect.sync(() => {
                quarantined.push(event.eventId);
              }),
            retryBaseDelayMs: 1,
            retryMaxDelayMs: 2,
          }).pipe(Effect.forkScoped);

          yield* Queue.offerAll(queue, [
            completedEvent("event-poison"),
            completedEvent("event-after-poison"),
          ]);
          yield* Deferred.await(completed);
          yield* Effect.sleep(5);
          yield* Fiber.interrupt(fiber);

          expect(processed).toEqual(["event-after-poison"]);
          expect(quarantined).toEqual(["event-poison"]);
          expect(health.snapshot()[0]).toMatchObject({
            status: "degraded",
            quarantinedEvents: 1,
            lastQuarantinedEventId: "event-poison",
          });
        }),
      ),
    );
  });

  it("heals a degraded pump after sustained successful processing", async () => {
    class PermanentEventError extends Error {}

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const completed = yield* Deferred.make<void>();
          const health = makeProviderRuntimeEventPumpHealthRegistry(["codex"]);
          const processed: string[] = [];

          const fiber = yield* runProviderRuntimeEventPump({
            provider: "codex",
            stream: Stream.fromQueue(queue),
            processEvent: (event) =>
              event.eventId === "event-poison"
                ? Effect.fail(new PermanentEventError("invalid canonical event"))
                : Effect.sync(() => {
                    processed.push(event.eventId);
                  }).pipe(
                    Effect.andThen(
                      event.eventId === "event-heal-3"
                        ? Deferred.succeed(completed, undefined).pipe(Effect.asVoid)
                        : Effect.void,
                    ),
                  ),
            updateHealth: health.update,
            isPermanentFailure: (cause) =>
              Option.match(Cause.findErrorOption(cause), {
                onNone: () => false,
                onSome: (error) => error instanceof PermanentEventError,
              }),
            quarantineEvent: () => Effect.void,
            retryBaseDelayMs: 1,
            retryMaxDelayMs: 2,
            degradedHealAfterSuccesses: 3,
          }).pipe(Effect.forkScoped);

          yield* Queue.offerAll(queue, [
            completedEvent("event-poison"),
            completedEvent("event-heal-1"),
            completedEvent("event-heal-2"),
            completedEvent("event-heal-3"),
          ]);
          yield* Deferred.await(completed);
          yield* Effect.sleep(5);
          yield* Fiber.interrupt(fiber);

          expect(processed).toEqual(["event-heal-1", "event-heal-2", "event-heal-3"]);
          // Healed: no longer degraded, but the quarantine forensics survive.
          expect(health.snapshot()[0]).toMatchObject({
            status: "healthy",
            quarantinedEvents: 0,
            lastQuarantinedEventId: "event-poison",
          });
        }),
      ),
    );
  });
});
