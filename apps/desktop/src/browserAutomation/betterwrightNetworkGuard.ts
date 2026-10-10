import type { Session } from "electron";

export interface BetterwrightNetworkGuardLease {
  readonly closed: boolean;
  /** The caller must drain its old transports before replacing the worker proxy. */
  replace(proxyUrl: string, signal?: AbortSignal): Promise<void>;
  release(): Promise<void>;
}

interface ProxyOwnership {
  failed: boolean;
  restoring?: Promise<void> | undefined;
}

export class BetterwrightNetworkGuard {
  private owner: ProxyOwnership | undefined;
  private nextTurn = Promise.resolve();

  constructor(private readonly browserSession: Session) {}

  async attach(proxyUrl: string, signal?: AbortSignal): Promise<BetterwrightNetworkGuardLease> {
    signal?.throwIfAborted();
    const previous = this.nextTurn;
    let finishTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    // A cancelled waiter may finish its turn early, but cannot let later
    // waiters overtake the current owner. The session stays FIFO.
    this.nextTurn = previous.then(() => turn);
    try {
      await waitForTurn(previous, signal);
      signal?.throwIfAborted();
      const lease = await this.acquire(proxyUrl, signal);
      return {
        get closed() {
          return lease.closed;
        },
        replace: (proxyUrl, signal) => lease.replace(proxyUrl, signal),
        release: () => {
          const restoring = lease.release();
          // A failed restore keeps ownership reserved. The next turn must
          // recover it before changing proxies or vending a transport.
          void restoring.then(finishTurn, finishTurn);
          return restoring;
        },
      };
    } catch (error) {
      finishTurn();
      throw error;
    }
  }

  private async acquire(
    proxyUrl: string,
    signal?: AbortSignal,
  ): Promise<BetterwrightNetworkGuardLease> {
    if (this.owner?.failed) {
      // A failed setup has no lease to release. Recover the session before
      // admitting another run; failed recovery must keep ownership reserved.
      await this.restore(this.owner);
    }
    signal?.throwIfAborted();
    if (this.owner !== undefined) {
      throw new Error("Browser session is already leased by another automation run.");
    }
    const owner: ProxyOwnership = { failed: false };
    this.owner = owner;
    await this.install(owner, proxyUrl, signal);
    const guard = this;
    let changing = Promise.resolve();
    let releasing: Promise<void> | undefined;
    const closed = () =>
      guard.owner !== owner ||
      owner.failed ||
      owner.restoring !== undefined ||
      releasing !== undefined;
    return {
      get closed() {
        return closed();
      },
      replace: (proxyUrl, signal) => {
        if (closed()) return Promise.reject(new Error("Browser session lease is closed."));
        const replacing = changing.then(() => {
          if (guard.owner !== owner || owner.failed)
            throw new Error("Browser session lease is closed.");
          signal?.throwIfAborted();
          return this.install(owner, proxyUrl, signal);
        });
        changing = replacing.catch(() => {});
        return replacing;
      },
      release: () => {
        releasing ??= changing
          .then(() => this.restore(owner))
          .finally(() => {
            releasing = undefined;
          });
        return releasing;
      },
    };
  }

  private async install(
    owner: ProxyOwnership,
    proxyUrl: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.browserSession.setProxy({
        mode: "fixed_servers",
        proxyRules: proxyUrl,
        proxyBypassRules: "<-loopback>",
      });
      await this.browserSession.closeAllConnections();
      signal?.throwIfAborted();
    } catch (error) {
      // Even a rejected setProxy may have partially changed Chromium state.
      // Do not expose a free session until both rollback and draining succeed.
      try {
        await this.restore(owner);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Browser proxy setup and recovery failed.",
        );
      }
      throw error;
    }
  }

  private restore(owner: ProxyOwnership): Promise<void> {
    // Identity, rather than the URL, makes stale releases harmless even when
    // a later worker reuses the same proxy port.
    if (this.owner !== owner) return Promise.resolve();
    owner.restoring ??= (async () => {
      try {
        // Synara's dedicated browser session otherwise uses the system proxy;
        // all temporary proxy configuration is owned by this guard.
        await this.browserSession.setProxy({ mode: "system" });
        await this.browserSession.closeAllConnections();
        this.owner = undefined;
      } catch (error) {
        owner.failed = true;
        throw error;
      } finally {
        owner.restoring = undefined;
      }
    })();
    return owner.restoring;
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
