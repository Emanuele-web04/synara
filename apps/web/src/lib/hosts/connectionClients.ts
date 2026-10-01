import { rememberVerifiedController } from "./controllerRecovery";
import {
  WS_METHODS,
  type ExecutionEnvironmentDescriptor,
  type HostConnection,
} from "@synara/contracts";
import { WsTransport, rawSocketUrl } from "../../wsTransport";
import { readActiveHost } from "./activeHost";
import { initializeExecutionContext } from "./executionContext";

let clients: { controller: WsTransport; execution: WsTransport } | undefined;
let generationChanged: (() => void) | undefined;
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
  if (!selected.executionScope)
    throw new Error(
      "Choose this host again from local Connections to verify its account and identity.",
    );
  const connection = await current.controller.request<HostConnection>(
    WS_METHODS.hostsConnect,
    { hostId: selected.hostId },
    { timeoutMs: 60_000 },
  );
  const scope = connection.executionScope;
  if (!scope || JSON.stringify(scope) !== JSON.stringify(selected.executionScope))
    throw new Error("The selected host or account changed. Return locally and select it again.");
  const url = new URL(rawSocketUrl(null));
  url.pathname = `${connection.wsPath}/ws`;
  const execution = new WsTransport(url.toString(), {
    onGenerationChanged: () => generationChanged?.(),
  });
  clients = { controller: current.controller, execution };
  // The descriptor comes through the authenticated real-host stream, not the directory.
  const remote = await execution.request<ExecutionEnvironmentDescriptor>(
    WS_METHODS.serverGetEnvironment,
  );
  if (remote.environmentId !== scope.environmentId) {
    await execution.dispose();
    throw new Error("The host reported a different execution identity");
  }
  initializeExecutionContext({
    controller: local,
    execution: remote,
    remote: scope,
    remoteHostId: selected.hostId,
  });
}
export async function disposeConnectionClients(): Promise<void> {
  const current = clients;
  clients = undefined;
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
