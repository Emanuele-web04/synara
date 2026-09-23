/**
 * The bits of D-Bus mechanics every desktop path needs and none of them should
 * own a copy of.
 *
 * Three things live here. Unwrapping a variant, because a value read off the
 * bus arrives wrapped or not depending on which transport and which library
 * carried it, and every parser above this has to see through that the same
 * way. The timeout race, because a D-Bus call that is never answered is
 * otherwise a promise that never settles and a session that never recovers.
 * And the connection watch, because a bus that dies under a call is the same
 * unanswered call, and waiting out its timeout to learn that is needless.
 *
 * The timeout deliberately does not decide what a timeout *is*. Each caller's
 * error type carries its own recovery: a plugin timeout is connection-level and
 * drives a reconnect, while a probe's timeout is a plain answer of "not here".
 * Those are not cosmetic differences, so the mechanism is shared and the
 * meaning is not.
 *
 * @module computer/dbusPlumbing
 */

/** Unwraps a `dbus-next` variant, however many layers deep it was wrapped. */
export function unwrapDbusValue(value: unknown): unknown {
  if (isDbusVariant(value)) {
    return unwrapDbusValue((value as { readonly value: unknown }).value);
  }
  return value;
}

function isDbusVariant(
  value: unknown,
): value is { readonly signature: string; readonly value: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly signature?: unknown }).signature === "string" &&
    "value" in value
  );
}

export interface DbusTimeoutHandlers {
  /** The rejection for a call that never answered. Built lazily, on expiry. */
  readonly onTimeout: () => unknown;
  /**
   * Translates a failure the bus did report. Omitted, the original travels
   * untouched — which is what a caller that already speaks in bus errors wants.
   */
  readonly onRejected?: ((error: unknown) => unknown) | undefined;
}

/**
 * `promise`, but rejecting with `handlers.onTimeout()` if it has not settled
 * within `timeoutMs`.
 *
 * The timer is unref'd: a pending D-Bus call must not be the reason the process
 * stays alive, and it is cleared either way so a settled call leaves nothing
 * behind.
 */
export function withDbusTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  handlers: DbusTimeoutHandlers,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(handlers.onTimeout());
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(handlers.onRejected ? handlers.onRejected(error) : error);
      },
    );
  });
}

/**
 * The bus connection itself ended under a call: the peer did not answer
 * because nothing carries the answer any more. `connectionLevel` is what the
 * backends read to drop the connection and reconnect instead of blaming the
 * call.
 */
export class DbusConnectionClosedError extends Error {
  readonly connectionLevel = true;

  constructor(cause?: unknown) {
    const detail =
      cause === undefined ? "" : `: ${cause instanceof Error ? cause.message : String(cause)}`;
    super(`The D-Bus connection closed${detail}.`, cause === undefined ? undefined : { cause });
    this.name = "DbusConnectionClosedError";
  }
}

/**
 * Liveness of one `dbus-next` connection, which the library does not report.
 *
 * dbus-next 0.10.2 never emits `disconnect`, and a socket that reaches EOF
 * fails nothing: a call already waiting keeps its reply handler forever, and a
 * call made afterwards is swallowed with an `error` event instead of a
 * rejection. So a dead bus looked alive until each call's own timeout (up to a
 * minute for a large capture). The truth is on the transport underneath —
 * `_connection` emits `end` on EOF and its stream `close` once the socket is
 * gone — and this watch turns it into one closure: `onClosed` fires once, and
 * every call running through `guard` rejects at once, including calls started
 * after the drop.
 */
export interface DbusConnectionWatch {
  readonly isClosed: () => boolean;
  /**
   * `start()`'s result, rejected the moment the connection ends if it has not
   * settled by then. On an already-ended connection `start` is not called.
   */
  readonly guard: <T>(start: () => T | PromiseLike<T>) => Promise<T>;
  /** Fires at most once, when the connection drops — never after `release`. */
  readonly onClosed: (listener: (error: DbusConnectionClosedError) => void) => () => void;
  /**
   * This side is ending the connection on purpose: calls still waiting, and
   * any made later, reject with `reason()` rather than a drop, and no
   * `onClosed` listener fires. A no-op once the connection has ended.
   */
  readonly release: (reason: () => Error) => void;
}

/** Starts watching `bus` (a `dbus-next` MessageBus). */
export function watchDbusConnection(bus: object): DbusConnectionWatch {
  let rejection: (() => Error) | undefined;
  const waiting = new Set<(error: Error) => void>();
  const listeners = new Set<(error: DbusConnectionClosedError) => void>();

  const end = (reason: () => Error, dropped: DbusConnectionClosedError | undefined) => {
    if (rejection) return;
    rejection = reason;
    if (dropped) {
      for (const listener of listeners) {
        try {
          listener(dropped);
        } catch {
          // The emitter calling this is a socket's: a throw here would
          // surface as an uncaught exception from inside the stream.
        }
      }
      listeners.clear();
    }
    const pending = [...waiting];
    waiting.clear();
    for (const reject of pending) reject(reason());
  };
  const drop = (cause?: unknown) => {
    const error = new DbusConnectionClosedError(cause);
    end(() => error, error);
  };

  const listen = (target: unknown, event: string, handler: (...args: unknown[]) => void) => {
    if (isEmitter(target)) target.on(event, handler);
  };
  const onError = (error: unknown, detail?: unknown) => {
    if (!isMessageLevelBusError(error, detail)) drop(error);
  };
  const onEnd = () => drop();
  listen(bus, "error", onError);
  listen(bus, "disconnect", onEnd);
  const connection = (bus as { readonly _connection?: unknown })._connection;
  listen(connection, "end", onEnd);
  listen((connection as { readonly stream?: unknown } | undefined)?.stream, "close", onEnd);

  return {
    isClosed: () => rejection !== undefined,
    guard: <T>(start: () => T | PromiseLike<T>) => {
      if (rejection) return Promise.reject(rejection());
      return new Promise<T>((resolve, reject) => {
        waiting.add(reject);
        const settle = () => waiting.delete(reject);
        let result: T | PromiseLike<T>;
        try {
          result = start();
        } catch (error) {
          settle();
          reject(error);
          return;
        }
        Promise.resolve(result).then(
          (value) => {
            settle();
            resolve(value);
          },
          (error: unknown) => {
            settle();
            reject(error);
          },
        );
      });
    },
    onClosed: (listener) => {
      if (rejection) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    release: (reason) => end(reason, undefined),
  };
}

/**
 * An `error` the bus emits about one message rather than the connection.
 *
 * dbus-next funnels everything through the bus's `error` event, and two kinds
 * leave the connection working: a message it failed to decode (emitted with a
 * description as a second argument, and the stream reads on) and a D-Bus error
 * reply to its own AddMatch/RemoveMatch bookkeeping (a `DBusError`, which
 * carries the error name as `type`). Taking either for a drop would tear down
 * a healthy connection and every call on it. Anything else — a socket error,
 * a failed handshake, a write to a closed stream — ends the connection, and
 * the transport's own `end`/`close` may never follow a handshake failure, so
 * those still drop here.
 */
function isMessageLevelBusError(error: unknown, detail: unknown): boolean {
  if (detail !== undefined) return true;
  return (
    error instanceof Error &&
    error.name === "DBusError" &&
    typeof (error as { readonly type?: unknown }).type === "string"
  );
}

interface Emitter {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
}

function isEmitter(value: unknown): value is Emitter {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { on?: unknown }).on === "function"
  );
}
