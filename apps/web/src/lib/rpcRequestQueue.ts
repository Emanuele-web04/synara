// FILE: rpcRequestQueue.ts
// Purpose: Client-side FIFO slots per unary RPC class, mirroring server admission.
// Layer: Web transport helper
// Why: The server rejects a request when its class budget is in use, and the
//      transport used to re-send every 250 ms until a slot freed, so each waiting
//      caller cost about four rejected round trips a second. Waiting here sends
//      nothing, and slots are granted in arrival order.
//      Written from scratch: @tanstack/pacer's AsyncQueuer has no acquire/release
//      or per-waiter abort, and Effect's Semaphore does not grant in FIFO order.

export class RpcRequestQueueWaitExpiredError extends Error {
  constructor(readonly lane: string) {
    super(`No ${lane} request slot became free in time.`);
    this.name = "RpcRequestQueueWaitExpiredError";
  }
}

interface Waiter {
  readonly grant: (release: () => void) => void;
  readonly fail: (reason: unknown) => void;
}

interface Lane {
  readonly limit: number;
  active: number;
  readonly waiters: Waiter[];
}

export class RpcRequestQueue<K extends string> {
  private readonly lanes = new Map<K, Lane>();
  private closedReason: { readonly reason: unknown } | null = null;

  constructor(limits: Readonly<Record<K, number>>) {
    for (const key of Object.keys(limits) as K[]) {
      this.lanes.set(key, { limit: Math.max(1, limits[key]), active: 0, waiters: [] });
    }
  }

  /**
   * Resolves with a release function once a slot in `key` is free. Rejects with the
   * signal's reason when aborted while waiting, with RpcRequestQueueWaitExpiredError
   * after `maxWaitMs`, or with the close reason once the queue is closed. While
   * `canExpire` returns false the wait limit starts over instead of expiring.
   */
  acquire(
    key: K,
    options?: {
      readonly signal?: AbortSignal | undefined;
      readonly maxWaitMs?: number | undefined;
      readonly canExpire?: (() => boolean) | undefined;
    },
  ): Promise<() => void> {
    const lane = this.lanes.get(key);
    if (!lane) return Promise.reject(new Error(`Unknown request lane: ${key}`));
    if (this.closedReason) return Promise.reject(this.closedReason.reason);
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (lane.active < lane.limit && lane.waiters.length === 0) {
      lane.active += 1;
      return Promise.resolve(this.releaseFor(lane));
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const leave = (reason: unknown) => {
        const index = lane.waiters.indexOf(waiter);
        if (index < 0) return;
        lane.waiters.splice(index, 1);
        cleanup();
        reject(reason);
      };
      const onAbort = () => leave(signal?.reason);
      const waiter: Waiter = {
        grant: (release) => {
          cleanup();
          resolve(release);
        },
        fail: (reason) => {
          cleanup();
          reject(reason);
        },
      };
      lane.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      const maxWaitMs = options?.maxWaitMs;
      if (maxWaitMs !== undefined) {
        const armExpiry = () => {
          timer = setTimeout(
            () => {
              if (options?.canExpire?.() === false) armExpiry();
              else leave(new RpcRequestQueueWaitExpiredError(key));
            },
            Math.max(0, maxWaitMs),
          );
        };
        armExpiry();
      }
    });
  }

  /** Rejects every waiter and every later acquire; holders still release normally. */
  close(reason: unknown): void {
    if (this.closedReason) return;
    this.closedReason = { reason };
    for (const lane of this.lanes.values()) {
      for (const waiter of lane.waiters.splice(0)) waiter.fail(reason);
    }
  }

  private releaseFor(lane: Lane): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lane.active -= 1;
      // Count the slot before resolving so no caller arriving meanwhile can take it.
      while (lane.active < lane.limit && lane.waiters.length > 0) {
        const next = lane.waiters.shift()!;
        lane.active += 1;
        next.grant(this.releaseFor(lane));
      }
    };
  }
}
