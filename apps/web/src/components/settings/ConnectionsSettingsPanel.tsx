import { removeWorkspaceSession } from "~/lib/hosts/workspaceSessions";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { RemotePairingPanel } from "./RemotePairingPanel";
// FILE: ConnectionsSettingsPanel.tsx
// Purpose: The hosts pane — the machines this account can reach, the owner's
//          discoverability switch, and the devices signed in to the account.
// Layer: Settings UI components
// Exports: ConnectionsSettingsPanel

import type { AccountDevice, AccountHost, HostConnection, HostSession } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { useAccount } from "~/hooks/useAccount";
import { useDevices, useHostConnections, useHosts, useHostSessions } from "~/hooks/useHosts";
import { accountErrorMessage } from "~/lib/accountLogic";
import {
  canManageHost,
  hostOwnerBadgeLabel,
  hostPlatformLabel,
  readHostsApi,
} from "~/lib/hosts/api";
import {
  reachabilityLabel,
  reachabilityToneClassName,
  TRANSPORT_LABELS,
  type HostReachability,
} from "~/lib/hosts/reachability";
import { activateHost, deactivateHost, readActiveHost } from "~/lib/hosts/activeHost";
import { HostsUnsupportedError } from "~/lib/hosts/queries";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import { SettingsEmptyState, SettingsListRow, SettingsSection } from "./SettingsPanelPrimitives";
import { HostConnectionControl } from "../hosts/HostConnectionControl";

/**
 * Relative "last used" copy. Absolute timestamps read as precision this data
 * does not have (`lastUsedAt` is historical metadata, ADR 0010), and a bare
 * ISO string in a settings row is noise.
 */
function relativeTimeLabel(iso: string | null, now: number): string {
  if (!iso) return "Never used";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "Never used";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "Used just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Used ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Used ${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `Used ${days}d ago`;
  return `Used ${Math.round(days / 30)}mo ago`;
}

export function ConnectionsSettingsPanel({ active }: { active: boolean }) {
  const account = useAccount();
  const signedIn = account.me !== null;
  const capability = readExecutionContext()?.controller.capabilities;
  const enabled = active && signedIn && capability?.remoteConnections === true;
  const remote = useHosts({ enabled });
  const devices = useDevices({ enabled });
  const sessions = useHostSessions({ enabled });
  const connections = useHostConnections({ enabled });
  const activeHost = readActiveHost();
  const navigate = useNavigate();
  // Reachability is attempt-based (ADR 0010): the map holds what the LAST
  // probe said, per host, and a host nobody probed simply is not in it.
  const [reachability, setReachability] = useState<Readonly<Record<string, HostReachability>>>({});

  const probeHost = useCallback(async (host: AccountHost) => {
    setReachability((current) => ({ ...current, [host.id]: { state: "probing" } }));
    const check = readHostsApi()?.checkReachability;
    if (!check) {
      // No probe available on this shell: say so rather than reporting the
      // host down, which is the failure mode ADR 0010 exists to prevent.
      setReachability((current) => ({
        ...current,
        [host.id]: { state: "no-route", at: Date.now() },
      }));
      return;
    }
    try {
      const result = await check({ hostId: host.id });
      setReachability((current) => ({ ...current, [host.id]: result }));
    } catch {
      setReachability((current) => ({
        ...current,
        [host.id]: { state: "no-answer", at: Date.now() },
      }));
    }
  }, []);

  const toggleDiscoverable = useCallback(
    async (host: AccountHost, discoverable: boolean) => {
      try {
        await remote.setDiscoverable.mutateAsync({ hostId: host.id, discoverable });
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: discoverable ? "Could not share host" : "Could not stop sharing host",
          description: accountErrorMessage(cause, "Try again in a moment."),
        });
      }
    },
    [remote.setDiscoverable],
  );

  const revokeDevice = useCallback(
    async (device: AccountDevice) => {
      const api = readNativeApi() ?? ensureNativeApi();
      const confirmed = await api.dialogs.confirm(
        [
          `Revoke ${device.displayName}?`,
          "",
          "This blocks new remote connections for this device key. Online hosts receive a revocation; an offline host may keep an existing session until it expires. Account sign-in sessions are managed separately.",
        ].join("\n"),
      );
      if (!confirmed) return;
      try {
        await devices.revokeDevice.mutateAsync({ deviceId: device.id });
        toastManager.add({
          type: "success",
          title: "Device revoked",
          description:
            "New connections are blocked. Offline hosts may retain existing sessions until authorization expires.",
        });
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "Could not revoke device",
          description: accountErrorMessage(cause, "Try again in a moment."),
        });
      }
    },
    [devices.revokeDevice],
  );

  const revokeAccountSessions = async (device: AccountDevice) => {
    if (
      !(await ensureNativeApi().dialogs.confirm(
        `Sign out account sessions on ${device.displayName}? This does not revoke its locally paired device key. Existing remote sessions end when their authorization expires unless you also revoke the device.`,
      ))
    )
      return;
    try {
      const result = await readHostsApi()?.remoteAccess?.({
        operation: "revoke-account-sessions",
        deviceId: device.id,
      });
      if (result?.kind !== "account-sessions-revoked")
        throw new Error("Account session revocation is unavailable.");
      toastManager.add({
        type: result.pending ? "warning" : "success",
        title: result.pending ? "Sign-out delivery pending" : "Account sessions signed out",
        description: `${result.confirmed} confirmed; ${result.pending} awaiting the identity provider. ${result.pending ? "You can retry this action." : "The device key is unchanged."}`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not sign out account sessions",
        description: accountErrorMessage(error, "Try again."),
      });
    }
  };

  const unlinkLocalHost = useCallback(async () => {
    const api = readNativeApi() ?? ensureNativeApi();
    const confirmed = await api.dialogs.confirm(
      [
        "Unlink this machine?",
        "",
        "Its key is removed from your account and other devices' sessions to it end. Synara keeps working locally.",
      ].join("\n"),
    );
    if (!confirmed) return;
    try {
      await remote.unlinkLocalHost.mutateAsync();
      toastManager.add({
        type: "success",
        title: "Machine unlinked",
        description: "This machine is no longer reachable from your other devices.",
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not unlink this machine",
        description: accountErrorMessage(cause, "Try again in a moment."),
      });
    }
  }, [remote.unlinkLocalHost]);

  /**
   * Open a session to the host (the shell dials, races transports, mints) and
   * add its projects alongside the local workspace.
   */
  const connectToHost = useCallback(
    async (host: AccountHost) => {
      try {
        const connection = await connections.connect.mutateAsync({ hostId: host.id });
        await activateHost({
          ...(connection.executionScope ? { executionScope: connection.executionScope } : {}),
          hostId: connection.hostId,
          hostName: connection.hostName,
          wsPath: connection.wsPath,
        });
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: `Could not connect to ${host.name}`,
          description: accountErrorMessage(cause, "Check that the host is online and try again."),
        });
      }
    },
    [connections.connect],
  );

  const disconnectFromHost = useCallback(
    async (hostId: string) => {
      try {
        await connections.disconnect.mutateAsync({ hostId });
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "Could not disconnect",
          description: accountErrorMessage(cause, "Try again in a moment."),
        });
        return;
      }
      removeWorkspaceSession(hostId);
    },
    [connections.disconnect],
  );

  const endSession = useCallback(
    async (session: HostSession) => {
      const api = readNativeApi() ?? ensureNativeApi();
      const confirmed = await api.dialogs.confirm(
        [
          "End this session?",
          "",
          `User ${session.userId} will be disconnected from this machine immediately.`,
        ].join("\n"),
      );
      if (!confirmed) return;
      try {
        await sessions.endSession.mutateAsync({ sessionId: session.id });
        toastManager.add({
          type: "success",
          title: "Session ended",
          description: "The remote connection was closed.",
        });
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "Could not end session",
          description: accountErrorMessage(cause, "Try again in a moment."),
        });
      }
    },
    [sessions.endSession],
  );

  if (!active) return null;

  if (capability?.remoteConnections !== true)
    return (
      <div className="space-y-6">
        <HostConnectionControl />
        <SettingsSection title="Connections">
          <SettingsListRow
            title="Unavailable in this build"
            description={
              capability?.remoteUnavailableReason ??
              "Update the local controller to manage remote access."
            }
          />
        </SettingsSection>
      </div>
    );

  if (!signedIn) {
    return (
      <div className="space-y-6">
        <HostConnectionControl />
        <SettingsSection title="Hosts">
          <div className="p-3">
            <SettingsEmptyState layout="block">
              Sign in to see the machines on your account.
            </SettingsEmptyState>
          </div>
        </SettingsSection>
      </div>
    );
  }

  const hostsError = remote.hostsQuery.error;
  const unsupported = hostsError instanceof HostsUnsupportedError;

  return (
    <div className="space-y-6">
      <HostConnectionControl />
      <SettingsSection title="Hosts">
        {remote.hostsQuery.isPending ? (
          <SettingsListRow title="Loading hosts..." />
        ) : hostsError ? (
          <div className="p-3">
            <SettingsEmptyState layout="status" tone="destructive">
              {unsupported
                ? "This Synara server is too old to manage hosts. Update the server and try again."
                : accountErrorMessage(hostsError, "Could not load your hosts.")}
            </SettingsEmptyState>
          </div>
        ) : remote.hosts.length === 0 ? (
          <div className="p-3">
            <SettingsEmptyState layout="block">
              No machines yet. Sign in on another machine to add it, or link a headless one with a
              device code.
            </SettingsEmptyState>
          </div>
        ) : (
          remote.hosts.map((host) => {
            const connection = connections.connections.find((c) => c.hostId === host.id) ?? null;
            const isLocal = remote.enrollment?.host?.id === host.id;
            return (
              <HostRow
                key={host.id}
                host={host}
                reachability={reachability[host.id] ?? { state: "unknown" }}
                busy={remote.setDiscoverable.isPending}
                connection={
                  isLocal
                    ? { kind: "this-machine" }
                    : connection
                      ? {
                          kind: "connected",
                          transport: connection.transport,
                          active: activeHost?.hostId === host.id,
                          busy: connections.disconnect.isPending,
                        }
                      : { kind: "disconnected", busy: connections.connect.isPending }
                }
                {...(readHostsApi()?.checkReachability
                  ? { onProbe: () => void probeHost(host) }
                  : {})}
                onToggleDiscoverable={(next) => void toggleDiscoverable(host, next)}
                onConnect={() => void connectToHost(host)}
                onDisconnect={() => void disconnectFromHost(host.id)}
                onActivate={() => void connectToHost(host)}
                onDeactivate={() => deactivateHost()}
              />
            );
          })
        )}
      </SettingsSection>

      {remote.enrollment?.host ? (
        <SettingsSection title="This machine">
          <SettingsListRow
            align="start"
            title={remote.enrollment.host.name}
            description={
              <span className="text-muted-foreground">
                Signing out unlinks this machine automatically. Unlink now to remove its key while
                staying signed in — Synara keeps working locally either way.
              </span>
            }
            actions={
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={remote.unlinkLocalHost.isPending}
                onClick={() => void unlinkLocalHost()}
              >
                {remote.unlinkLocalHost.isPending ? "Unlinking..." : "Unlink"}
              </Button>
            }
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title="Link a headless machine">
        <SettingsListRow
          align="start"
          title="Device code"
          description={
            <span className="text-muted-foreground">
              A machine without a browser prints a short code. Enter it here to approve the link.
            </span>
          }
          actions={
            <Button size="xs" variant="outline" onClick={() => void navigate({ to: "/link" })}>
              Enter a code
            </Button>
          }
        />
      </SettingsSection>

      <RemotePairingPanel />
      <SettingsSection title="Sync host secrets">
        <SettingsListRow
          title="Unavailable in this version"
          description="Remote connections do not sync provider keys or account profiles."
        />
      </SettingsSection>

      <SettingsSection title="Devices">
        {devices.devicesQuery.isPending ? (
          <SettingsListRow title="Loading devices..." />
        ) : devices.devicesQuery.error ? (
          <div className="p-3">
            <SettingsEmptyState layout="status" tone="destructive">
              {accountErrorMessage(devices.devicesQuery.error, "Could not load your devices.")}
            </SettingsEmptyState>
          </div>
        ) : devices.devices.length === 0 ? (
          <div className="p-3">
            <SettingsEmptyState layout="block">
              No devices are registered on this account yet.
            </SettingsEmptyState>
          </div>
        ) : (
          devices.devices.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              busy={devices.revokeDevice.isPending}
              onRevoke={() => void revokeDevice(device)}
              onRevokeAccountSessions={() => void revokeAccountSessions(device)}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection title="Active sessions">
        {sessions.sessionsQuery.isPending ? (
          <SettingsListRow title="Loading sessions..." />
        ) : sessions.sessionsQuery.error ? (
          <div className="p-3">
            <SettingsEmptyState layout="status" tone="destructive">
              {accountErrorMessage(sessions.sessionsQuery.error, "Could not load active sessions.")}
            </SettingsEmptyState>
          </div>
        ) : sessions.sessions.length === 0 ? (
          <div className="p-3">
            <SettingsEmptyState layout="block">
              Nobody is connected to this machine right now.
            </SettingsEmptyState>
          </div>
        ) : (
          sessions.sessions.map((session) => {
            const device = devices.devices.find((candidate) => candidate.jkt === session.deviceJkt);
            const userLabel =
              account.me?.id === session.userId ? account.me.name : `User ${session.userId}`;
            return (
              <SessionRow
                key={session.id}
                session={session}
                userLabel={userLabel}
                deviceLabel={device?.displayName ?? `Device ${session.deviceJkt}`}
                busy={sessions.endSession.isPending}
                onEnd={() => void endSession(session)}
              />
            );
          })
        )}
      </SettingsSection>
    </div>
  );
}

/** Where this window stands with respect to one host row. */
export type HostRowConnection =
  | { readonly kind: "this-machine" }
  | { readonly kind: "disconnected"; readonly busy: boolean }
  | {
      readonly kind: "connected";
      readonly transport: HostConnection["transport"];
      /** This window is currently working on that host. */
      readonly active: boolean;
      readonly busy: boolean;
    };

export function HostRow({
  host,
  reachability,
  busy,
  connection = { kind: "disconnected", busy: false },
  onProbe,
  onToggleDiscoverable,
  onConnect,
  onDisconnect,
  onActivate,
  onDeactivate,
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
}) {
  const owned = canManageHost(host);
  return (
    <SettingsListRow
      align="start"
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{host.name}</span>
          {/* Ownership is a fact, not a status: `secondary` for both, so
              neither reads as better or worse than the other. */}
          <Badge variant="secondary" size="sm" className="shrink-0">
            {hostOwnerBadgeLabel(host)}
          </Badge>
        </span>
      }
      description={
        <span className="flex flex-col gap-0.5">
          <span>{hostPlatformLabel(host.platform)}</span>
          {/* Reachability as of the last probe — text and emphasis, never a
              colored dot (ADR 0010; the palette has no success token). */}
          <span className={cn(reachabilityToneClassName(reachability))}>
            {onProbe ? reachabilityLabel(reachability) : "Connect to verify availability"}
          </span>
          {!host.linked ? (
            <span className="text-muted-foreground">
              Not linked — this machine has not completed its key exchange.
            </span>
          ) : null}
          {connection.kind === "connected" ? (
            <span>
              {connection.active ? "Working on this host" : "Connected"} over{" "}
              {TRANSPORT_LABELS[connection.transport]}
            </span>
          ) : null}
        </span>
      }
      actions={
        <>
          {connection.kind === "this-machine" ? null : connection.kind === "connected" ? (
            <>
              {connection.active ? (
                <Button size="xs" variant="outline" onClick={onDeactivate}>
                  Back to this machine
                </Button>
              ) : (
                <Button size="xs" onClick={onActivate}>
                  Open
                </Button>
              )}
              <Button size="xs" variant="outline" disabled={connection.busy} onClick={onDisconnect}>
                Disconnect
              </Button>
            </>
          ) : (
            <Button size="xs" disabled={!host.linked || connection.busy} onClick={onConnect}>
              {connection.busy ? "Connecting..." : "Connect"}
            </Button>
          )}
          {onProbe ? (
            <Button
              size="xs"
              variant="outline"
              disabled={reachability.state === "probing"}
              onClick={onProbe}
            >
              {reachability.state === "probing" ? "Checking..." : "Check"}
            </Button>
          ) : null}
          {owned ? (
            <label className="flex items-center gap-2">
              <span className="text-ui-sm text-muted-foreground">Discoverable</span>
              <Switch
                checked={host.discoverable}
                disabled={busy}
                aria-label={`Share ${host.name} with your workspace`}
                onCheckedChange={onToggleDiscoverable}
              />
            </label>
          ) : null}
        </>
      }
    />
  );
}

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
      title={device.displayName}
      description={
        <span className="flex flex-col gap-0.5">
          <span>{relativeTimeLabel(device.lastUsedAt, Date.now())}</span>
          {revoked ? <span className="text-muted-foreground">Device key revoked</span> : null}
          {device.revocationDeliveries?.map((delivery) => (
            <span key={delivery.hostId} className="text-ui-xs text-muted-foreground">
              {delivery.hostName}:{" "}
              {delivery.confirmedAt
                ? "revocation confirmed"
                : "delivery pending; existing sessions expire normally"}
            </span>
          ))}
        </span>
      }
      actions={
        <div className="flex flex-wrap gap-2">
          {onRevokeAccountSessions ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={onRevokeAccountSessions}>
              Sign out account
            </Button>
          ) : null}
          {!revoked ? (
            <Button size="xs" variant="destructive-outline" disabled={busy} onClick={onRevoke}>
              Revoke device key
            </Button>
          ) : null}
        </div>
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

function sessionStartedLabel(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "Started at an unknown time";
  const seconds = Math.max(0, Math.round((now - then) / 1_000));
  if (seconds < 60) return "Started just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Started ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Started ${hours}h ago`;
  return `Started ${Math.round(hours / 24)}d ago`;
}

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
      align="start"
      title={userLabel}
      description={
        <span className="flex flex-col gap-0.5">
          <span>{deviceLabel}</span>
          <span>{SESSION_TRANSPORT_LABELS[session.transport]}</span>
          <time dateTime={session.startedAt}>
            {sessionStartedLabel(session.startedAt, Date.now())}
          </time>
        </span>
      }
      actions={
        <Button size="xs" variant="destructive-outline" disabled={busy} onClick={onEnd}>
          End session
        </Button>
      }
    />
  );
}
