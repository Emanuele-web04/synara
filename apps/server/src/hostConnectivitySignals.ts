// FILE: hostConnectivitySignals.ts
// Purpose: Let account reads in the RPC layer nudge host connectivity, which the
//          server program owns, without threading one through the other's layers
//          (the same seam as accountUsageReporterRegistry).
// Layer: server host connectivity
//
// Nothing here authorizes anything. A signal only lets host connectivity run its
// normal check sooner; that check still needs its own fresh account answer.

let remoteAccessGranted: (() => void) | undefined;
let hostAuthorizationNudge: (() => void) | undefined;

/** The server program points this at its live supervisor's `wakeAfterRefusal`. */
export function registerRemoteAccessGrantedWake(wake: (() => void) | undefined): void {
  remoteAccessGranted = wake;
}

/** A billing read reported remote access as granted. Never throws. */
export function noteRemoteAccessGranted(): void {
  try {
    remoteAccessGranted?.();
  } catch {
    // Billing reads must not fail because connectivity is unavailable.
  }
}

/** Running host connectivity registers its authorization check; returns the unregister. */
export function registerHostAuthorizationNudge(nudge: () => void): () => void {
  hostAuthorizationNudge = nudge;
  return () => {
    if (hostAuthorizationNudge === nudge) hostAuthorizationNudge = undefined;
  };
}

/**
 * This app revoked a device: check host authorization now, so the host applies
 * the tombstone and confirms delivery without waiting for an idle poll. Never throws.
 */
export function nudgeHostAuthorization(): void {
  try {
    hostAuthorizationNudge?.();
  } catch {
    // Revocation already succeeded at the account service.
  }
}
