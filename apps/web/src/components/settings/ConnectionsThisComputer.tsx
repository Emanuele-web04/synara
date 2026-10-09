// FILE: ConnectionsThisComputer.tsx
// Purpose: "Control this Mac" — the owner's allow switch, the devices trusted to
//          control this computer, keep-awake, and an Advanced disclosure with the
//          account's devices, live sessions, and this machine's account link.
// Layer: Settings UI components
// Exports: ConnectionsThisComputer

import type {
  AccountDevice,
  HostSession,
  RemoteAccessRequest,
  RemoteTrustedDevice,
} from "@synara/contracts";
import { type ReactNode, useEffect, useState } from "react";

import { useAccount } from "~/hooks/useAccount";
import { reportRemoteAccessAllowed, useDesktopKeepAwake } from "~/hooks/useDesktopKeepAwake";
import { useDevices, useHosts, useHostSessions } from "~/hooks/useHosts";
import { useRemoteHostState } from "~/hooks/useRemoteHostState";
import { accountErrorMessage } from "~/lib/accountLogic";
import { readHostsApi } from "~/lib/hosts/api";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import {
  activeTrustedDevices,
  callRemoteAccess,
  pendingApprovals,
  remoteAccessErrorMessage,
} from "~/lib/hosts/remoteAccess";
import { AddPlusIcon, RotateCcwIcon } from "~/lib/icons";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { IconButton } from "../ui/icon-button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { ConnectionsAddDeviceDialog } from "./ConnectionsAddDeviceDialog";
import { DeviceRow, SessionRow, TrustedDeviceRow } from "./ConnectionsRows";
import {
  SettingsCard,
  SettingsListRow,
  SettingsSection,
  SettingsSectionShell,
} from "./SettingsPanelPrimitives";

function confirmAction(message: string): Promise<boolean> {
  return (readNativeApi() ?? ensureNativeApi()).dialogs.confirm(message);
}

/** Rendered only when signed in with remote connections available. */
export function ConnectionsThisComputer({
  computerNoun,
}: {
  /** "Mac" on macOS, "computer" elsewhere. */
  computerNoun: string;
}) {
  const { state, loadError, refresh } = useRemoteHostState();
  const keepAwake = useDesktopKeepAwake();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowOverride, setAllowOverride] = useState<boolean | null>(null);
  const [dialog, setDialog] = useState<"add" | "review" | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedSeen, setAdvancedSeen] = useState(false);

  const allowConnections = state ? (state.allowConnections ?? true) : null;
  useEffect(() => {
    if (allowConnections !== null) reportRemoteAccessAllowed(allowConnections);
  }, [allowConnections]);

  const perform = async (request: RemoteAccessRequest, failure: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await callRemoteAccess(request);
      await refresh();
    } catch (cause) {
      setError(remoteAccessErrorMessage(cause, failure));
    } finally {
      setBusy(false);
    }
  };

  const setAllow = async (enabled: boolean) => {
    setAllowOverride(enabled);
    await perform(
      { operation: "set-allow-connections", enabled },
      enabled ? "Could not allow connections." : "Could not turn off connections.",
    );
    setAllowOverride(null);
  };

  const revoke = async (device: RemoteTrustedDevice) => {
    if (
      !(await confirmAction(
        `Revoke access for ${device.label}? It will need to be added again to control this ${computerNoun}.`,
      ))
    )
      return;
    await perform(
      { operation: "revoke-device", deviceJkt: device.deviceJkt },
      "Could not revoke access.",
    );
  };

  const repair = async () => {
    const local = readExecutionContext()?.controller;
    if (
      !local ||
      !(await confirmAction(
        `Repair remote access on this ${computerNoun}? Every device loses access and must be added again. Your projects and chats stay here.`,
      ))
    )
      return;
    await perform(
      { operation: "reset-identity", environmentId: local.environmentId },
      "Could not repair remote access.",
    );
  };

  const devices = activeTrustedDevices(state);
  const pending = pendingApprovals(state, Date.now());
  const allowChecked = allowOverride ?? allowConnections ?? true;

  return (
    <>
      <SettingsSectionShell
        title={`Devices that can control this ${computerNoun}`}
        action={
          <div className="flex items-center gap-1.5">
            <IconButton label="Refresh" variant="ghost" onClick={() => void refresh()}>
              <RotateCcwIcon className="size-3.5" />
            </IconButton>
            <Button size="xs" shape="capsule" onClick={() => setDialog("add")}>
              <AddPlusIcon className="size-3.5" />
              Add
            </Button>
          </div>
        }
      >
        <SettingsCard>
          <SettingsListRow
            title="Allow connections"
            description={
              allowChecked ? undefined : "Devices below can't connect until you turn this on."
            }
            actions={
              <Switch
                checked={allowChecked}
                disabled={busy || state === null}
                aria-label="Allow connections"
                onCheckedChange={(next) => void setAllow(next)}
              />
            }
          />
          {pending.length > 0 ? (
            <SettingsListRow
              title={
                pending.length === 1
                  ? `${pending[0]!.pendingDevice.label} is waiting for approval`
                  : `${pending.length} devices are waiting for approval`
              }
              actions={
                <Button
                  size="xs"
                  shape="capsule"
                  variant="subtle"
                  onClick={() => setDialog("review")}
                >
                  Review
                </Button>
              }
            />
          ) : null}
          {devices.map((device) => (
            <TrustedDeviceRow
              key={device.deviceJkt}
              device={device}
              busy={busy}
              onRevoke={() => void revoke(device)}
            />
          ))}
          {state !== null && devices.length === 0 ? (
            <SettingsListRow
              title={<span className="font-normal text-muted-foreground">No devices yet</span>}
              description={`Add your iPhone or iPad to control this ${computerNoun} from anywhere.`}
            />
          ) : null}
          {state?.rootNeedsRepair ? (
            <SettingsListRow
              title="Remote access needs repair"
              description="Devices can't verify this computer until it is repaired."
              actions={
                <Button
                  size="xs"
                  shape="capsule"
                  variant="subtle"
                  disabled={busy}
                  onClick={() => void repair()}
                >
                  Repair
                </Button>
              }
            />
          ) : null}
        </SettingsCard>
        {error || (loadError && state === null) ? (
          <p role="alert" className="px-2 text-ui text-destructive">
            {error ?? loadError}
          </p>
        ) : null}
      </SettingsSectionShell>

      {keepAwake.state ? (
        <SettingsSection title="Other settings">
          <SettingsListRow
            title={`Keep this ${computerNoun} awake`}
            description={
              keepAwake.state.enabled && keepAwake.state.onBattery
                ? "Paused while on battery"
                : "Prevent sleep when computer is plugged in and remote access is enabled"
            }
            actions={
              <Switch
                checked={keepAwake.state.enabled}
                aria-label={`Keep this ${computerNoun} awake`}
                onCheckedChange={(next) =>
                  void keepAwake.setEnabled(next).catch((cause: unknown) =>
                    toastManager.add({
                      type: "error",
                      title: "Could not change keep awake",
                      description: remoteAccessErrorMessage(cause, "Try again."),
                    }),
                  )
                }
              />
            }
          />
        </SettingsSection>
      ) : null}

      <section className="mt-6">
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1.5 px-2 text-ui-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={advancedOpen}
          onClick={() => {
            setAdvancedOpen((open) => !open);
            setAdvancedSeen(true);
          }}
        >
          <DisclosureChevron open={advancedOpen} />
          Advanced
        </button>
        <DisclosureRegion open={advancedOpen}>
          {advancedSeen ? <AccountAdvanced /> : null}
        </DisclosureRegion>
      </section>

      <ConnectionsAddDeviceDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        createCode={dialog === "add"}
        state={state}
        onChanged={refresh}
      />
    </>
  );
}

/** The account-level view: this machine's link, signed-in devices, and live sessions. */
function AccountAdvanced() {
  const account = useAccount();
  const remote = useHosts({ enabled: true });
  const devices = useDevices({ enabled: true });
  const sessions = useHostSessions({ enabled: true });
  const localHost = remote.enrollment?.host
    ? (remote.hosts.find((host) => host.id === remote.enrollment?.host?.id) ?? null)
    : null;

  const fail = (title: string, cause: unknown) =>
    toastManager.add({
      type: "error",
      title,
      description: accountErrorMessage(cause, "Try again in a moment."),
    });

  const unlink = async () => {
    if (
      !(await confirmAction(
        "Unlink this machine?\n\nIts key is removed from your account and other devices' sessions to it end. Synara keeps working locally.",
      ))
    )
      return;
    try {
      await remote.unlinkLocalHost.mutateAsync();
      toastManager.add({
        type: "success",
        title: "Machine unlinked",
        description: "This machine is no longer reachable from your other devices.",
      });
    } catch (cause) {
      fail("Could not unlink this machine", cause);
    }
  };

  const revokeDevice = async (device: AccountDevice) => {
    if (
      !(await confirmAction(
        `Revoke ${device.displayName}?\n\nThis blocks new remote connections for this device key. Online hosts receive a revocation; an offline host may keep an existing session until it expires. Account sign-in sessions are managed separately.`,
      ))
    )
      return;
    try {
      await devices.revokeDevice.mutateAsync({ deviceId: device.id });
      toastManager.add({
        type: "success",
        title: "Device revoked",
        description:
          "New connections are blocked. Offline hosts may retain existing sessions until authorization expires.",
      });
    } catch (cause) {
      fail("Could not revoke device", cause);
    }
  };

  const signOutDevice = async (device: AccountDevice) => {
    if (
      !(await confirmAction(
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
    } catch (cause) {
      fail("Could not sign out account sessions", cause);
    }
  };

  const endSession = async (session: HostSession) => {
    if (
      !(await confirmAction(
        `End this session?\n\nUser ${session.userId} will be disconnected from this machine immediately.`,
      ))
    )
      return;
    try {
      await sessions.endSession.mutateAsync({ sessionId: session.id });
      toastManager.add({
        type: "success",
        title: "Session ended",
        description: "The remote connection was closed.",
      });
    } catch (cause) {
      fail("Could not end session", cause);
    }
  };

  return (
    <div className="pt-1">
      {remote.enrollment?.host ? (
        <SettingsSection title="This machine on your account">
          <SettingsListRow
            title={remote.enrollment.host.name}
            description="Signing out unlinks it automatically. Synara keeps working locally."
            actions={
              <Button
                size="xs"
                shape="capsule"
                variant="destructive-outline"
                disabled={remote.unlinkLocalHost.isPending}
                onClick={() => void unlink()}
              >
                {remote.unlinkLocalHost.isPending ? "Unlinking…" : "Unlink"}
              </Button>
            }
          />
          {localHost && remote.canManageHost(localHost) ? (
            <SettingsListRow
              title="Share with your workspace"
              description="Members of your workspace can see and use this machine."
              actions={
                <Switch
                  checked={localHost.discoverable}
                  disabled={remote.setDiscoverable.isPending}
                  aria-label="Share this machine with your workspace"
                  onCheckedChange={(discoverable) =>
                    void remote.setDiscoverable
                      .mutateAsync({ hostId: localHost.id, discoverable })
                      .catch((cause: unknown) =>
                        fail(
                          discoverable ? "Could not share host" : "Could not stop sharing host",
                          cause,
                        ),
                      )
                  }
                />
              }
            />
          ) : null}
        </SettingsSection>
      ) : null}

      <SettingsSection title="Account devices">
        <QueryRows
          query={devices.devicesQuery}
          loading="Loading devices…"
          failure="Could not load your devices."
          empty="No devices are registered on this account yet."
          count={devices.devices.length}
        >
          {devices.devices.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              busy={devices.revokeDevice.isPending}
              onRevoke={() => void revokeDevice(device)}
              onRevokeAccountSessions={() => void signOutDevice(device)}
            />
          ))}
        </QueryRows>
      </SettingsSection>

      <SettingsSection title="Active sessions">
        <QueryRows
          query={sessions.sessionsQuery}
          loading="Loading sessions…"
          failure="Could not load active sessions."
          empty="Nobody is connected to this machine right now."
          count={sessions.sessions.length}
        >
          {sessions.sessions.map((session) => {
            const device = devices.devices.find((entry) => entry.jkt === session.deviceJkt);
            return (
              <SessionRow
                key={session.id}
                session={session}
                userLabel={
                  account.me?.id === session.userId ? account.me.name : `User ${session.userId}`
                }
                deviceLabel={device?.displayName ?? "Unknown device"}
                busy={sessions.endSession.isPending}
                onEnd={() => void endSession(session)}
              />
            );
          })}
        </QueryRows>
      </SettingsSection>
    </div>
  );
}

function QueryRows({
  query,
  loading,
  failure,
  empty,
  count,
  children,
}: {
  query: { isPending: boolean; error: unknown };
  loading: string;
  failure: string;
  empty: string;
  count: number;
  children: ReactNode;
}) {
  if (query.isPending) return <SettingsListRow title={<Muted>{loading}</Muted>} />;
  if (query.error)
    return (
      <SettingsListRow
        title={<Muted>{failure}</Muted>}
        description={
          <span className="text-destructive">{accountErrorMessage(query.error, failure)}</span>
        }
      />
    );
  if (count === 0) return <SettingsListRow title={<Muted>{empty}</Muted>} />;
  return <>{children}</>;
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="font-normal text-muted-foreground">{children}</span>;
}
