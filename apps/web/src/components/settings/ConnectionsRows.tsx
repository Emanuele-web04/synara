// FILE: ConnectionsRows.tsx
// Purpose: The row shapes the Connections pane lists — devices trusted by this
//          computer, computers this one can control, and the account's devices
//          and sessions shown under Advanced.
// Layer: Settings UI components
// Exports: RemoteDeviceIcon, RootFingerprint, TrustedDeviceRow, HostRow, HostRowConnection,
//          DeviceRow, SessionRow

import { t as translate, useTranslation } from "~/i18n";
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
  TRANSPORT_LABEL_KEYS,
  type HostReachability,
} from "~/lib/hosts/reachability";
import {
  fingerprintGroups,
  remoteDeviceKind,
  trustedDeviceActivityLabel,
} from "~/lib/hosts/remoteAccess";
import { formatRelativeTimeAgo } from "~/lib/relativeTime";
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
import { CopyTextButton } from "../ui/copyTextButton";
import { Menu, MenuCheckboxItem, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SettingsListRow } from "./SettingsPanelPrimitives";

const ICON_CLASS_NAME = "size-5";

export function RemoteDeviceIcon({ label }: { label: string }) {
  const kind = remoteDeviceKind(label);
  if (kind === "phone") return <DeviceMobileIcon className={ICON_CLASS_NAME} aria-hidden />;
  if (kind === "tablet") return <DeviceTabletIcon className={ICON_CLASS_NAME} aria-hidden />;
  return <DeviceComputerIcon className={ICON_CLASS_NAME} aria-hidden />;
}

/** Grouped identity for comparison; copies the original fingerprint without display spacing. */
export function RootFingerprint({ value, className }: { value: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <p className="grid min-w-0 flex-1 grid-cols-4 gap-x-2 gap-y-1 font-mono text-ui-xs">
        {fingerprintGroups(value).map((group) => (
          <span key={group.offset}>{group.text}</span>
        ))}
      </p>
      <CopyTextButton text={value} label={t("computer:remote_host_fingerprint")} iconOnly />
    </div>
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
  const { t } = useTranslation();
  return (
    <SettingsListRow
      leading={<RemoteDeviceIcon label={device.label} />}
      title={device.label}
      description={trustedDeviceActivityLabel(device)}
      actions={
        <Button size="xs" shape="capsule" variant="subtle" disabled={busy} onClick={onRevoke}>
          {t("computer:remote_host_revoke_access")}
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
    return translate(
      connection.active
        ? "computer:remote_host_working_over"
        : "computer:remote_host_connected_over",
      { transport: translate(TRANSPORT_LABEL_KEYS[connection.transport]) },
    );
  if (!host.linked) return translate("computer:remote_host_not_linked");
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
  const { t } = useTranslation();
  const connection = connectionProp ?? { kind: "disconnected", busy: false };
  const owned = canManageHost(host);
  const status = hostStatusLabel(host, connection, reachability);
  const details = [
    hostPlatformLabel(host.platform),
    ...(owned ? [] : [t("computer:remote_host_shared_workspace")]),
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
                {t("computer:remote_host_back_this_computer")}
              </Button>
            ) : (
              <Button size="xs" shape="capsule" variant="subtle" onClick={onActivate}>
                {t("onboarding:notification_open")}
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
              {connection.busy ? t("computer:connecting") : t("computer:remote_host_connect")}
            </Button>
          )}
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t("computer:remote_host_more_actions", { host: host.name })}
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-52">
              {onProbe ? (
                <MenuItem disabled={reachability.state === "probing"} onClick={onProbe}>
                  {reachability.state === "probing"
                    ? t("settings:checking")
                    : t("computer:remote_host_check_availability")}
                </MenuItem>
              ) : null}
              {connection.kind === "connected" ? (
                <MenuItem disabled={connection.busy} onClick={onDisconnect}>
                  {t("settings:connectorDisconnect")}
                </MenuItem>
              ) : null}
              {owned ? (
                <MenuCheckboxItem
                  variant="switch"
                  checked={host.discoverable}
                  disabled={busy}
                  onCheckedChange={(checked) => onToggleDiscoverable(Boolean(checked))}
                >
                  {t("computer:remote_host_share_workspace")}
                </MenuCheckboxItem>
              ) : null}
              {onForget ? (
                <>
                  <MenuSeparator />
                  <MenuItem variant="destructive" onClick={onForget}>
                    {t("computer:remote_host_forget_pairing")}
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
  if (!iso || Number.isNaN(Date.parse(iso))) return translate("computer:remote_host_never_used");
  return translate("computer:remote_host_used", { time: formatRelativeTimeAgo(iso) });
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
  const { t } = useTranslation();
  const revoked = device.revokedAt !== null;
  return (
    <SettingsListRow
      align="start"
      leading={<RemoteDeviceIcon label={`${device.platform} ${device.displayName}`} />}
      title={device.displayName}
      description={
        <span className="flex flex-col gap-0.5">
          <span>
            {revoked ? t("computer:remote_host_key_revoked") : usedLabel(device.lastUsedAt)}
          </span>
          {device.revocationDeliveries?.map((delivery) => (
            <span key={delivery.hostId} className="text-ui-sm">
              {delivery.hostName}:{" "}
              {delivery.confirmedAt
                ? t("computer:remote_host_revocation_confirmed")
                : t("computer:remote_host_revocation_pending")}
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
              {t("settings:signOut")}
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
              {t("computer:remote_host_revoke_key")}
            </Button>
          ) : null}
        </>
      }
    />
  );
}

const SESSION_TRANSPORT_LABEL_KEYS: Record<HostSession["transport"], string> = {
  cloudflare: "computer:remote_host_transport_cloudflare",
  direct: "computer:remote_host_transport_direct",
  relay: "computer:remote_host_transport_relay_session",
  "ssh-forward": "computer:remote_host_transport_ssh_forward",
};

function startedLabel(iso: string): string {
  if (Number.isNaN(Date.parse(iso))) return translate("computer:remote_host_started_unknown");
  return translate("computer:remote_host_started", { time: formatRelativeTimeAgo(iso) });
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
  const { t } = useTranslation();
  return (
    <SettingsListRow
      leading={<RemoteDeviceIcon label={deviceLabel} />}
      title={deviceLabel}
      description={
        <span>
          {userLabel} · {t(SESSION_TRANSPORT_LABEL_KEYS[session.transport])} ·{" "}
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
          {t("computer:remote_host_end_session")}
        </Button>
      }
    />
  );
}
