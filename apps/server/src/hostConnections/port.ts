import { RemoteHostTrustError } from "./failure";
import { RemoteResourcePool } from "./resourcePool";
// FILE: port.ts
// Purpose: The `hosts.connect` / `disconnect` / `listConnections` behaviour
//          behind the RPC handlers: look the host up in the directory, dial it
//          with this shell's device key, keep the session in the registry.
// Layer: server host connections

import type {
  AccountHost,
  HostConnection,
  RemoteExecutionScope,
  DesiredHostConnection,
} from "@synara/contracts";

import type { RemoteTlsAnchor } from "../remoteTransport/certificates";
import type { HostsAccountSession } from "../accountSession";
import { toAccountWsRpcError } from "../accountRpcErrors";
import { controllerProtocol, dialHost, HostDialError } from "./dialer";
import type { HostConnectionRegistry } from "./registry";

/** The outbound side: sessions THIS shell holds to other hosts. */
export interface HostConnectionsPort {
  connect(input: { readonly hostId: string }): Promise<HostConnection>;
  disconnect(input: { readonly hostId: string }): Promise<void>;
  list(): Promise<{
    readonly connections: readonly HostConnection[];
    readonly desiredHosts?: readonly DesiredHostConnection[];
  }>;
}

export interface HostConnectionsPortDeps {
  readonly accountSession: Pick<HostsAccountSession, "listHosts" | "requestGrant" | "dialIdentity">;
  readonly registry: HostConnectionRegistry;
  readonly setDesired: (hostId: string, desired: boolean) => Promise<void>;
  readonly listDesired: () => Promise<readonly DesiredHostConnection[]>;
  readonly readTrust: (
    host: AccountHost,
  ) => Promise<(RemoteTlsAnchor & { executionScope: RemoteExecutionScope }) | undefined>;
}

/** Turns a dial failure into the one sentence the row can show. */
function describeDialFailure(error: unknown): string {
  if (error instanceof HostDialError) {
    switch (error.detail.stage) {
      case "no-route":
        return error.message;
      case "grant":
        return `Could not get permission to connect: ${toAccountWsRpcError(error.cause, "the account service refused").message}`;
      case "unreachable": {
        const attempts = error.detail.race?.attempts ?? [];
        const tried = attempts.map((attempt) => `${attempt.candidate.kind}: ${attempt.status}`);
        return `${error.message}${tried.length > 0 ? ` (${tried.join(", ")})` : ""}`;
      }
      case "handshake":
        return `The host refused the session${error.detail.closeCode ? ` (close ${error.detail.closeCode})` : ""}: ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export function makeHostConnectionsPort(deps: HostConnectionsPortDeps): HostConnectionsPort {
  const pending = new Map<string, Promise<HostConnection>>();
  const revisions = new Map<string, number>();
  const writes = new Map<string, Promise<void>>();
  const setDesired = (hostId: string, desired: boolean) => {
    const previous = writes.get(hostId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => deps.setDesired(hostId, desired));
    writes.set(hostId, next);
    void next
      .finally(() => {
        if (writes.get(hostId) === next) writes.delete(hostId);
      })
      .catch(() => {});
    return next;
  };
  const connect = async (hostId: string): Promise<HostConnection> => {
    const revision = revisions.get(hostId) ?? 0;
    const generation = deps.registry.lifecycleGeneration;
    const checkCurrent = () => {
      if (
        (revisions.get(hostId) ?? 0) !== revision ||
        deps.registry.lifecycleGeneration !== generation
      )
        throw new Error("Remote connection cancelled by a controller state change");
    };
    const { hosts } = await deps.accountSession.listHosts();
    checkCurrent();
    const host = hosts.find((candidate) => candidate.id === hostId);
    if (!host) throw new RemoteHostTrustError("That host is not on your account");
    if (!host.linked)
      throw new RemoteHostTrustError("That host has not completed its key exchange yet");
    const anchor = await deps.readTrust(host);
    checkCurrent();
    if (!anchor) {
      deps.registry.remove(hostId);
      throw new RemoteHostTrustError("Pair this device on the host before connecting.");
    }
    const existing = deps.registry.get(hostId);
    if (
      existing?.state === "connected" &&
      JSON.stringify(existing.executionScope) === JSON.stringify(anchor.executionScope)
    )
      return existing;
    if (
      existing ||
      ["needs-sign-in", "revoked", "incompatible", "stopped"].includes(
        deps.registry.status(hostId).state,
      )
    )
      deps.registry.remove(hostId);
    await setDesired(hostId, true);
    checkCurrent();
    deps.registry.setConnector(
      hostId,
      host.name,
      async (client, signal) => {
        const fresh = (await deps.accountSession.listHosts()).hosts.find(
          (candidate) => candidate.id === hostId,
        );
        if (!fresh?.linked || fresh.environmentId !== host.environmentId)
          throw new RemoteHostTrustError("Remote host identity changed");
        const currentAnchor = await deps.readTrust(fresh);
        if (
          !currentAnchor ||
          currentAnchor.rootFingerprint !== anchor.rootFingerprint ||
          JSON.stringify(currentAnchor.executionScope) !== JSON.stringify(anchor.executionScope)
        )
          throw new RemoteHostTrustError("Remote trust changed. Pair this host again.");
        const identity = await deps.accountSession.dialIdentity();
        return dialHost({
          host: fresh,
          anchor: currentAnchor,
          identity,
          client,
          signal,
          requestGrant: async () => (await deps.accountSession.requestGrant({ hostId })).grant,
        });
      },
      anchor.executionScope,
    );
    deps.registry.setResourceFactory(hostId, async (session) => {
      const fresh = (await deps.accountSession.listHosts()).hosts.find(
        (candidate) => candidate.id === hostId,
      );
      if (!fresh?.linked || fresh.environmentId !== host.environmentId)
        throw new RemoteHostTrustError("Remote host identity changed");
      const currentAnchor = await deps.readTrust(fresh);
      if (
        !currentAnchor ||
        currentAnchor.rootFingerprint !== anchor.rootFingerprint ||
        JSON.stringify(currentAnchor.executionScope) !== JSON.stringify(anchor.executionScope)
      )
        throw new RemoteHostTrustError("Remote trust changed");
      return new RemoteResourcePool({
        host: fresh,
        anchor: currentAnchor,
        identity: await deps.accountSession.dialIdentity(),
        credential: session.credential,
        credentialExpiresAtSeconds: session.credentialExpiresAtSeconds,
        requestGrant: async () => (await deps.accountSession.requestGrant({ hostId })).grant,
      });
    });
    try {
      await deps.registry.probe(hostId, controllerProtocol);
      checkCurrent();
    } catch (error) {
      throw new Error(describeDialFailure(error), { cause: error });
    }
    const connection = deps.registry.get(hostId);
    if (!connection) throw new Error("Remote connection closed during startup");
    return connection;
  };
  return {
    connect({ hostId }) {
      const existing = pending.get(hostId);
      if (existing) return existing;
      const promise = connect(hostId);
      pending.set(hostId, promise);
      void promise
        .finally(() => {
          if (pending.get(hostId) === promise) pending.delete(hostId);
        })
        .catch(() => {});
      return promise;
    },
    async disconnect({ hostId }) {
      revisions.set(hostId, (revisions.get(hostId) ?? 0) + 1);
      pending.delete(hostId);
      deps.registry.remove(hostId);
      await setDesired(hostId, false);
    },
    async list() {
      return {
        connections: deps.registry.list(),
        desiredHosts: (await deps.listDesired()).map((host) => ({
          ...host,
          ...deps.registry.status(host.hostId),
        })),
      };
    },
  };
}
