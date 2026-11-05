// FILE: reachability.ts
// Purpose: How a host's last probe reads in the UI.
// Layer: Web remote-access feature logic.
// Exports: attempt-based reachability labels and display tokens.

import { t as translate } from "~/i18n";
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

/** Display keys keep transport identifiers and source labels unchanged. */
export const TRANSPORT_LABEL_KEYS: Record<TransportKind, string> = {
  cloudflare: "computer:remote_host_transport_cloudflare",
  loopback: "computer:remote_host_transport_loopback",
  lan: "computer:remote_host_transport_lan",
  tailscale: "Tailscale",
  ssh: "SSH",
  relay: "computer:remote_host_transport_relay",
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
      return translate("computer:remote_host_not_checked");
    case "probing":
      return translate("settings:checking");
    case "reachable":
      return translate("computer:remote_host_reachable_over", {
        transport: translate(TRANSPORT_LABEL_KEYS[reachability.transport]),
      });
    case "unreachable":
      return translate("computer:remote_host_did_not_answer");
    case "no-answer":
      return translate("computer:remote_host_no_response");
    case "no-route":
      return translate("computer:remote_host_no_address");
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
