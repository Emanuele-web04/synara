import { rememberVerifiedController } from "./controllerRecovery";
import {
  WS_METHODS,
  RemoteConnectionUnavailable,
  type AccountStatus,
  type ExecutionEnvironmentDescriptor,
  type HostConnection,
  type ListHostConnectionsResponse,
} from "@synara/contracts";
import { Schema } from "effect";
import { WsTransport, rawSocketUrl } from "../../wsTransport";
import { readActiveHost } from "./activeHost";
import { readWorkspaceFrame } from "./workspaceFrame";
import { initializeExecutionContext } from "./executionContext";

let clients: { controller: WsTransport; execution: WsTransport } | undefined;
let generationChanged: (() => void) | undefined;
let unregisterConnectionRecovery: (() => void) | undefined;
let bootstrapLifetime: AbortController | undefined;
export function setExecutionGenerationHandler(handler: () => void): void {
  generationChanged = handler;
}
export function getConnectionClients(): { controller: WsTransport; execution: WsTransport } {
  if (!clients) {
    const local = new WsTransport(undefined, {
      onGenerationChanged: () => {
        if (clients?.execution === local) generationChanged?.();
      },
    });
    clients = { controller: local, execution: local };
  }
  return clients;
}
export async function bootstrapExecutionContext(): Promise<void> {
  const current = getConnectionClients();
  const local = await current.controller.request<ExecutionEnvironmentDescriptor>(
    WS_METHODS.serverGetEnvironment,
  );
  rememberVerifiedController(local);
  const selected = readActiveHost();
  if (!selected) {
    initializeExecutionContext({ controller: local, execution: local, remote: null });
    return;
  }
  const selectedScope = selected.executionScope;
  if (!selectedScope)
    throw new Error(
      "Choose this host again from local Connections to verify its account and identity.",
    );
  const lifetime = new AbortController();
  bootstrapLifetime = lifetime;
  try {
    let execution: WsTransport | undefined;
    let recoveryVersion = 0;
    let resumeBootstrap: (() => void) | undefined;
    unregisterConnectionRecovery = readWorkspaceFrame()?.registerConnectionRecovery?.({
      resume: (options) => {
        if (lifetime.signal.aborted) return;
        recoveryVersion++;
        resumeBootstrap?.();
        execution?.resumeRemoteConnection(options);
      },
      dispose: () => {
        if (bootstrapLifetime === lifetime) void disposeConnectionClients();
      },
    });

    let connection: HostConnection;
    for (;;) {
      const attemptedRecoveryVersion = recoveryVersion;
      try {
        connection = await current.controller.request<HostConnection>(
          WS_METHODS.hostsConnect,
          { hostId: selected.hostId },
          { timeoutMs: 60_000, signal: lifetime.signal },
        );
        break;
      } catch (error) {
        lifetime.signal.throwIfAborted();
        if (attemptedRecoveryVersion !== recoveryVersion) continue;
        // RPC errors can contain provider text. Only authoritative controller state
        // may park this frame while its existing retry controls recover the same host.
        let response: ListHostConnectionsResponse;
        try {
          response = await current.controller.request<ListHostConnectionsResponse>(
            WS_METHODS.hostsListConnections,
            undefined,
            { signal: lifetime.signal },
          );
        } catch {
          lifetime.signal.throwIfAborted();
          throw error;
        }
        lifetime.signal.throwIfAborted();
        if (attemptedRecoveryVersion !== recoveryVersion) continue;
        const desired = response.desiredHosts?.find(
          (host) =>
            host.hostId === selected.hostId && host.environmentId === selectedScope.environmentId,
        );
        const connected = response.connections.find(
          (host) =>
            host.hostId === selected.hostId &&
            JSON.stringify(host.executionScope) === JSON.stringify(selectedScope),
        );
        if (
          !Schema.is(RemoteConnectionUnavailable)({
            code: "REMOTE_CONNECTION_REQUIRES_ATTENTION",
            state: desired?.state ?? connected?.state,
          })
        )
          throw error;
        let account: AccountStatus;
        try {
          account = await current.controller.request<AccountStatus>(
            WS_METHODS.accountStatus,
            undefined,
            { signal: lifetime.signal },
          );
        } catch {
          lifetime.signal.throwIfAborted();
          throw error;
        }
        lifetime.signal.throwIfAborted();
        if (
          account.state !== "signed-in" ||
          account.me.id !== selectedScope.userId ||
          account.me.organization.id !== selectedScope.organizationId ||
          account.accountAuthority !== selectedScope.accountAuthority
        )
          throw error;
        if (attemptedRecoveryVersion !== recoveryVersion) continue;
        await new Promise<void>((resolve, reject) => {
          const aborted = () => {
            resumeBootstrap = undefined;
            reject(lifetime.signal.reason);
          };
          lifetime.signal.addEventListener("abort", aborted, { once: true });
          resumeBootstrap = () => {
            lifetime.signal.removeEventListener("abort", aborted);
            resumeBootstrap = undefined;
            resolve();
          };
        });
      }
    }
    lifetime.signal.throwIfAborted();
    const scope = connection.executionScope;
    if (!scope || JSON.stringify(scope) !== JSON.stringify(selectedScope))
      throw new Error("The selected host or account changed. Return locally and select it again.");
    const url = new URL(rawSocketUrl(null));
    url.pathname = `${connection.wsPath}/ws`;
    execution = new WsTransport(url.toString(), {
      onGenerationChanged: () => generationChanged?.(),
    });
    clients = { controller: current.controller, execution };
    // The descriptor comes through the authenticated real-host stream, not the directory.
    // Wait outside each RPC's normal deadline only for an explicit terminal-state recovery.
    let remote: ExecutionEnvironmentDescriptor;
    for (;;) {
      try {
        remote = await execution.request<ExecutionEnvironmentDescriptor>(
          WS_METHODS.serverGetEnvironment,
          undefined,
          { signal: lifetime.signal },
        );
        break;
      } catch (error) {
        if (!(await execution.waitForRemoteConnectionRecovery(error))) throw error;
      }
    }
    lifetime.signal.throwIfAborted();
    if (remote.environmentId !== scope.environmentId)
      throw new Error("The host reported a different execution identity");
    initializeExecutionContext({
      controller: local,
      execution: remote,
      remote: scope,
      remoteHostId: selected.hostId,
    });
  } catch (error) {
    // A retired bootstrap may reject after a newer owner has already started.
    if (bootstrapLifetime === lifetime) await disposeConnectionClients();
    throw error;
  }
}
export async function disposeConnectionClients(): Promise<void> {
  const current = clients;
  clients = undefined;
  bootstrapLifetime?.abort(new Error("Transport disposed"));
  bootstrapLifetime = undefined;
  unregisterConnectionRecovery?.();
  unregisterConnectionRecovery = undefined;
  generationChanged = undefined;
  if (!current) return;
  await Promise.all(
    [...new Set([current.controller, current.execution])].map((client) => client.dispose()),
  );
}

/** Controller reconnects refetch account state without touching execution stores. */
export function onControllerStateChange(
  listener: Parameters<WsTransport["onStateChange"]>[0],
): () => void {
  return getConnectionClients().controller.onStateChange(listener, { replayCurrent: true });
}
