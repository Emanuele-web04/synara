// FILE: remoteAccess.ts
// Purpose: The owner `remoteAccess` RPC as the Connections settings use it — the
//          call helper plus the pure labels and filters its rows render.
// Layer: Web remote-access feature logic
// Exports: callRemoteAccess, RemoteHostState, RemotePairingCode, remoteDeviceKind,
//          trustedDeviceActivityLabel, pendingApprovals, activeTrustedDevices,
//          fingerprintGroups, countdownLabel, remoteAccessErrorMessage

import type {
  RemoteAccessRequest,
  RemoteAccessResult,
  RemotePairingDevice,
  RemotePairingStatus,
  RemoteTrustedDevice,
} from "@synara/contracts";

import { formatRelativeTime } from "~/lib/relativeTime";
import { readHostsApi } from "./api";

export type RemoteHostState = Extract<RemoteAccessResult, { kind: "host-state" }>;
export type RemotePairingCode = Extract<RemoteAccessResult, { kind: "pairing-code" }>;
export type RemotePairingPreview = Extract<RemoteAccessResult, { kind: "pairing-preview" }>;

export function callRemoteAccess(request: RemoteAccessRequest): Promise<RemoteAccessResult> {
  const access = readHostsApi()?.remoteAccess;
  return access
    ? access(request)
    : Promise.reject(new Error("Update the local controller to manage device pairing."));
}

export function remoteAccessErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export type RemoteDeviceKind = "phone" | "tablet" | "computer";

/** Device labels come from the device itself ("iOS 27.0.1 iPhone", "Ada's MacBook"). */
export function remoteDeviceKind(label: string): RemoteDeviceKind {
  if (/\bipad/i.test(label)) return "tablet";
  if (/\b(iphone|ios|android|phone)\b/i.test(label)) return "phone";
  return "computer";
}

/**
 * Secondary text for a trusted device. `lastConnectedAt` is optional on older
 * hosts: absent falls back to when it was added, null means it never connected.
 */
export function trustedDeviceActivityLabel(device: RemoteTrustedDevice): string {
  if (device.lastConnectedAt === undefined) return `Added ${agoLabel(device.approvedAt)}`;
  if (device.lastConnectedAt === null) return "Never connected";
  return `Last connected ${agoLabel(device.lastConnectedAt)}`;
}

function agoLabel(iso: string): string {
  const relative = formatRelativeTime(iso);
  return relative === "now" ? "just now" : `${relative} ago`;
}

export function activeTrustedDevices(
  state: RemoteHostState | null,
): readonly RemoteTrustedDevice[] {
  return state?.devices.filter((device) => !device.revokedAt) ?? [];
}

/** Requests from devices that still need a manual owner approval (no account grant). */
export type PendingApproval = RemotePairingStatus & { readonly pendingDevice: RemotePairingDevice };

export function pendingApprovals(
  state: RemoteHostState | null,
  now: number,
): readonly PendingApproval[] {
  return (
    state?.invitations.filter(
      (entry): entry is PendingApproval =>
        !entry.revoked &&
        !entry.approved &&
        entry.pendingDevice !== null &&
        Date.parse(entry.expiresAt) > now,
    ) ?? []
  );
}

/** A root fingerprint split into eight-character groups for side-by-side comparison. */
export function fingerprintGroups(
  value: string,
): readonly { readonly offset: number; readonly text: string }[] {
  const groups: { offset: number; text: string }[] = [];
  for (let offset = 0; offset < value.length; offset += 8)
    groups.push({ offset, text: value.slice(offset, offset + 8) });
  return groups;
}

export function countdownLabel(expiresAt: string, now: number): string | null {
  const remaining = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1_000));
  if (!remaining) return null;
  return `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
}
