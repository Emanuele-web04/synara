// Owns the dedicated browser session's guarded transport independently of tool calls.
// CDP leases remain call-scoped; page requests keep their sockets across worker shutdown.
import { NetworkPolicy } from "betterwright";
import { createGuardProxy } from "betterwright/guard-proxy";
import type { Session } from "electron";

export interface BetterwrightNetworkGuardLease {
  readonly closed: boolean;
  release(): Promise<void>;
}

// Chromium restarts its network service after the main thread was blocked for
// long at startup (about 15 s; the first launch's static snapshot takes longer
// than that on a slow disk). A session call in flight across that restart is
// dropped and its promise never settles, which used to leave the app running
// with no window. Both setup calls are idempotent, so one that goes unanswered
// is issued again; the proxy configuration itself survives the restart. Setup
// normally takes about 65 ms.
export const NETWORK_GUARD_CALL_TIMEOUT_MS = 3_000;
export const NETWORK_GUARD_CALL_ATTEMPTS = 5;

export class BetterwrightNetworkGuard {
  readonly policy = new NetworkPolicy({ allowLoopback: true });
  private readonly proxy = createGuardProxy({
    guardUrl: async (url, details) => this.policy.check(url, details),
    executeId: () => "browser-session",
  });
  private initializing: Promise<void> | undefined;
  private nextTurn = Promise.resolve();
  private disposed = false;

  constructor(private readonly browserSession: Session) {}

  // Configure once before any pages load; draining per tool would abort unrelated XHRs.
  initialize(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Browser network guard is closed."));
    this.initializing ??= (async () => {
      const port = await this.proxy.ensure();
      await this.answered("install the session proxy", () =>
        this.browserSession.setProxy({
          mode: "fixed_servers",
          proxyRules: `socks5://127.0.0.1:${port}`,
          proxyBypassRules: "<-loopback>",
        }),
      );
      await this.answered("close existing connections", () =>
        this.browserSession.closeAllConnections(),
      );
    })();
    return this.initializing;
  }

  // Resolves once the session answered `call`. A rejection propagates at once.
  // An unanswered call is issued again, and after the last attempt setup fails
  // instead of waiting forever, so startup reports it rather than hanging.
  private async answered(action: string, call: () => Promise<void>): Promise<void> {
    for (let attempt = 1; attempt <= NETWORK_GUARD_CALL_ATTEMPTS; attempt += 1) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const wasAnswered = await Promise.race([
          call().then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), NETWORK_GUARD_CALL_TIMEOUT_MS);
          }),
        ]);
        if (wasAnswered) return;
      } finally {
        clearTimeout(timer);
      }
      console.warn(
        `[Synara browser] The browser session did not ${action} within ${NETWORK_GUARD_CALL_TIMEOUT_MS} ms (attempt ${attempt} of ${NETWORK_GUARD_CALL_ATTEMPTS}).`,
      );
    }
    throw new Error(
      `Browser network guard could not ${action}: the browser session never answered.`,
    );
  }

  async attach(signal?: AbortSignal): Promise<BetterwrightNetworkGuardLease> {
    signal?.throwIfAborted();
    if (this.disposed) throw new Error("Browser network guard is closed.");
    const previous = this.nextTurn;
    let finishTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    // A cancelled waiter cannot let later runs overtake the current session owner.
    this.nextTurn = previous.then(() => turn);
    try {
      await waitForTurn(previous, signal);
      signal?.throwIfAborted();
      await this.initialize();
      signal?.throwIfAborted();
      if (this.disposed) throw new Error("Browser network guard is closed.");
      let closed = false;
      const guard = this;
      return {
        get closed() {
          return closed || guard.disposed;
        },
        release: async () => {
          closed = true;
          finishTurn();
        },
      };
    } catch (error) {
      finishTurn();
      throw error;
    }
  }

  // Called only after pages and tool transports close during desktop shutdown.
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.initializing?.catch(() => {});
    await this.proxy.close();
  }
}

async function waitForTurn(turn: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return turn;
  let onAbort!: () => void;
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () => reject(signal.reason ?? new Error("Browser control was interrupted."));
      signal.addEventListener("abort", onAbort, { once: true });
      turn.then(resolve, reject);
      if (signal.aborted) onAbort();
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

const guardsBySession = new WeakMap<Session, BetterwrightNetworkGuard>();

export function getBetterwrightNetworkGuard(browserSession: Session): BetterwrightNetworkGuard {
  let guard = guardsBySession.get(browserSession);
  if (!guard) {
    guard = new BetterwrightNetworkGuard(browserSession);
    guardsBySession.set(browserSession, guard);
  }
  return guard;
}
