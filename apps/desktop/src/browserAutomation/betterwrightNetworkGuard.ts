import { lookup } from "node:dns/promises";
import type { OnBeforeRequestListenerDetails, Session, WebContents } from "electron";
import { NetworkPolicy, type NetworkDecision } from "betterwright";

function deny(reason: string): NetworkDecision {
  return { allowed: false, reason };
}

async function checkRequest(policy: NetworkPolicy, url: string): Promise<NetworkDecision> {
  const decision = policy.check(url);
  if (!decision.allowed) return decision;

  const parsed = new URL(url);
  if (!parsed.hostname || parsed.protocol === "data:" || parsed.protocol === "blob:") {
    return decision;
  }

  const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
  for (const address of addresses) {
    const resolved = policy.checkHost(address.address, parsed.port ? Number(parsed.port) : null);
    if (!resolved.allowed) {
      return deny(`resolved address denied: ${resolved.reason ?? "network policy"}`);
    }
  }
  return decision;
}

export interface BetterwrightNetworkGuardLease {
  release(): void;
}

export class BetterwrightNetworkGuard {
  private readonly policiesByWebContentsId = new Map<number, NetworkPolicy>();
  private listening = false;

  constructor(private readonly browserSession: Session) {}

  attach(contents: WebContents, policy: NetworkPolicy): BetterwrightNetworkGuardLease {
    this.ensureListener();
    this.policiesByWebContentsId.set(contents.id, policy);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.policiesByWebContentsId.delete(contents.id);
      },
    };
  }

  private ensureListener(): void {
    if (this.listening) return;
    this.listening = true;
    this.browserSession.webRequest.onBeforeRequest(
      { urls: ["<all_urls>"] },
      (
        details: OnBeforeRequestListenerDetails,
        callback: (response: { cancel?: boolean }) => void,
      ) => {
        if (
          typeof details.webContentsId !== "number" ||
          !this.policiesByWebContentsId.has(details.webContentsId)
        ) {
          callback({});
          return;
        }
        const policy = this.policiesByWebContentsId.get(details.webContentsId);
        if (!policy) {
          callback({});
          return;
        }
        void checkRequest(policy, details.url).then(
          (decision) => callback({ cancel: !decision.allowed }),
          () => callback({ cancel: true }),
        );
      },
    );
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
