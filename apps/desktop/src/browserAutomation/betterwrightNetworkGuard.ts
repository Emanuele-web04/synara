import type { ProxyConfig, Session } from "electron";

export interface BetterwrightNetworkGuardLease {
  release(): Promise<void>;
}

export class BetterwrightNetworkGuard {
  private activeProxy: string | undefined;
  private releasePromise: Promise<void> | undefined;

  constructor(private readonly browserSession: Session) {}

  async attach(proxyUrl: string): Promise<BetterwrightNetworkGuardLease> {
    if (this.activeProxy !== undefined) {
      throw new Error("Browser session is already leased by another automation run.");
    }
    this.activeProxy = proxyUrl;
    try {
      await this.setProxy({
        proxyRules: proxyUrl,
        proxyBypassRules: "<-loopback>",
      });
      await this.browserSession.closeAllConnections();
    } catch (error) {
      this.activeProxy = undefined;
      throw error;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        this.releasePromise ??= this.releaseProxy(proxyUrl);
        await this.releasePromise;
      },
    };
  }

  private async setProxy(config: ProxyConfig): Promise<void> {
    await this.browserSession.setProxy(config);
  }

  private async releaseProxy(proxyUrl: string): Promise<void> {
    if (this.activeProxy !== proxyUrl) return;
    try {
      await this.setProxy({ mode: "system" });
      await this.browserSession.closeAllConnections();
    } finally {
      this.activeProxy = undefined;
      this.releasePromise = undefined;
    }
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
