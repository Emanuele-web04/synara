/** Bounds callbacks before the SDK's non-awaiting receive loop can retain a promise per event. */
export function makeAcpNotificationDispatcher<A>(options: {
  readonly maxCount: number;
  readonly maxBytes: number;
  readonly deliver: (value: A, signal: AbortSignal) => Promise<void>;
  readonly onOverflow: (error: Error) => void;
}) {
  const abortController = new AbortController();
  let tail = Promise.resolve();
  let count = 0;
  let bytes = 0;
  let closedError: Error | undefined;

  const close = (error = new Error("ACP notification dispatcher closed")) => {
    closedError ??= error;
    abortController.abort(closedError);
  };

  const dispatch = (value: A): Promise<void> => {
    if (closedError) return Promise.reject(closedError);
    const size = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (count >= options.maxCount || size > options.maxBytes - bytes) {
      const error = new Error("ACP notification backlog exceeded its memory budget");
      close(error);
      options.onOverflow(error);
      return Promise.reject(error);
    }
    count += 1;
    bytes += size;
    const delivery = tail
      .then(() => {
        if (closedError) throw closedError;
        return options.deliver(value, abortController.signal);
      })
      .finally(() => {
        count -= 1;
        bytes -= size;
      });
    tail = delivery.catch(() => undefined);
    return delivery;
  };

  const drain = async () => {
    let observed: Promise<void>;
    do {
      observed = tail;
      await observed;
      if (closedError) throw closedError;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } while (observed !== tail);
  };

  return {
    dispatch,
    drain,
    close,
    status: () => ({ count, bytes, closed: closedError !== undefined }),
  };
}
