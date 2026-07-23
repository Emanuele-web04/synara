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
  readonly status: () => BoundedCallbackIngressStatus;
}

export interface BoundedCallbackIngressOptions<A> {
  readonly capacity: number;
  readonly maxBufferedBytes: number;
  readonly terminalReserve: number;
  readonly isTerminal: (item: A) => boolean;
  readonly sizeOf: (item: A) => number;
}

type BufferedItem<A> = {
  readonly item: A;
  readonly bytes: number;
  readonly terminal: boolean;
};

type ResumeTake<A> = (effect: Effect.Effect<Option.Option<BufferedItem<A>>>) => void;

function normalizedPositiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

export const makeBoundedCallbackIngress = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
  options: BoundedCallbackIngressOptions<A>,
): Effect.Effect<BoundedCallbackIngress<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const capacity = normalizedPositiveInt(options.capacity, 1);
    const maxBufferedBytes = normalizedPositiveInt(options.maxBufferedBytes, 1);
    const terminalReserve = Math.min(capacity, Math.max(1, Math.floor(options.terminalReserve)));
    const normalCapacity = Math.max(0, capacity - terminalReserve);
    const buffer: Array<BufferedItem<A>> = [];
    let queuedBytes = 0;
    let accepting = true;
    let waiter: ResumeTake<A> | undefined;
    let accepted = 0;
    let dropped = 0;
    let evictedForTerminal = 0;
    let terminalOverflow = 0;

    const take = Effect.callback<Option.Option<BufferedItem<A>>>((resume) => {
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
              process(buffered.item).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
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
      const buffered = { item, bytes, terminal } satisfies BufferedItem<A>;
      if (waiter !== undefined) {
        const resume = waiter;
        waiter = undefined;
        accepted += 1;
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
          queuedBytes = Math.max(0, queuedBytes - removed.bytes);
          dropped += 1;
          evictedForTerminal += 1;
          evicted = true;
        }
      }

      buffer.push(buffered);
      queuedBytes += bytes;
      accepted += 1;
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

    yield* Effect.addFinalizer(() => stop);

    return {
      offer,
      stop,
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
