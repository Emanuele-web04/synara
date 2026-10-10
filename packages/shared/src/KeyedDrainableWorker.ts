/** Bounded ready-key scheduling with FIFO lanes and staged shutdown. */
import { Cause, Deferred, Effect, Fiber, Queue, Ref, Scope } from "effect";
import {
  DEFAULT_DRAINABLE_WORKER_CAPACITY,
  DrainableWorkerAdmissionError,
  type DrainableWorker,
  type DrainableWorkerPhase,
  type DrainableWorkerStatus,
} from "./DrainableWorker";

export interface KeyedDrainableWorkerOptions<A> {
  readonly key: (item: A) => string;
  readonly concurrency: number;
  /** Maximum active plus queued work across all keys. */
  readonly capacity?: number;
  /** Lower values run first; only ready heads participate in priority. */
  readonly priority?: (item: A) => number;
  /** Continue a successful bounded quantum with its existing admission reservation. */
  readonly shouldContinue?: (item: A) => boolean;
}

type WorkerState = {
  readonly phase: DrainableWorkerPhase;
  readonly outstanding: number;
  readonly idle: Deferred.Deferred<void>;
  readonly slotAvailable: Deferred.Deferred<void>;
};

type AdmissionReservation =
  | { readonly _tag: "accepted" }
  | { readonly _tag: "wait"; readonly signal: Deferred.Deferred<void> }
  | { readonly _tag: "rejected"; readonly phase: DrainableWorkerPhase };

function normalizeCapacity(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DRAINABLE_WORKER_CAPACITY;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("DrainableWorker capacity must be a positive safe integer");
  }
  return value;
}

export const makeKeyedDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
  options: KeyedDrainableWorkerOptions<A>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const capacity = normalizeCapacity(options.capacity);
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0) {
      throw new RangeError("KeyedDrainableWorker concurrency must be a positive safe integer");
    }
    type Entry = { readonly item: A; readonly priority: number; readonly order: number };
    type Lane = { readonly entries: Entry[]; active: boolean };
    const lanes = new Map<string, Lane>();
    let admissionOrder = 0;
    // Only ready heads compete for a consumer. A busy key's followers never
    // occupy a concurrency permit while waiting for their predecessor.
    // Pulses have no item identity. Coalesce them to at most one per consumer:
    // one token per item would accumulate forever while full producers refill
    // every completed slot before consumers empty the notification queue.
    const wake = yield* Queue.sliding<void>(options.concurrency);
    const takeReady = Effect.sync(() => {
      let selected: { key: string; lane: Lane; entry: Entry } | undefined;
      for (const [key, lane] of lanes) {
        const entry = lane.entries[0];
        if (lane.active || entry === undefined) continue;
        if (
          selected === undefined ||
          entry.priority < selected.entry.priority ||
          (entry.priority === selected.entry.priority && entry.order < selected.entry.order)
        ) {
          selected = { key, lane, entry };
        }
      }
      if (selected !== undefined) {
        selected.lane.active = true;
        selected.lane.entries.shift();
      }
      return selected;
    });
    const initialIdle = yield* Deferred.make<void>();
    const initialSlotAvailable = yield* Deferred.make<void>();
    yield* Deferred.succeed(initialIdle, undefined).pipe(Effect.orDie);
    yield* Deferred.succeed(initialSlotAvailable, undefined).pipe(Effect.orDie);
    const state = yield* Ref.make<WorkerState>({
      phase: "running",
      outstanding: 0,
      idle: initialIdle,
      slotAvailable: initialSlotAvailable,
    });

    const reserve = Effect.gen(function* () {
      const nextIdle = yield* Deferred.make<void>();
      const nextSlotAvailable = yield* Deferred.make<void>();
      return yield* Ref.modify(state, (current): readonly [AdmissionReservation, WorkerState] => {
        if (current.phase !== "running") {
          return [{ _tag: "rejected", phase: current.phase }, current];
        }
        if (current.outstanding >= capacity) {
          return [{ _tag: "wait", signal: current.slotAvailable }, current];
        }

        const outstanding = current.outstanding + 1;
        return [
          { _tag: "accepted" },
          {
            ...current,
            outstanding,
            idle: current.outstanding === 0 ? nextIdle : current.idle,
            slotAvailable: outstanding === capacity ? nextSlotAvailable : current.slotAvailable,
          },
        ];
      });
    });

    const finishOne = Ref.modify(state, (current) => {
      const remaining = Math.max(0, current.outstanding - 1);
      return [
        {
          idle: remaining === 0 ? current.idle : null,
          slotAvailable:
            current.outstanding === capacity && remaining < capacity ? current.slotAvailable : null,
        },
        {
          ...current,
          outstanding: remaining,
        },
      ] as const;
    }).pipe(
      Effect.flatMap((signals) =>
        Effect.all([
          signals.idle === null
            ? Effect.void
            : Deferred.succeed(signals.idle, undefined).pipe(Effect.orDie),
          signals.slotAvailable === null
            ? Effect.void
            : Deferred.succeed(signals.slotAvailable, undefined).pipe(Effect.orDie),
        ]).pipe(Effect.asVoid),
      ),
    );

    const offerReserved = (item: A, key: string, priority: number) =>
      Effect.sync(() => {
        let lane = lanes.get(key);
        if (lane === undefined) {
          lane = { entries: [], active: false };
          lanes.set(key, lane);
        }
        lane.entries.push({ item, priority, order: admissionOrder++ });
        Queue.offerUnsafe(wake, undefined);
      });

    const consume = Effect.forever(
      Queue.take(wake).pipe(
        Effect.andThen(takeReady),
        Effect.flatMap((selected) =>
          selected === undefined
            ? Effect.void
            : Effect.suspend(() => {
                let continuation: { readonly priority: number } | undefined;
                return Effect.gen(function* () {
                  // Process and continuation callbacks share the isolated child:
                  // self-interruption or a throwing predicate cannot kill the
                  // persistent consumer or leak its admission reservation.
                  const itemFiber = yield* Effect.forkChild(
                    Effect.suspend(() => process(selected.entry.item)).pipe(
                      Effect.andThen(
                        Effect.sync(() =>
                          options.shouldContinue?.(selected.entry.item)
                            ? { priority: options.priority?.(selected.entry.item) ?? 0 }
                            : undefined,
                        ),
                      ),
                    ),
                  );
                  const outcome = yield* Fiber.await(itemFiber);
                  if (outcome._tag === "Success") {
                    continuation = outcome.value;
                  } else if (!Cause.hasInterruptsOnly(outcome.cause)) {
                    yield* Effect.logError("keyed drainable worker item failed", {
                      cause: Cause.pretty(outcome.cause),
                    });
                  }
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      selected.lane.active = false;
                      if (continuation !== undefined) {
                        // Keep logical FIFO within this key, but reconsider it
                        // after older ready peers without reserving another slot.
                        selected.lane.entries.unshift({
                          item: selected.entry.item,
                          priority: continuation.priority,
                          order: admissionOrder++,
                        });
                      } else if (selected.lane.entries.length === 0) {
                        lanes.delete(selected.key);
                      }
                      Queue.offerUnsafe(wake, undefined);
                    }).pipe(
                      Effect.andThen(
                        Effect.suspend(() =>
                          continuation === undefined ? finishOne : Effect.void,
                        ),
                      ),
                    ),
                  ),
                );
              }),
        ),
      ),
    );
    for (let index = 0; index < options.concurrency; index += 1) {
      yield* Effect.forkScoped(consume);
    }

    const enqueue: DrainableWorker<A>["enqueue"] = (item) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const key = options.key(item);
          const priority = options.priority?.(item) ?? 0;
          while (true) {
            const reservation = yield* reserve;
            switch (reservation._tag) {
              case "accepted":
                yield* offerReserved(item, key, priority);
                return true;
              case "rejected":
                return false;
              case "wait":
                yield* restore(Deferred.await(reservation.signal));
            }
          }
        }),
      );

    const tryEnqueue: DrainableWorker<A>["tryEnqueue"] = (item) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const key = options.key(item);
          const priority = options.priority?.(item) ?? 0;
          const reservation = yield* reserve;
          switch (reservation._tag) {
            case "accepted":
              yield* offerReserved(item, key, priority);
              return;
            case "wait":
              return yield* new DrainableWorkerAdmissionError({
                reason: "overloaded",
                phase: "running",
                capacity,
              });
            case "rejected":
              return yield* new DrainableWorkerAdmissionError({
                reason: "not-running",
                phase: reservation.phase,
                capacity,
              });
          }
        }),
      );

    const quiesce = Ref.modify(state, (current) => {
      if (current.phase !== "running") return [null, current] as const;
      return [
        current.slotAvailable,
        {
          ...current,
          phase: "quiescing" as const,
        },
      ] as const;
    }).pipe(
      Effect.flatMap((slotAvailable) =>
        slotAvailable === null
          ? Effect.void
          : Deferred.succeed(slotAvailable, undefined).pipe(Effect.orDie),
      ),
    );

    const drain = Ref.get(state).pipe(Effect.flatMap(({ idle }) => Deferred.await(idle)));

    const stop = Effect.uninterruptible(
      quiesce.pipe(
        Effect.andThen(
          Ref.update(
            state,
            (current): WorkerState =>
              current.phase === "stopped"
                ? current
                : {
                    ...current,
                    phase: "draining",
                  },
          ),
        ),
        Effect.andThen(drain),
        Effect.andThen(Queue.shutdown(wake).pipe(Effect.asVoid)),
        Effect.andThen(
          Ref.update(
            state,
            (current): WorkerState => ({
              ...current,
              phase: "stopped",
            }),
          ),
        ),
      ),
    );

    const status = Ref.get(state).pipe(
      Effect.map(
        (current): DrainableWorkerStatus => ({
          phase: current.phase,
          outstanding: current.outstanding,
          capacity,
        }),
      ),
    );

    // Registered after the worker fiber so scope finalization drains before
    // forkScoped interrupts the consumer.
    yield* Effect.addFinalizer(() => stop);

    return {
      enqueue,
      tryEnqueue,
      quiesce,
      drain,
      stop,
      status,
    } satisfies DrainableWorker<A>;
  });
