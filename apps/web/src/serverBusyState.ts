import type { ServerRuntimeStatus } from "@synara/contracts";

const HEARTBEAT_MS = 5000;
const RESPONSE_MS = 3000;
const RECENT_STALL_MS = 30_000;
const SLOW_REQUEST_MS = 15_000;
const LONG_REQUEST_MS = 120_000;
const MAX_TRACKED_REQUESTS = 256;

export interface ServerBusySnapshot {
  readonly reason: "unresponsive" | "recent-stall" | null;
  readonly pendingRequests: number;
  readonly slowRequests: number;
  readonly lastStallMs: number | null;
}
const EMPTY: ServerBusySnapshot = {
  reason: null,
  pendingRequests: 0,
  slowRequests: 0,
  lastStallMs: null,
};
let latest = EMPTY;
const listeners = new Set<() => void>();
export const getServerBusySnapshot = () => latest;
export const subscribeServerBusy = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function publishServerBusySnapshot(snapshot: ServerBusySnapshot): void {
  latest = snapshot;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* UI observers cannot fail an RPC. */
    }
  }
}

/** Transport-owned liveness and latency. It never reconnects or retries commands. */
export class ServerBusyController {
  private snapshot = EMPTY;
  private pending = new Map<symbol, { slow: boolean; timer: ReturnType<typeof setTimeout> }>();
  private epoch = 0;
  private heartbeat: ((signal: AbortSignal) => Promise<ServerRuntimeStatus>) | null = null;
  private requestAbort: AbortController | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private recentTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private heartbeatOwner: symbol | null = null;

  constructor(
    private readonly options: {
      isVisible?: () => boolean;
      onChange?: (snapshot: ServerBusySnapshot) => void;
    } = {},
  ) {}
  getSnapshot = () => this.snapshot;
  private isVisible() {
    return (
      this.options.isVisible?.() ??
      (typeof document === "undefined" || document.visibilityState !== "hidden")
    );
  }
  private update(patch: Partial<ServerBusySnapshot>) {
    const next = { ...this.snapshot, ...patch };
    if (
      next.reason === this.snapshot.reason &&
      next.pendingRequests === this.snapshot.pendingRequests &&
      next.slowRequests === this.snapshot.slowRequests &&
      next.lastStallMs === this.snapshot.lastStallMs
    )
      return;
    this.snapshot = next;
    this.options.onChange?.(next);
  }
  trackRequest(method: string, options?: { readonly timeoutMs?: number | null }): () => void {
    if (
      this.disposed ||
      method.includes("subscribe") ||
      method === "server.getRuntimeStatus" ||
      this.pending.size >= MAX_TRACKED_REQUESTS
    )
      return () => {};
    const token = Symbol();
    const timer = setTimeout(
      () => {
        const entry = this.pending.get(token);
        if (!entry) return;
        entry.slow = true;
        this.update({ slowRequests: this.snapshot.slowRequests + 1 });
      },
      options?.timeoutMs === null
        ? LONG_REQUEST_MS
        : options?.timeoutMs !== undefined && options.timeoutMs > 60_000
          ? options.timeoutMs * 0.75
          : SLOW_REQUEST_MS,
    );
    this.pending.set(token, { slow: false, timer });
    this.update({ pendingRequests: this.pending.size });
    return () => {
      const entry = this.pending.get(token);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(token);
      this.update({
        pendingRequests: this.pending.size,
        slowRequests: this.snapshot.slowRequests - Number(entry.slow),
      });
    };
  }
  startHeartbeat(request: (signal: AbortSignal) => Promise<ServerRuntimeStatus>): () => void {
    this.stopHeartbeat();
    if (this.disposed) return () => {};
    this.heartbeat = request;
    const owner = Symbol();
    this.heartbeatOwner = owner;
    this.visibilityChanged();
    return () => {
      if (owner === this.heartbeatOwner) this.stopHeartbeat();
    };
  }
  private clearHeartbeatWork() {
    this.epoch++;
    clearTimeout(this.pollTimer);
    clearTimeout(this.deadlineTimer);
    clearTimeout(this.recentTimer);
    this.requestAbort?.abort();
    this.requestAbort = null;
    this.update({ reason: null, lastStallMs: null });
  }
  stopHeartbeat() {
    this.heartbeatOwner = null;
    this.heartbeat = null;
    this.clearHeartbeatWork();
  }
  visibilityChanged = () => {
    this.clearHeartbeatWork();
    if (this.heartbeat && this.isVisible() && !this.disposed) void this.poll();
  };
  private async poll(): Promise<void> {
    if (!this.heartbeat || this.disposed || !this.isVisible()) return;
    const epoch = this.epoch;
    const started = performance.now();
    const abort = new AbortController();
    this.requestAbort = abort;
    const current = () => epoch === this.epoch && !this.disposed && this.isVisible();
    this.deadlineTimer = setTimeout(() => {
      if (!current()) return;
      if (performance.now() - started > RESPONSE_MS + HEARTBEAT_MS) {
        this.visibilityChanged();
        return;
      }
      const markUnresponsive = () => {
        if (!current() || this.requestAbort !== abort) return;
        this.update({ reason: "unresponsive" });
        abort.abort();
      };
      // A delayed renderer may process timers before an already queued socket
      // response. Give that response one turn before publishing busy.
      if (performance.now() - started > RESPONSE_MS + 500)
        this.deadlineTimer = setTimeout(markUnresponsive, 0);
      else markUnresponsive();
    }, RESPONSE_MS);
    try {
      const status = await this.heartbeat(abort.signal);
      if (!current()) return;
      clearTimeout(this.recentTimer);
      const remaining = status.lastStall ? RECENT_STALL_MS - status.lastStall.ageMs : 0;
      this.update({
        reason: remaining > 0 ? "recent-stall" : null,
        lastStallMs: remaining > 0 ? status.lastStall!.durationMs : null,
      });
      if (remaining > 0)
        this.recentTimer = setTimeout(() => {
          if (current() && this.snapshot.reason === "recent-stall")
            this.update({ reason: null, lastStallMs: null });
        }, remaining);
    } catch {
      if (current() && !abort.signal.aborted) this.update({ reason: null, lastStallMs: null });
      // An explicit error is an answer, not evidence of a blocked loop. Socket
      // recovery stays owned by WsTransport; only the deadline sets busy here.
    } finally {
      if (current()) {
        clearTimeout(this.deadlineTimer);
        this.requestAbort = null;
        this.pollTimer = setTimeout(
          () => void this.poll(),
          Math.max(0, HEARTBEAT_MS - (performance.now() - started)),
        );
      }
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopHeartbeat();
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.update(EMPTY);
  }
}
