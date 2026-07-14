/**
 * DrainableWorker - Bounded single-consumer work admission with staged shutdown.
 *
 * The capacity covers both the item currently being processed and queued items.
 * `enqueue` applies backpressure, while `tryEnqueue` rejects overload immediately.
 * Scope closure quiesces admission, drains accepted work, and only then stops the queue.
 *
 * @module DrainableWorker
 */
import { Cause, Data, Deferred, Effect, Exit, Queue, Ref, Scope } from "effect";

export const DEFAULT_DRAINABLE_WORKER_CAPACITY = 256;

export type DrainableWorkerPhase = "running" | "quiescing" | "draining" | "stopped";

export class DrainableWorkerAdmissionError extends Data.TaggedError(
  "DrainableWorkerAdmissionError",
)<{
  readonly reason: "overloaded" | "not-running";
  readonly phase: DrainableWorkerPhase;
  readonly capacity: number;
}> {}

export interface DrainableWorkerOptions {
  /** Maximum number of active plus queued items. */
  readonly capacity?: number;
}

export interface DrainableWorkerStatus {
  readonly phase: DrainableWorkerPhase;
  readonly outstanding: number;
  readonly capacity: number;
}

export interface DrainableWorker<A> {
  /**
   * Admit work, waiting for bounded capacity when the worker is full.
   * Returns false when shutdown has already quiesced admission.
   */
  readonly enqueue: (item: A) => Effect.Effect<boolean>;

  /** Admit work immediately or fail with an explicit overload/lifecycle reason. */
  readonly tryEnqueue: (
    item: A,
  ) => Effect.Effect<void, DrainableWorkerAdmissionError>;

  /** Stop accepting new work without interrupting already accepted items. */
  readonly quiesce: Effect.Effect<void>;

  /** Resolve when the current accepted-work generation is settled. */
  readonly drain: Effect.Effect<void>;

  /** Quiesce, drain accepted work, then stop the underlying worker queue. */
  readonly stop: Effect.Effect<void>;

  /** Current lifecycle and admission counters. */
  readonly status: Effect.Effect<DrainableWorkerStatus>;
}

/**
 * Run producer subscriptions in a child scope owned by the worker lifecycle.
 * Closing the caller scope first stops producers, then drains and stops the worker.
 */
export const startDrainableWorkerProducers = <A, E, R>(
  worker: DrainableWorker<A>,
  producers: Effect.Effect<void, E, Scope.Scope | R>,
): Effect.Effect<void, E, Scope.Scope | R> =>
  Effect.gen(function* () {
    const producerScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() =>
      Scope.close(producerScope, Exit.void).pipe(Effect.andThen(worker.stop)),
    );
    yield* Scope.provide(producers, producerScope);
  });

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

export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
  options?: DrainableWorkerOptions,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const capacity = normalizeCapacity(options?.capacity);
    const queue = yield* Queue.bounded<A>(capacity);
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
            slotAvailable:
              outstanding === capacity ? nextSlotAvailable : current.slotAvailable,
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
            current.outstanding === capacity && remaining < capacity
              ? current.slotAvailable
              : null,
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

    const offerReserved = (item: A) =>
      Queue.offer(queue, item).pipe(
        Effect.flatMap((accepted) => (accepted ? Effect.void : finishOne)),
      );

    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(queue).pipe(
          Effect.flatMap((item) =>
            process(item).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logError("drainable worker item failed", {
                      cause: Cause.pretty(cause),
                    }),
              ),
              Effect.ensuring(finishOne),
            ),
          ),
        ),
      ),
    );

    const enqueue: DrainableWorker<A>["enqueue"] = (item) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          while (true) {
            const reservation = yield* reserve;
            switch (reservation._tag) {
              case "accepted":
                yield* offerReserved(item);
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
          const reservation = yield* reserve;
          switch (reservation._tag) {
            case "accepted":
              yield* offerReserved(item);
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

    const drain = Ref.get(state).pipe(
      Effect.flatMap(({ idle }) => Deferred.await(idle)),
    );

    const stop = Effect.uninterruptible(
      quiesce.pipe(
        Effect.andThen(
          Ref.update(state, (current) =>
            current.phase === "stopped"
              ? current
              : {
                  ...current,
                  phase: "draining",
                },
          ),
        ),
        Effect.andThen(drain),
        Effect.andThen(Queue.shutdown(queue).pipe(Effect.asVoid)),
        Effect.andThen(
          Ref.update(state, (current) => ({
            ...current,
            phase: "stopped",
          })),
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
