// FILE: ConnectionsRows.tsx
// Purpose: The row shapes the Connections pane lists — devices trusted by this
//          computer, computers this one can control, and the account's devices
//          and sessions shown under Advanced.
// Layer: Settings UI components
// Exports: RemoteDeviceIcon, RootFingerprint, TrustedDeviceRow, HostRow, HostRowConnection,
//          DeviceRow, SessionRow

import type {
  AccountDevice,
  AccountHost,
  HostConnection,
  HostSession,
  RemoteTrustedDevice,
} from "@synara/contracts";

import { canManageHost, hostPlatformLabel } from "~/lib/hosts/api";
import {
  reachabilityLabel,
  reachabilityToneClassName,
  TRANSPORT_LABELS,
  type HostReachability,
} from "~/lib/hosts/reachability";
import {
  fingerprintGroups,
  remoteDeviceKind,
  trustedDeviceActivityLabel,
} from "~/lib/hosts/remoteAccess";
import { formatRelativeTime } from "~/lib/relativeTime";
import {
  DeviceComputerIcon,
  DeviceMobileIcon,
  DeviceTabletIcon,
  EllipsisIcon,
  ServerIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Button } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SettingsListRow } from "./SettingsPanelPrimitives";

const ICON_CLASS_NAME = "size-5";

export function RemoteDeviceIcon({ label }: { label: string }) {
  const kind = remoteDeviceKind(label);
  if (kind === "phone") return <DeviceMobileIcon className={ICON_CLASS_NAME} aria-hidden />;
  if (kind === "tablet") return <DeviceTabletIcon className={ICON_CLASS_NAME} aria-hidden />;
  return <DeviceComputerIcon className={ICON_CLASS_NAME} aria-hidden />;
}

/** A root fingerprint in four columns of eight characters, for comparing across screens. */
export function RootFingerprint({ value, className }: { value: string; className?: string }) {
  return (
    <p className={cn("grid grid-cols-4 gap-x-2 gap-y-1 font-mono text-ui-xs", className)}>
      {fingerprintGroups(value).map((group) => (
        <span key={group.offset}>{group.text}</span>
      ))}
    </p>
  );
}

/** A device this computer trusts to control it. */
export function TrustedDeviceRow({
  device,
  busy,
  onRevoke,
}: {
  device: RemoteTrustedDevice;
  busy: boolean;
  onRevoke: () => void;
}) {
  return (
    <SettingsListRow
      leading={<RemoteDeviceIcon label={device.label} />}
      title={device.label}
      description={trustedDeviceActivityLabel(device)}
      actions={
        <Button size="xs" shape="capsule" variant="subtle" disabled={busy} onClick={onRevoke}>
          Revoke access
        </Button>
      }
    />
  );
}

/** Where this window stands with respect to one host row. */
export type HostRowConnection =
  | { readonly kind: "disconnected"; readonly busy: boolean }
  | {
      readonly kind: "connected";
      readonly transport: HostConnection["transport"];
      /** This window is currently working on that host. */
      readonly active: boolean;
      readonly busy: boolean;
    };

function hostStatusLabel(
  host: AccountHost,
  connection: HostRowConnection,
  reachability: HostReachability,
): string | null {
  if (connection.kind === "connected")
    return `${connection.active ? "Working on it" : "Connected"} over ${TRANSPORT_LABELS[connection.transport]}`;
  if (!host.linked) return "Not linked yet";
  if (reachability.state === "unknown") return null;
  return reachabilityLabel(reachability);
}

/** A computer this one can control, with its connect action and an overflow menu. */
export function HostRow({
  host,
  reachability,
  busy,
  connection: connectionProp,
  onProbe,
  onToggleDiscoverable,
  onConnect,
  onDisconnect,
  onActivate,
  onDeactivate,
  onForget,
}: {
  host: AccountHost;
  reachability: HostReachability;
  busy: boolean;
  connection?: HostRowConnection;
  onProbe?: () => void;
  onToggleDiscoverable: (discoverable: boolean) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onActivate?: () => void;
  onDeactivate?: () => void;
  onForget?: () => void;
}) {
  const connection = connectionProp ?? { kind: "disconnected", busy: false };
  const owned = canManageHost(host);
  const status = hostStatusLabel(host, connection, reachability);
  const details = [
    hostPlatformLabel(host.platform),
    ...(owned ? [] : ["Shared by your workspace"]),
  ].join(" · ");
  return (
    <SettingsListRow
      leading={
        host.platform === "linux" ? (
          <ServerIcon className={ICON_CLASS_NAME} aria-hidden />
        ) : (
          <DeviceComputerIcon className={ICON_CLASS_NAME} aria-hidden />
        )
      }
      title={host.name}
      description={
        <span>
          {details}
          {status ? (
            <>
              {" · "}
              <span
                className={cn(
                  connection.kind === "disconnected" && reachabilityToneClassName(reachability),
                )}
              >
                {status}
              </span>
            </>
          ) : null}
        </span>
      }
      actions={
        <>
          {connection.kind === "connected" ? (
            connection.active ? (
              <Button size="xs" shape="capsule" variant="subtle" onClick={onDeactivate}>
                Back to this computer
              </Button>
            ) : (
              <Button size="xs" shape="capsule" variant="subtle" onClick={onActivate}>
                Open
              </Button>
            )
          ) : (
            <Button
              size="xs"
              shape="capsule"
              variant="subtle"
              disabled={!host.linked || connection.busy}
              onClick={onConnect}
            >
              {connection.busy ? "Connecting…" : "Connect"}
            </Button>
          )}
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`More actions for ${host.name}`}
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-52">
              {onProbe ? (
                <MenuItem disabled={reachability.state === "probing"} onClick={onProbe}>
                  {reachability.state === "probing" ? "Checking…" : "Check availability"}
                </MenuItem>
              ) : null}
              {connection.kind === "connected" ? (
                <MenuItem disabled={connection.busy} onClick={onDisconnect}>
                  Disconnect
                </MenuItem>
              ) : null}
              {owned ? (
                <MenuCheckboxItem
                  variant="switch"
                  checked={host.discoverable}
                  disabled={busy}
                  onCheckedChange={(checked) => onToggleDiscoverable(Boolean(checked))}
                >
                  Share with workspace
                </MenuCheckboxItem>
              ) : null}
              {onForget ? (
                <>
                  <MenuSeparator />
                  <MenuItem variant="destructive" onClick={onForget}>
                    Forget pairing
                  </MenuItem>
                </>
              ) : null}
            </ComposerPickerMenuPopup>
          </Menu>
        </>
      }
    />
  );
}

function usedLabel(iso: string | null): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "Never used";
  const relative = formatRelativeTime(iso);
  return relative === "now" ? "Used just now" : `Used ${relative} ago`;
}

/** A device signed in to the account (Advanced). */
export function DeviceRow({
  device,
  busy,
  onRevoke,
  onRevokeAccountSessions,
}: {
  device: AccountDevice;
  busy: boolean;
  onRevoke: () => void;
  onRevokeAccountSessions?: () => void;
}) {
  const revoked = device.revokedAt !== null;
  return (
    <SettingsListRow
      align="start"
      leading={<RemoteDeviceIcon label={`${device.platform} ${device.displayName}`} />}
      title={device.displayName}
      description={
        <span className="flex flex-col gap-0.5">
          <span>{revoked ? "Device key revoked" : usedLabel(device.lastUsedAt)}</span>
          {device.revocationDeliveries?.map((delivery) => (
            <span key={delivery.hostId} className="text-ui-sm">
              {delivery.hostName}:{" "}
              {delivery.confirmedAt
                ? "revocation confirmed"
                : "delivery pending; existing sessions expire normally"}
            </span>
          ))}
        </span>
      }
      actions={
        <>
          {onRevokeAccountSessions ? (
            <Button
              size="xs"
              shape="capsule"
              variant="subtle"
              disabled={busy}
              onClick={onRevokeAccountSessions}
            >
              Sign out
            </Button>
          ) : null}
          {!revoked ? (
            <Button
              size="xs"
              shape="capsule"
              variant="destructive-outline"
              disabled={busy}
              onClick={onRevoke}
            >
              Revoke key
            </Button>
          ) : null}
        </>
      }
    />
  );
}

const SESSION_TRANSPORT_LABELS: Record<HostSession["transport"], string> = {
  cloudflare: "Cloudflare",
  direct: "Direct",
  relay: "Relay",
  "ssh-forward": "SSH forward",
};

function startedLabel(iso: string): string {
  if (Number.isNaN(Date.parse(iso))) return "Started at an unknown time";
  const relative = formatRelativeTime(iso);
  return relative === "now" ? "Started just now" : `Started ${relative} ago`;
}

/** A live session another device holds to this computer (Advanced). */
export function SessionRow({
  session,
  userLabel,
  deviceLabel,
  busy,
  onEnd,
}: {
  session: HostSession;
  userLabel: string;
  deviceLabel: string;
  busy: boolean;
  onEnd: () => void;
}) {
  return (
    <SettingsListRow
      leading={<RemoteDeviceIcon label={deviceLabel} />}
      title={deviceLabel}
      description={
        <span>
          {userLabel} · {SESSION_TRANSPORT_LABELS[session.transport]} ·{" "}
          <time dateTime={session.startedAt}>{startedLabel(session.startedAt)}</time>
        </span>
      }
      actions={
        <Button
          size="xs"
          shape="capsule"
          variant="destructive-outline"
          disabled={busy}
          onClick={onEnd}
        >
          End session
        </Button>
      }
    />
  );
}
