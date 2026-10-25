import { ORCHESTRATION_STREAM_OVERFLOW_CODE, WsRpcError } from "@synara/contracts";
import * as Arr from "effect/Array";
import { Cause, Deferred, Effect, Exit, Queue, Scope, Semaphore, Stream } from "effect";

// FILE: wsStreamBackpressure.ts
// Purpose: Bound UI-facing websocket stream backlogs without weakening durable event processing.
// Layer: Server websocket transport
// Exports: bufferLiveUiStream, normalizeLiveUiStreamBufferCapacity, recordLiveUiStreamIngress
// Depends on: Effect Stream

export const DEFAULT_LIVE_UI_STREAM_BUFFER_CAPACITY = 1_024;
export const DEFAULT_LIVE_UI_STREAM_MAX_SERIALIZED_BYTES = 8 * 1024 * 1024;
const DROP_REPORT_GROWTH_STEP = 500;

export interface LiveUiStreamLagState {
  ingressCount: number;
  egressCount: number;
  reportedDroppedAtLeast: number;
}

export interface LiveUiStreamDropReport {
  readonly capacity: number;
  readonly droppedAtLeast: number;
  readonly label: string;
  readonly message: string;
  readonly retainedSerializedBytes?: number;
  readonly maxSerializedBytes?: number;
}

export function makeLiveUiStreamLagState(): LiveUiStreamLagState {
  return { ingressCount: 0, egressCount: 0, reportedDroppedAtLeast: 0 };
}

export function normalizeLiveUiStreamBufferCapacity(capacity: number): number {
  if (!Number.isFinite(capacity)) {
    return DEFAULT_LIVE_UI_STREAM_BUFFER_CAPACITY;
  }
  return Math.max(1, Math.floor(capacity));
}

/**
 * Records one buffered-stream ingress and returns the minimum number of dropped
 * events when that figure should be reported, or null when no report is due.
 * The figure is a lower bound: the sliding buffer may still deliver up to
 * `capacity` of the lagging events. Reports are gated so a stalled subscriber
 * logs once up front and then only as the loss keeps growing.
 */
export function recordLiveUiStreamIngress(
  state: LiveUiStreamLagState,
  capacity: number,
  reportGrowthStep = DROP_REPORT_GROWTH_STEP,
): number | null {
  state.ingressCount += 1;
  const droppedAtLeast = state.ingressCount - state.egressCount - capacity;
  if (droppedAtLeast <= 0) {
    return null;
  }
  if (
    state.reportedDroppedAtLeast > 0 &&
    droppedAtLeast - state.reportedDroppedAtLeast < reportGrowthStep
  ) {
    return null;
  }
  state.reportedDroppedAtLeast = droppedAtLeast;
  return droppedAtLeast;
}

export interface BufferLiveUiStreamOptions<E2 = never, R2 = never, A = unknown> {
  readonly capacity?: number;
  /** Snapshot-backed orchestration streams fail rather than silently lose events. */
  readonly overflowStrategy?: "sliding" | "fail";
  readonly maxSerializedBytes?: number;
  /** Finite bootstrap snapshots can be excluded from the live-event byte budget. */
  readonly serializedBytes?: (value: A) => number;
  /** Internal stage transfer: a subscription shares one budget by event identity. */
  readonly sharedBudget?: LiveUiStreamBudget<E2, R2>;
  readonly retentionKey?: (value: A) => object;
  /** Identifies the stream in dropped-event warnings. */
  readonly label?: string;
  /** Optional recovery hook. Snapshot-backed streams use this to restart/resubscribe. */
  readonly onDroppedEvents?: (report: LiveUiStreamDropReport) => Effect.Effect<void, E2, R2>;
}

export function bufferLiveUiStream<A, E, R, E2 = never, R2 = never>(
  stream: Stream.Stream<A, E, R>,
  options?: BufferLiveUiStreamOptions<E2, R2, A>,
): Stream.Stream<A, E | E2 | WsRpcError, R | R2> {
  const capacity = normalizeLiveUiStreamBufferCapacity(
    options?.capacity ?? DEFAULT_LIVE_UI_STREAM_BUFFER_CAPACITY,
  );
  const label = options?.label ?? "live-ui-stream";
  if (options?.overflowStrategy === "fail") {
    return bufferFailingLiveUiStream(stream, capacity, label, options);
  }
  return Stream.unwrap(
    Effect.sync(() => {
      // Lag counters must be per-run: handlers build a fresh stream per
      // subscription, and suspending keeps reruns of a shared stream value
      // from mixing their counts.
      const lagState = makeLiveUiStreamLagState();
      return stream.pipe(
        Stream.tap(() => {
          const droppedAtLeast = recordLiveUiStreamIngress(lagState, capacity);
          if (droppedAtLeast === null) {
            return Effect.void;
          }
          const report: LiveUiStreamDropReport = {
            capacity,
            droppedAtLeast,
            label,
            message: `[ws-stream] slow "${label}" subscriber: dropped at least ${droppedAtLeast} oldest events (capacity=${capacity})`,
          };
          const recover = options?.onDroppedEvents ?? (() => Effect.void);
          return Effect.logWarning(report.message).pipe(Effect.andThen(recover(report)));
        }),
        Stream.buffer({ capacity, strategy: "sliding" }),
        Stream.tap(() =>
          Effect.sync(() => {
            lagState.egressCount += 1;
          }),
        ),
      );
    }),
  );
}

// Domain events are immutable and shared by subscribers; cache only the size,
// never a serialized copy that would retain another copy of transcript text.
const serializedSizes = new WeakMap<object, number>();

function serializedSize(value: unknown): number {
  if (value !== null && typeof value === "object") {
    const cached = serializedSizes.get(value);
    if (cached !== undefined) return cached;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    serializedSizes.set(value, bytes);
    return bytes;
  }
  return Buffer.byteLength(JSON.stringify(value) ?? "null");
}

export interface LiveUiStreamLease {
  readonly release: () => void;
}

export interface LiveUiStreamBudget<E = never, R = never> {
  readonly acquire: (
    key: unknown,
    serializedBytes: number,
  ) => Effect.Effect<LiveUiStreamLease, E | WsRpcError, R>;
  readonly check: Effect.Effect<void, E | WsRpcError>;
  readonly failure: Effect.Effect<never, E | WsRpcError>;
  readonly overflow: Effect.Effect<never, E | WsRpcError>;
}

/** One subscription owns this budget; stage transfers share a reference-counted charge. */
export function makeLiveUiStreamBudget<E = never, R = never>(
  options: Pick<
    BufferLiveUiStreamOptions<E, R>,
    "capacity" | "maxSerializedBytes" | "label" | "onDroppedEvents"
  > = {},
): Effect.Effect<LiveUiStreamBudget<E, R>, never, Scope.Scope | R> {
  return Effect.gen(function* () {
    const capacity = normalizeLiveUiStreamBufferCapacity(
      options.capacity ?? DEFAULT_LIVE_UI_STREAM_BUFFER_CAPACITY,
    );
    const byteLimit = options.maxSerializedBytes ?? DEFAULT_LIVE_UI_STREAM_MAX_SERIALIZED_BYTES;
    const maxSerializedBytes = Number.isFinite(byteLimit)
      ? Math.max(1, Math.floor(byteLimit))
      : DEFAULT_LIVE_UI_STREAM_MAX_SERIALIZED_BYTES;
    const label = options.label ?? "live-ui-stream";
    const failed = yield* Deferred.make<never, E | WsRpcError>();
    const overflowReport = yield* Deferred.make<LiveUiStreamDropReport>();
    // Notifications cannot delay failure or teardown and cannot replace the
    // protocol error. This observer belongs to the budget's enclosing scope,
    // not the overflowing producer whose cancellation it can trigger.
    yield* Deferred.await(overflowReport).pipe(
      Effect.flatMap((report) =>
        Effect.logWarning(report.message).pipe(
          Effect.andThen(options.onDroppedEvents?.(report) ?? Effect.void),
        ),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("live UI stream overflow notification failed", {
              cause: Cause.pretty(cause),
            }),
      ),
      Effect.forkScoped,
    );
    const retained = new Map<unknown, { references: number; serializedBytes: number }>();
    let retainedSerializedBytes = 0;
    let failure: Cause.Cause<E | WsRpcError> | undefined;
    const check = Effect.suspend(() => (failure ? Effect.failCause(failure) : Effect.void));
    const overflow = Effect.gen(function* () {
      yield* check;
      const report: LiveUiStreamDropReport = {
        capacity,
        droppedAtLeast: 1,
        label,
        retainedSerializedBytes,
        maxSerializedBytes,
        message: `[ws-stream] slow "${label}" subscriber: live event budget exceeded (capacity=${capacity}, maxSerializedBytes=${maxSerializedBytes})`,
      };
      const error = new WsRpcError({
        message: `${report.message}; resume from the last received sequence.`,
        code: ORCHESTRATION_STREAM_OVERFLOW_CODE,
        retryable: true,
      });
      // Mark failure before running cleanup hooks so no other stage can
      // admit or emit an event while source teardown yields.
      failure = Cause.fail(error);
      retained.clear();
      retainedSerializedBytes = 0;
      yield* Deferred.failCause(failed, failure).pipe(
        Effect.andThen(Deferred.succeed(overflowReport, report)),
        Effect.uninterruptible,
      );
      return yield* Effect.failCause(failure);
    });
    return {
      check,
      failure: Deferred.await(failed),
      overflow,
      acquire: (key: unknown, serializedBytes: number) =>
        Effect.gen(function* () {
          yield* check;
          let entry = retained.get(key);
          if (entry === undefined) {
            if (
              retained.size + 1 > capacity ||
              retainedSerializedBytes + serializedBytes > maxSerializedBytes
            ) {
              return yield* overflow;
            }
            entry = { references: 0, serializedBytes };
            retained.set(key, entry);
            retainedSerializedBytes += serializedBytes;
          }
          entry.references += 1;
          const owned = entry;
          let released = false;
          return {
            release: () => {
              if (released) return;
              released = true;
              if (retained.get(key) !== owned) return;
              owned.references -= 1;
              if (owned.references === 0) {
                retained.delete(key);
                retainedSerializedBytes -= owned.serializedBytes;
              }
            },
          };
        }),
    };
  });
}

interface RetainedLiveUiItem<A> {
  readonly value: A;
  readonly lease: LiveUiStreamLease;
}

/** Internal eager live stage; finite replay is deliberately outside its budget. */
export function makeFailingLiveUiStream<A, E, R, E2 = never, R2 = never>(
  stream: Stream.Stream<A, E, R>,
  options: BufferLiveUiStreamOptions<E2, R2, A> = {},
  deferCompletionUntilFence = false,
): Effect.Effect<
  {
    readonly stream: Stream.Stream<A, E | E2 | WsRpcError>;
    readonly check: Effect.Effect<void, E2 | WsRpcError>;
    readonly failureExit: Effect.Effect<Exit.Exit<never, E | E2 | WsRpcError>>;
    readonly retainAfter: (keep: (value: A) => boolean, activate?: boolean) => Effect.Effect<void>;
  },
  never,
  Scope.Scope | R | R2
> {
  return Effect.gen(function* () {
    const capacity = normalizeLiveUiStreamBufferCapacity(
      options.capacity ?? DEFAULT_LIVE_UI_STREAM_BUFFER_CAPACITY,
    );
    const sourceScope = yield* Scope.fork(yield* Effect.scope);
    const budget = options.sharedBudget ?? (yield* makeLiveUiStreamBudget(options));
    // Store source failure as data: an interrupted source must not be confused
    // with cancellation of the observing fiber.
    const failed = yield* Deferred.make<Exit.Exit<never, E | E2 | WsRpcError>>();
    const output = yield* Queue.bounded<RetainedLiveUiItem<A>, E | E2 | WsRpcError | Cause.Done>(
      capacity,
    );
    const retained = new Set<RetainedLiveUiItem<A>>();
    let inFlight: ReadonlyArray<RetainedLiveUiItem<A>> = [];
    let keep = (_value: A) => true;
    let activated = !deferCompletionUntilFence;
    let completed = false;
    const bootstrapLock = yield* Semaphore.make(1);
    const release = (items: Iterable<RetainedLiveUiItem<A>>) => {
      for (const item of items) if (retained.delete(item)) item.lease.release();
    };
    const clear = () => {
      release(retained);
      inFlight = [];
      while (true) {
        const item = Queue.takeUnsafe(output);
        if (item === undefined || Exit.isFailure(item)) break;
      }
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(clear).pipe(Effect.andThen(Queue.shutdown(output))),
    );
    const retainValue = (value: A) =>
      Effect.gen(function* () {
        yield* budget.check;
        if (!keep(value)) return;
        // Bound references as well as distinct identities, including the batch
        // retained until the next RPC ACK. No offer can suspend during pruning.
        if (retained.size >= capacity) return yield* budget.overflow;
        const key =
          options.retentionKey?.(value) ??
          (value !== null && typeof value === "object" ? value : Symbol());
        const lease = yield* budget.acquire(
          key,
          options.serializedBytes?.(value) ?? serializedSize(value),
        );
        const item = { value, lease };
        retained.add(item);
        Queue.offerUnsafe(output, item);
      });
    const retain = (value: A) =>
      Effect.suspend(() =>
        activated ? retainValue(value) : bootstrapLock.withPermit(retainValue(value)),
      ).pipe(Effect.uninterruptible);
    yield* stream.pipe(
      Stream.runForEach(retain),
      Effect.raceFirst(budget.failure),
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          if (Exit.isFailure(exit)) {
            // Overflow's canonical failure wins over producer cancellation.
            const checked = yield* Effect.exit(budget.check);
            const cause = Exit.isFailure(checked) ? checked.cause : exit.cause;
            yield* Deferred.succeed(failed, Exit.failCause(cause));
            yield* Effect.sync(() => {
              clear();
              Queue.failCauseUnsafe(output, cause);
            });
          } else {
            yield* Effect.sync(() => {
              completed = true;
              if (activated) Queue.endUnsafe(output);
            });
          }
        }).pipe(Effect.uninterruptible),
      ),
      Scope.provide(sourceScope),
      Effect.forkScoped,
    );
    // A separate observer owns teardown even when the subscriber never ACKs.
    yield* budget.failure.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Scope.close(sourceScope, Exit.failCause(cause)).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  clear();
                  Queue.failCauseUnsafe(output, cause);
                }),
              ),
              Effect.andThen(Deferred.succeed(failed, Exit.failCause(cause))),
              Effect.uninterruptible,
            ),
      ),
      Effect.forkScoped,
    );
    const pull = yield* Stream.toPull(Stream.fromQueue(output));
    return {
      failureExit: Deferred.await(failed),
      check: budget.check,
      retainAfter: (predicate, activate = true) =>
        bootstrapLock.withPermit(
          Effect.sync(() => {
            keep = predicate;
            // All queue mutation is synchronous; the bounded scratch array never
            // races an offer or loses a completed source's strictly newer tail.
            const remaining: Array<RetainedLiveUiItem<A>> = [];
            while (true) {
              const item = Queue.takeUnsafe(output);
              if (item === undefined || Exit.isFailure(item)) break;
              if (keep(item.value.value)) remaining.push(item.value);
              else release([item.value]);
            }
            for (const item of remaining) Queue.offerUnsafe(output, item);
            activated ||= activate;
            if (completed && activated) Queue.endUnsafe(output);
          }),
        ),
      stream: Stream.fromPull(
        Effect.succeed(
          Effect.gen(function* () {
            release(inFlight);
            inFlight = [];
            yield* budget.check;
            const items = yield* pull;
            inFlight = items;
            yield* budget.check;
            return Arr.map(items, (item) => item.value);
          }),
        ),
      ),
    };
  });
}

/** Bound the source and keep the delivered batch charged until the next RPC pull/ACK. */
function bufferFailingLiveUiStream<A, E, R, E2, R2>(
  stream: Stream.Stream<A, E, R>,
  capacity: number,
  label: string,
  options: BufferLiveUiStreamOptions<E2, R2, A>,
): Stream.Stream<A, E | E2 | WsRpcError, R | R2> {
  return Stream.unwrap(
    makeFailingLiveUiStream(stream, { ...options, capacity, label }).pipe(
      Effect.map((buffer) => buffer.stream),
    ),
  );
}
