// Owns the dedicated browser session's guarded transport independently of tool calls.
// CDP leases remain call-scoped; page requests keep their sockets across worker shutdown.
import { NetworkPolicy } from "betterwright";
import { createGuardProxy } from "betterwright/guard-proxy";
import type { Session } from "electron";

export interface BetterwrightNetworkGuardLease {
  readonly closed: boolean;
  release(): Promise<void>;
}

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
      await this.browserSession.setProxy({
        mode: "fixed_servers",
        proxyRules: `socks5://127.0.0.1:${port}`,
        proxyBypassRules: "<-loopback>",
      });
      await this.browserSession.closeAllConnections();
    })();
    return this.initializing;
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
