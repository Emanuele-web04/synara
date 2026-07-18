// FILE: RemoteAccessSettingsPanel.logic.ts
// Purpose: Pure display derivations for desktop Remote Access settings.
// Layer: Settings feature logic

import type { DesktopRemoteAccessStatus } from "@synara/contracts";

export type RemoteAccessHealth = {
  label: string;
  variant: "secondary" | "success" | "warning" | "error";
  detail: string;
};

export function formatPairingCode(credential: string): string {
  return credential.replace(/\s+/g, "").toUpperCase().match(/.{1,4}/g)?.join(" ") ?? credential;
}

export function formatPairingCountdown(expiresAt: string, now: number): string {
  const remainingSeconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1_000));
  if (remainingSeconds === 0) return "Expired";
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function canPairRemoteAccessDevice(status: DesktopRemoteAccessStatus): boolean {
  const diagnostics = status.tailscale;
  return Boolean(
    status.settings.enabled &&
      status.backend.running &&
      status.backend.port === status.settings.port &&
      status.settings.trustedOrigin &&
      !status.configurationIssue &&
      diagnostics &&
      diagnostics.connectionState === "connected" &&
      diagnostics.serveState === "matching" &&
      !diagnostics.funnelEnabled &&
      diagnostics.discoveredOrigin === status.settings.trustedOrigin &&
      diagnostics.expectedProxyTarget === `http://127.0.0.1:${status.settings.port}`,
  );
}

export function deriveRemoteAccessHealth(
  status: DesktopRemoteAccessStatus,
): RemoteAccessHealth {
  if (!status.settings.enabled) {
    return {
      label: "Off",
      variant: "secondary",
      detail: "Only the local desktop client can connect.",
    };
  }
  if (status.tailscale?.funnelEnabled) {
    return {
      label: "Action required",
      variant: "error",
      detail: "Tailscale Funnel is enabled. Remove public exposure before pairing a phone.",
    };
  }
  if (!status.backend.running) {
    return {
      label: "Starting",
      variant: "warning",
      detail: status.configurationIssue ?? "The Companion backend is not running yet.",
    };
  }
  if (status.configurationIssue) {
    return {
      label: "Setup needed",
      variant: "warning",
      detail: status.configurationIssue,
    };
  }
  if (!status.settings.trustedOrigin || status.tailscale?.serveState !== "matching") {
    return {
      label: "Setup needed",
      variant: "warning",
      detail:
        status.configurationIssue ??
        status.tailscale?.issue ??
        "Verify the exact Tailnet HTTPS origin and Tailscale Serve route.",
    };
  }
  return {
    label: "Ready",
    variant: "success",
    detail: "Reachable privately from devices signed in to the same Tailnet.",
  };
}
