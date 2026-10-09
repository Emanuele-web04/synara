// FILE: ConnectionsOtherComputers.tsx
// Purpose: "Control other devices" — confirmed pairings on this controller,
//          the window's current destination, and adding a computer.
// Layer: Settings UI components
// Exports: ConnectionsOtherComputers

import type { AccountHost } from "@synara/contracts";
import { useCallback, useState } from "react";

import { useHostConnections, useHosts } from "~/hooks/useHosts";
import { accountErrorMessage } from "~/lib/accountLogic";
import { activateHost, deactivateHost, readActiveHost } from "~/lib/hosts/activeHost";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { readHostsApi } from "~/lib/hosts/api";
import { HostsUnsupportedError } from "~/lib/hosts/queries";
import type { HostReachability } from "~/lib/hosts/reachability";
import { callRemoteAccess } from "~/lib/hosts/remoteAccess";
import { prepareWorkspaceSessionRemoval } from "~/lib/hosts/workspaceSessions";
import { AddPlusIcon, RotateCcwIcon } from "~/lib/icons";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { HostConnectionControl } from "../hosts/HostConnectionControl";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { toastManager } from "../ui/toast";
import { ConnectionsAddComputerDialog } from "./ConnectionsAddComputerDialog";
import { HostRow } from "./ConnectionsRows";
import { SettingsCard, SettingsListRow, SettingsSectionShell } from "./SettingsPanelPrimitives";

/** Rendered only when signed in with remote connections available. */
export function ConnectionsOtherComputers() {
  const remote = useHosts({ enabled: true });
  const connections = useHostConnections({ enabled: true });
  const activeHost = readActiveHost();
  const [addOpen, setAddOpen] = useState(false);
  // Reachability is attempt-based (ADR 0010): the map holds what the LAST
  // probe said, per host, and a host nobody probed simply is not in it.
  const [reachability, setReachability] = useState<Readonly<Record<string, HostReachability>>>({});
  const check = readHostsApi()?.checkReachability;

  const refresh = () => {
    void remote.hostsQuery.refetch();
    void remote.enrollmentQuery.refetch();
    void connections.connectionsQuery.refetch();
  };

  const probeHost = useCallback(
    async (host: AccountHost) => {
      if (!check) return;
      setReachability((current) => ({ ...current, [host.id]: { state: "probing" } }));
      try {
        const result = await check({ hostId: host.id });
        setReachability((current) => ({ ...current, [host.id]: result }));
      } catch {
        setReachability((current) => ({
          ...current,
          [host.id]: { state: "no-answer", at: Date.now() },
        }));
      }
    },
    [check],
  );

  const fail = (title: string, cause: unknown, fallback = "Try again in a moment.") =>
    toastManager.add({ type: "error", title, description: accountErrorMessage(cause, fallback) });

  /** Open a session to the host and add its projects alongside the local workspace. */
  const connectToHost = async (host: AccountHost) => {
    try {
      const connection = await connections.connect.mutateAsync({ hostId: host.id });
      await activateHost({
        ...(connection.executionScope ? { executionScope: connection.executionScope } : {}),
        hostId: connection.hostId,
        hostName: connection.hostName,
        wsPath: connection.wsPath,
      });
    } catch (cause) {
      fail(
        `Could not connect to ${host.name}`,
        cause,
        "Check that the host is online and try again.",
      );
    }
  };

  const closeHost = async (hostId: string, close: () => Promise<unknown>, failure: string) => {
    let removal: ReturnType<typeof prepareWorkspaceSessionRemoval>;
    try {
      removal = prepareWorkspaceSessionRemoval(hostId);
    } catch (cause) {
      fail(
        "Could not preserve editor drafts",
        cause,
        "Copy or export unsaved text before disconnecting this computer.",
      );
      return;
    }
    try {
      const persisted = await removal.close(close);
      if (!persisted)
        toastManager.add({
          type: "warning",
          title: "Connection closed",
          description: "This window could not update its saved computer list.",
        });
    } catch (cause) {
      fail(failure, cause);
      return;
    }
    refresh();
  };

  const disconnectFromHost = (hostId: string) =>
    closeHost(hostId, () => connections.disconnect.mutateAsync({ hostId }), "Could not disconnect");

  const forgetHost = async (host: AccountHost) => {
    const confirmed = await (readNativeApi() ?? ensureNativeApi()).dialogs.confirm(
      `Forget the pairing with ${host.name}? Active connections close, and you need a new code from it to connect again.`,
    );
    if (!confirmed) return;
    await closeHost(
      host.id,
      () => callRemoteAccess({ operation: "forget-host", environmentId: host.environmentId }),
      `Could not forget ${host.name}`,
    );
  };

  const hostsError = remote.hostsQuery.error ?? connections.connectionsQuery.error;
  const localHostId = remote.enrollment?.host?.id;
  const localEnvironmentId = readExecutionContext()?.controller.environmentId;
  // Account registration is not pairing. Only show identities trusted by this
  // controller; never collapse independent installations by their display name.
  const pairedHosts = connections.pairedHosts;
  const hosts = remote.hosts.filter(
    (host) =>
      host.id !== localHostId &&
      host.environmentId !== localEnvironmentId &&
      pairedHosts?.some(
        (paired) => paired.hostId === host.id && paired.environmentId === host.environmentId,
      ),
  );

  return (
    <>
      <SettingsSectionShell
        title="Computers you can control"
        action={
          <div className="flex items-center gap-1.5">
            <IconButton label="Refresh" variant="ghost" onClick={refresh}>
              <RotateCcwIcon className="size-3.5" />
            </IconButton>
            <Button size="xs" shape="capsule" onClick={() => setAddOpen(true)}>
              <AddPlusIcon className="size-3.5" />
              Add
            </Button>
          </div>
        }
      >
        <SettingsCard>
          {remote.hostsQuery.isPending || connections.connectionsQuery.isPending ? (
            <SettingsListRow title={<Muted>Loading computers…</Muted>} />
          ) : hostsError ? (
            <SettingsListRow
              title="Computers unavailable"
              description={
                <span className="text-destructive">
                  {hostsError instanceof HostsUnsupportedError
                    ? "This Synara server is too old to manage hosts. Update it and try again."
                    : accountErrorMessage(hostsError, "Could not load your computers.")}
                </span>
              }
            />
          ) : pairedHosts === undefined ? (
            <SettingsListRow
              title="Update Synara on this computer"
              description="Update and restart the app to list your paired computers."
            />
          ) : hosts.length === 0 ? (
            <SettingsListRow
              title={<Muted>No other computers yet</Muted>}
              description="Click Add and enter a pairing code from the other computer."
            />
          ) : (
            hosts.map((host) => {
              const connection = connections.connections.find((entry) => entry.hostId === host.id);
              return (
                <HostRow
                  key={host.id}
                  host={host}
                  reachability={reachability[host.id] ?? { state: "unknown" }}
                  busy={remote.setDiscoverable.isPending}
                  connection={
                    connection
                      ? {
                          kind: "connected",
                          transport: connection.transport,
                          active: activeHost?.hostId === host.id,
                          busy: connections.disconnect.isPending,
                        }
                      : { kind: "disconnected", busy: connections.connect.isPending }
                  }
                  {...(check ? { onProbe: () => void probeHost(host) } : {})}
                  onToggleDiscoverable={(discoverable) =>
                    void remote.setDiscoverable
                      .mutateAsync({ hostId: host.id, discoverable })
                      .catch((cause: unknown) =>
                        fail(
                          discoverable ? "Could not share host" : "Could not stop sharing host",
                          cause,
                        ),
                      )
                  }
                  onConnect={() => void connectToHost(host)}
                  onDisconnect={() => void disconnectFromHost(host.id)}
                  onActivate={() => void connectToHost(host)}
                  onDeactivate={() => deactivateHost()}
                  onForget={() => void forgetHost(host)}
                />
              );
            })
          )}
        </SettingsCard>
      </SettingsSectionShell>

      <SettingsSectionShell title="This window">
        <SettingsCard className="p-1">
          <HostConnectionControl />
        </SettingsCard>
      </SettingsSectionShell>

      <ConnectionsAddComputerDialog open={addOpen} onOpenChange={setAddOpen} onPaired={refresh} />
    </>
  );
}

function Muted({ children }: { children: string }) {
  return <span className="font-normal text-muted-foreground">{children}</span>;
}
