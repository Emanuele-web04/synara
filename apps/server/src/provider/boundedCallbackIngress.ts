/**
 * boundedCallbackIngress - A synchronous admission bridge for callback APIs.
 *
 * Callback-style providers cannot await Effect Queue backpressure. Starting one
 * Promise per Queue.offer only moves an unbounded backlog outside the queue.
 * This bridge admits synchronously into a fixed count/byte budget and runs one
 * serial Effect consumer. Reserved capacity protects terminal lifecycle events.
 */
import { Cause, Effect, Fiber, Option, Scope } from "effect";

export type BoundedCallbackIngressOfferResult =
  | "accepted"
  | "dropped"
  | "evicted-for-terminal"
  | "closed"
  | "terminal-overflow";

export interface BoundedCallbackIngressStatus {
  readonly accepting: boolean;
  readonly queued: number;
  readonly queuedBytes: number;
  readonly accepted: number;
  readonly dropped: number;
  readonly evictedForTerminal: number;
  readonly terminalOverflow: number;
}

export interface BoundedCallbackIngress<A> {
  /** Synchronous and allocation-bounded; safe to call from EventEmitter/SDK callbacks. */
  readonly offer: (item: A) => BoundedCallbackIngressOfferResult;
  /** Stop admission and wait until every accepted item has been processed. */
  readonly stop: Effect.Effect<void>;
  /** Release queued work when the owning scope and downstream consumer are closing. */
  readonly abort: Effect.Effect<void>;
  readonly status: () => BoundedCallbackIngressStatus;
}

export interface BoundedCallbackIngressOptions<A, P = never> {
  readonly capacity: number;
  readonly maxBufferedBytes: number;
  readonly terminalReserve: number;
  readonly isTerminal: (item: A) => boolean;
  readonly sizeOf: (item: A) => number;
  /** Prepare small metadata only. Do not retain payloads after eviction; publication stays serial. */
  readonly prepare?: (item: A) => Promise<P>;
  readonly prepareConcurrency?: number;
}

type BufferedItem<A, P> = {
  item: A | undefined;
  readonly bytes: number;
  readonly terminal: boolean;
  prepared?: Promise<{ readonly metadata: P } | { readonly cause: unknown }> | undefined;
  resolvePrepared?:
    | ((result: { readonly metadata: P } | { readonly cause: unknown }) => void)
    | undefined;
  discarded?: boolean;
};

type ResumeTake<A, P> = (effect: Effect.Effect<Option.Option<BufferedItem<A, P>>>) => void;

function normalizedPositiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

export const makeBoundedCallbackIngress = <A, E, R, P = never>(
  process: (item: A, prepared?: P) => Effect.Effect<void, E, R>,
  options: BoundedCallbackIngressOptions<A, P>,
): Effect.Effect<BoundedCallbackIngress<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const capacity = normalizedPositiveInt(options.capacity, 1);
    const maxBufferedBytes = normalizedPositiveInt(options.maxBufferedBytes, 1);
    const terminalReserve = Math.min(capacity, Math.max(1, Math.floor(options.terminalReserve)));
    const normalCapacity = Math.max(0, capacity - terminalReserve);
    const buffer: Array<BufferedItem<A, P>> = [];
    let queuedBytes = 0;
    let accepting = true;
    let waiter: ResumeTake<A, P> | undefined;
    let accepted = 0;
    let dropped = 0;
    let evictedForTerminal = 0;
    let terminalOverflow = 0;
    let aborted = false;
    const preparing = new Set<BufferedItem<A, P>>();
    const waitingPreparation = new Set<BufferedItem<A, P>>();
    const prepareConcurrency = normalizedPositiveInt(options.prepareConcurrency ?? 1, 1);
    const pumpPreparation = () => {
      if (!options.prepare || aborted) return;
      for (const buffered of waitingPreparation) {
        if (preparing.size >= prepareConcurrency) break;
        waitingPreparation.delete(buffered);
        preparing.add(buffered);
        // Capture synchronous throws too, and handle rejection before the serial
        // consumer reaches this item. No detached, unbounded callback promises.
        void Promise.resolve()
          .then(async () => {
            if (aborted || buffered.discarded) return;
            try {
              const metadata = await options.prepare!(buffered.item as A);
              buffered.resolvePrepared?.({ metadata });
            } catch (cause) {
              buffered.resolvePrepared?.({ cause });
            }
          })
          .finally(() => {
            preparing.delete(buffered);
            pumpPreparation();
          });
      }
    };
    const prepare = (buffered: BufferedItem<A, P>) => {
      if (!options.prepare) return;
      buffered.prepared = new Promise((resolve) => {
        buffered.resolvePrepared = resolve;
      });
      waitingPreparation.add(buffered);
      pumpPreparation();
    };

    const discard = (buffered: BufferedItem<A, P>) => {
      buffered.discarded = true;
      buffered.item = undefined;
      buffered.resolvePrepared = undefined;
      buffered.prepared = undefined;
      waitingPreparation.delete(buffered);
    };

    const take = Effect.callback<Option.Option<BufferedItem<A, P>>>((resume) => {
      const buffered = buffer.shift();
      if (buffered !== undefined) {
        queuedBytes = Math.max(0, queuedBytes - buffered.bytes);
        resume(Effect.succeed(Option.some(buffered)));
        return;
      }
      if (!accepting) {
        resume(Effect.succeed(Option.none()));
        return;
      }
      waiter = resume;
      return Effect.sync(() => {
        if (waiter === resume) {
          waiter = undefined;
        }
      });
    });

    const run: Effect.Effect<void, never, R> = Effect.suspend(() =>
      take.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (buffered) =>
              (buffered.prepared
                ? Effect.promise(() => buffered.prepared!).pipe(
                    Effect.flatMap((result) =>
                      "cause" in result
                        ? Effect.die(result.cause)
                        : process(buffered.item!, result.metadata),
                    ),
                  )
                : process(buffered.item!)
              ).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? // An interrupts-only cause carries no E failures, so it is safe to
                      // repropagate from a never-error consumer.
                      Effect.failCause(cause as Cause.Cause<never>)
                    : Effect.logError("bounded callback ingress item failed", {
                        cause: Cause.pretty(cause),
                      }),
                ),
                Effect.andThen(run),
              ),
          }),
        ),
      ),
    );
    const worker = yield* Effect.forkScoped(run);

    const offer = (item: A): BoundedCallbackIngressOfferResult => {
      if (!accepting) {
        return "closed";
      }

      const bytes = Math.max(1, Math.floor(options.sizeOf(item)));
      const terminal = options.isTerminal(item);
      if (bytes > maxBufferedBytes) {
        if (terminal) {
          terminalOverflow += 1;
          return "terminal-overflow";
        }
        dropped += 1;
        return "dropped";
      }
      const buffered: BufferedItem<A, P> = { item, bytes, terminal };
      if (waiter !== undefined) {
        const resume = waiter;
        waiter = undefined;
        accepted += 1;
        prepare(buffered);
        resume(Effect.succeed(Option.some(buffered)));
        return "accepted";
      }

      const fitsByteBudget = () => queuedBytes + bytes <= maxBufferedBytes;
      if (!terminal) {
        if (buffer.length >= normalCapacity || !fitsByteBudget()) {
          dropped += 1;
          return "dropped";
        }
        buffer.push(buffered);
        queuedBytes += bytes;
        accepted += 1;
        prepare(buffered);
        return "accepted";
      }

      let evicted = false;
      while (buffer.length >= capacity || !fitsByteBudget()) {
        const evictIndex = buffer.findIndex((candidate) => !candidate.terminal);
        if (evictIndex < 0) {
          terminalOverflow += 1;
          return "terminal-overflow";
        }
        const [removed] = buffer.splice(evictIndex, 1);
        if (removed) {
          discard(removed);
          queuedBytes = Math.max(0, queuedBytes - removed.bytes);
          dropped += 1;
          evictedForTerminal += 1;
          evicted = true;
        }
      }

      buffer.push(buffered);
      queuedBytes += bytes;
      accepted += 1;
      prepare(buffered);
      return evicted ? "evicted-for-terminal" : "accepted";
    };

    let stopRequested = false;
    const stop = Effect.suspend(() => {
      if (!stopRequested) {
        stopRequested = true;
        accepting = false;
        if (buffer.length === 0 && waiter !== undefined) {
          const resume = waiter;
          waiter = undefined;
          resume(Effect.succeed(Option.none()));
        }
      }
      return Fiber.join(worker).pipe(Effect.asVoid);
    });

    const abort = Effect.suspend(() => {
      accepting = false;
      aborted = true;
      stopRequested = true;
      for (const buffered of buffer) discard(buffered);
      for (const buffered of preparing) discard(buffered);
      waitingPreparation.clear();
      buffer.length = 0;
      queuedBytes = 0;
      return Fiber.interrupt(worker).pipe(Effect.asVoid);
    });

    yield* Effect.addFinalizer(() => abort);

    return {
      offer,
      stop,
      abort,
      status: () => ({
        accepting,
        queued: buffer.length,
        queuedBytes,
        accepted,
        dropped,
        evictedForTerminal,
        terminalOverflow,
      }),
    } satisfies BoundedCallbackIngress<A>;
  });
