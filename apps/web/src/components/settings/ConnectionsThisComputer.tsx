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

import { useTranslation } from "~/i18n";

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
import { RotateCcwIcon } from "~/lib/icons";
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
  const { t } = useTranslation();
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
      enabled
        ? t("settings:remote_connections_allow_failed")
        : t("settings:remote_connections_disable_failed"),
    );
    setAllowOverride(null);
  };

  const revoke = async (device: RemoteTrustedDevice) => {
    if (
      !(await confirmAction(
        t("settings:remote_connections_revoke_access_confirm", {
          label: device.label,
          computer: computerNoun,
        }),
      ))
    )
      return;
    await perform(
      { operation: "revoke-device", deviceJkt: device.deviceJkt },
      t("settings:remote_connections_revoke_access_failed"),
    );
  };

  const repair = async () => {
    const local = readExecutionContext()?.controller;
    if (
      !local ||
      !(await confirmAction(
        t("settings:remote_connections_repair_confirm", { computer: computerNoun }),
      ))
    )
      return;
    await perform(
      { operation: "reset-identity", environmentId: local.environmentId },
      t("settings:remote_connections_repair_failed"),
    );
  };

  const devices = activeTrustedDevices(state);
  const pending = pendingApprovals(state, Date.now());
  const allowChecked = allowOverride ?? allowConnections ?? true;

  return (
    <>
      <SettingsSectionShell
        title={t("settings:remote_connections_devices_control_this", { computer: computerNoun })}
        action={
          <div className="flex items-center gap-1.5">
            <IconButton
              label={t("chat:list_refreshAriaLabel")}
              variant="ghost"
              onClick={() => void refresh()}
            >
              <RotateCcwIcon className="size-3.5" />
            </IconButton>
            <Button size="xs" shape="capsule" onClick={() => setDialog("add")}>
              {t("workspace:models_add")}
            </Button>
          </div>
        }
      >
        <SettingsCard>
          <SettingsListRow
            title={t("settings:remote_connections_allow_connections")}
            description={
              allowChecked ? undefined : t("settings:remote_connections_connections_disabled")
            }
            actions={
              <Switch
                checked={allowChecked}
                disabled={busy || state === null}
                aria-label={t("settings:remote_connections_allow_connections")}
                onCheckedChange={(next) => void setAllow(next)}
              />
            }
          />
          {pending.length > 0 ? (
            <SettingsListRow
              title={
                pending.length === 1
                  ? t("settings:remote_connections_device_waiting", {
                      device: pending[0]!.pendingDevice.label,
                    })
                  : t("settings:remote_connections_devices_waiting", { count: pending.length })
              }
              actions={
                <Button
                  size="xs"
                  shape="capsule"
                  variant="subtle"
                  onClick={() => setDialog("review")}
                >
                  {t("chat:review")}
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
              title={
                <span className="font-normal text-muted-foreground">
                  {t("settings:remote_connections_no_devices")}
                </span>
              }
              description={t("settings:remote_connections_add_phone_control", {
                computer: computerNoun,
              })}
            />
          ) : null}
          {state?.rootNeedsRepair ? (
            <SettingsListRow
              title={t("settings:remote_connections_repair_needed")}
              description={t("settings:remote_connections_repair_description")}
              actions={
                <Button
                  size="xs"
                  shape="capsule"
                  variant="subtle"
                  disabled={busy}
                  onClick={() => void repair()}
                >
                  {t("git:repair")}
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
        <SettingsSection title={t("settings:remote_connections_other_settings")}>
          <SettingsListRow
            title={t("settings:remote_connections_keep_awake", { computer: computerNoun })}
            description={
              keepAwake.state.enabled && keepAwake.state.onBattery
                ? t("settings:remote_connections_battery_paused")
                : t("settings:remote_connections_prevent_sleep")
            }
            actions={
              <Switch
                checked={keepAwake.state.enabled}
                aria-label={t("settings:remote_connections_keep_awake", { computer: computerNoun })}
                onCheckedChange={(next) =>
                  void keepAwake.setEnabled(next).catch((cause: unknown) =>
                    toastManager.add({
                      type: "error",
                      title: t("settings:remote_connections_keep_awake_failed"),
                      description: remoteAccessErrorMessage(cause, t("chat:tryAgain")),
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
          {t("settings:nav_advanced")}
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
        computerNoun={computerNoun}
      />
    </>
  );
}

/** The account-level view: this machine's link, signed-in devices, and live sessions. */
function AccountAdvanced() {
  const { t } = useTranslation();
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
      description: accountErrorMessage(cause, t("chat:tryAgainInAMoment")),
    });

  const unlink = async () => {
    if (!(await confirmAction(t("settings:remote_connections_unlink_confirm")))) return;
    try {
      await remote.unlinkLocalHost.mutateAsync();
      toastManager.add({
        type: "success",
        title: t("settings:remote_connections_machine_unlinked"),
        description: t("settings:remote_connections_machine_unlinked_description"),
      });
    } catch (cause) {
      fail(t("settings:remote_connections_unlink_failed"), cause);
    }
  };

  const revokeDevice = async (device: AccountDevice) => {
    if (
      !(await confirmAction(
        t("settings:remote_connections_revoke_device_confirm", { device: device.displayName }),
      ))
    )
      return;
    try {
      await devices.revokeDevice.mutateAsync({ deviceId: device.id });
      toastManager.add({
        type: "success",
        title: t("settings:remote_connections_device_revoked"),
        description: t("settings:remote_connections_device_revoked_description"),
      });
    } catch (cause) {
      fail(t("settings:remote_connections_revoke_device_failed"), cause);
    }
  };

  const signOutDevice = async (device: AccountDevice) => {
    if (
      !(await confirmAction(
        t("settings:remote_connections_sign_out_device_confirm", { device: device.displayName }),
      ))
    )
      return;
    try {
      const result = await readHostsApi()?.remoteAccess?.({
        operation: "revoke-account-sessions",
        deviceId: device.id,
      });
      if (result?.kind !== "account-sessions-revoked")
        throw new Error(t("settings:remote_connections_session_revocation_unavailable"));
      toastManager.add({
        type: result.pending ? "warning" : "success",
        title: result.pending
          ? t("settings:remote_connections_sign_out_pending")
          : t("settings:remote_connections_account_sessions_signed_out"),
        description: result.pending
          ? t("settings:remote_connections_sign_out_results_pending", {
              confirmed: result.confirmed,
              pending: result.pending,
            })
          : t("settings:remote_connections_sign_out_results_complete", {
              confirmed: result.confirmed,
              pending: result.pending,
            }),
      });
    } catch (cause) {
      fail(t("settings:remote_connections_sign_out_sessions_failed"), cause);
    }
  };

  const endSession = async (session: HostSession) => {
    if (
      !(await confirmAction(
        t("settings:remote_connections_end_session_confirm", { user: session.userId }),
      ))
    )
      return;
    try {
      await sessions.endSession.mutateAsync({ sessionId: session.id });
      toastManager.add({
        type: "success",
        title: t("settings:remote_connections_session_ended"),
        description: t("settings:remote_connections_session_closed"),
      });
    } catch (cause) {
      fail(t("settings:remote_connections_end_session_failed"), cause);
    }
  };

  return (
    <div className="pt-1">
      {remote.enrollment?.host ? (
        <SettingsSection title={t("settings:remote_connections_machine_on_account")}>
          <SettingsListRow
            title={remote.enrollment.host.name}
            description={t("settings:remote_connections_sign_out_unlinks")}
            actions={
              <Button
                size="xs"
                shape="capsule"
                variant="destructive-outline"
                disabled={remote.unlinkLocalHost.isPending}
                onClick={() => void unlink()}
              >
                {remote.unlinkLocalHost.isPending
                  ? t("settings:remote_connections_unlinking")
                  : t("common:unlink")}
              </Button>
            }
          />
          {localHost && remote.canManageHost(localHost) ? (
            <SettingsListRow
              title={t("settings:remote_connections_share_workspace")}
              description={t("settings:remote_connections_share_workspace_description")}
              actions={
                <Switch
                  checked={localHost.discoverable}
                  disabled={remote.setDiscoverable.isPending}
                  aria-label={t("settings:remote_connections_share_workspace_aria")}
                  onCheckedChange={(discoverable) =>
                    void remote.setDiscoverable
                      .mutateAsync({ hostId: localHost.id, discoverable })
                      .catch((cause: unknown) =>
                        fail(
                          discoverable
                            ? t("settings:remote_connections_share_failed")
                            : t("settings:remote_connections_stop_sharing_failed"),
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

      <SettingsSection title={t("settings:remote_connections_account_devices")}>
        <QueryRows
          query={devices.devicesQuery}
          loading={t("settings:remote_connections_loading_devices")}
          failure={t("settings:remote_connections_load_devices_failed")}
          empty={t("settings:remote_connections_no_account_devices")}
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

      <SettingsSection title={t("settings:remote_connections_active_sessions")}>
        <QueryRows
          query={sessions.sessionsQuery}
          loading={t("settings:remote_connections_loading_sessions")}
          failure={t("settings:remote_connections_load_sessions_failed")}
          empty={t("settings:remote_connections_no_active_sessions")}
          count={sessions.sessions.length}
        >
          {sessions.sessions.map((session) => {
            const device = devices.devices.find((entry) => entry.jkt === session.deviceJkt);
            return (
              <SessionRow
                key={session.id}
                session={session}
                userLabel={
                  account.me?.id === session.userId
                    ? account.me.name
                    : t("settings:remote_connections_user_label", { user: session.userId })
                }
                deviceLabel={device?.displayName ?? t("settings:remote_connections_unknown_device")}
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
