// FILE: reachability.ts
// Purpose: How a host's last probe reads in the UI.
// Layer: Web remote-access feature logic.
// Exports: attempt-based reachability labels and display tokens.

import type { TransportKind } from "@synara/shared/transportRace";

/**
 * Reachability as this app renders it (ADR 0010).
 *
 * There is no presence store and no push channel, so every one of these is a
 * statement about the LAST ATTEMPT, never about right now. That is also why
 * `unknown` exists as a real state rather than defaulting to "offline": a host
 * nobody has probed yet has not failed, and telling a user their machine is
 * down because the app has not looked would be a lie the palette can't even
 * express (there is no success/warning token — see the spec's §4 conventions).
 */
export type HostReachability =
  | { readonly state: "unknown" }
  | { readonly state: "probing" }
  | { readonly state: "reachable"; readonly transport: TransportKind; readonly at: number }
  | { readonly state: "unreachable"; readonly at: number }
  /** Probed, heard nothing — a network problem, not evidence the host is off. */
  | { readonly state: "no-answer"; readonly at: number }
  /** Nothing to probe: no endpoints published and no relay configured. */
  | { readonly state: "no-route"; readonly at: number };

export const TRANSPORT_LABELS: Record<TransportKind, string> = {
  cloudflare: "Cloudflare",
  loopback: "this machine",
  lan: "local network",
  tailscale: "Tailscale",
  ssh: "SSH",
  relay: "relay",
};

/**
 * The one line the host row shows for status.
 *
 * Deliberately a sentence rather than a dot: the palette is warm-neutral and
 * low-chroma with no success token, and a green light would claim live
 * presence the architecture does not have. Reachability reads as text, dimmed
 * when it is not a confirmed connection (see {@link reachabilityToneClassName}).
 */
export function reachabilityLabel(reachability: HostReachability): string {
  switch (reachability.state) {
    case "unknown":
      return "Not checked yet";
    case "probing":
      return "Checking…";
    case "reachable":
      return `Reachable over ${TRANSPORT_LABELS[reachability.transport]}`;
    case "unreachable":
      return "Did not answer";
    case "no-answer":
      return "No response — check your network";
    case "no-route":
      return "No known address";
  }
}

/**
 * Emphasis, not color. A confirmed path gets full-strength foreground text;
 * everything else is muted, which is the only "status" signal this palette
 * offers and the only one ADR 0010 entitles us to.
 */
export function reachabilityToneClassName(reachability: HostReachability): string {
  return reachability.state === "reachable" ? "text-foreground" : "text-muted-foreground";
}
