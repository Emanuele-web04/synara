import { EnvironmentId, type RemotePairingBundle } from "@synara/contracts";
import {
  accountApiIssuer,
  readAccountFile,
  resolveEnvironmentId,
} from "../../../server/src/accountAuth";
import {
  initializeRemoteTlsIdentity,
  remoteTlsIdentityPath,
  remoteTlsAnchor,
} from "../../../server/src/remoteTransport/certificates";
import { RemoteDeviceTrustRepositoryLive } from "../../../server/src/persistence/Layers/RemoteDeviceTrust";
import { RemoteDeviceTrustRepository } from "../../../server/src/persistence/Services/RemoteDeviceTrust";
import { AuthControlPlaneLive } from "../../../server/src/auth/Layers/AuthControlPlane";
import { AuthControlPlane } from "../../../server/src/auth/Services/AuthControlPlane";
import { BootstrapCredentialServiceLive } from "../../../server/src/auth/Layers/BootstrapCredentialService";
import http from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { NonNegativeInt, WS_METHODS, type HostSession } from "@synara/contracts";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { ServerSecretStoreLive } from "../../../server/src/auth/Layers/ServerSecretStore";
import { SessionCredentialServiceLive } from "../../../server/src/auth/Layers/SessionCredentialService";
import {
  AuthError,
  ServerAuth,
  type ServerAuthShape,
} from "../../../server/src/auth/Services/ServerAuth";
import { SessionCredentialService } from "../../../server/src/auth/Services/SessionCredentialService";
import { ServerConfig, type ServerConfigShape } from "../../../server/src/config";
import { startHostConnectivity } from "../../../server/src/hostConnectivity";
import { makeBoundedNodeHttpServer } from "../../../server/src/nodeHttpServer";
import { patchBunWebSocketCloseEventCompatibility } from "../../../server/src/bunWebSocketCompatibility";
import { SqlitePersistenceMemory } from "../../../server/src/persistence/Layers/Sqlite";
import { hostRemoteWebSocketRouteLayer } from "../../../server/src/remoteSessions";
import { RemoteSessionRegistry } from "../../../server/src/remoteSessions/sessionRegistry";
import { makeWebsocketRpcRouteLayer } from "../../../server/src/wsRpc";
import { makeHostsRpcHandlers } from "../../../server/src/wsHostsRpc";
import {
  makeWsConnectionSessions,
  provideWsConnectionSession,
  WsConnectionSessions,
} from "../../../server/src/wsConnectionSessions";
import type { HostsAccountSession } from "../../../server/src/accountSession";

const EchoRpc = Rpc.make("e2e.echo", {
  payload: Schema.Struct({ sequence: NonNegativeInt, payload: Schema.String }),
  success: Schema.Struct({ sequence: NonNegativeInt, payload: Schema.String }),
});
const EchoRpcGroup = RpcGroup.make(EchoRpc);

export interface RunningHost extends AsyncDisposable {
  readonly config: ServerConfigShape;
  readonly directUrl: string;
  createInvitation(): Promise<RemotePairingBundle>;
  approveInvitation(inviteId: string, deviceJkt: string): Promise<void>;
  revokeDevice(deviceJkt: string): Promise<void>;
  listSessions(): Promise<{ readonly sessions: readonly HostSession[] }>;
  endSession(sessionId: string): Promise<void>;
  dropExpiredSessions(nowSeconds?: number): void;
}

const OWNER_RPC_SESSION = {
  role: "owner" as const,
  attachmentPrincipal: { ownerKind: "session" as const, ownerId: "e2e-host-owner" },
};

/** Test-only JSON RPC serialization that makes the echo server preserve frame kind. */
export function makeFrameKindEchoRpcSerialization() {
  return {
    contentType: RpcSerialization.json.contentType,
    includesFraming: RpcSerialization.json.includesFraming,
    makeUnsafe: () => {
      const parser = RpcSerialization.json.makeUnsafe();
      const binaryRequests = new Set<string>();
      const encoder = new TextEncoder();
      return {
        decode: (data: Uint8Array | string) => {
          const messages = parser.decode(data);
          if (typeof data !== "string") {
            for (const message of messages) {
              if (
                message &&
                typeof message === "object" &&
                "_tag" in message &&
                message._tag === "Request" &&
                "id" in message &&
                typeof message.id === "string"
              ) {
                binaryRequests.add(message.id);
              }
            }
          }
          return messages;
        },
        encode: (response: unknown) => {
          const encoded = parser.encode(response);
          if (typeof encoded !== "string" || !response || typeof response !== "object") {
            return encoded;
          }
          if (!("requestId" in response) || typeof response.requestId !== "string") {
            return encoded;
          }
          const binary = binaryRequests.has(response.requestId);
          if ("_tag" in response && response._tag === "Exit") {
            binaryRequests.delete(response.requestId);
          }
          return binary ? encoder.encode(encoded) : encoded;
        },
      };
    },
  } satisfies RpcSerialization.RpcSerialization["Service"];
}

export async function startRealHost(input: {
  readonly baseDir: string;
  readonly connectorExecutable: string;
  readonly waitReady: () => Promise<void>;
}): Promise<RunningHost> {
  const baseConfigLayer = ServerConfig.layerTest(process.cwd(), input.baseDir).pipe(
    Layer.provide(NodeServices.layer),
  );
  const configLayer = Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return {
        ...config,
        authToken: "e2e-force-session-auth",
      } satisfies ServerConfigShape;
    }),
  ).pipe(Layer.provide(baseConfigLayer));
  const sessionsLayer = SessionCredentialServiceLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStoreLive),
    Layer.provide(configLayer),
    Layer.provide(NodeServices.layer),
  );
  const remoteManagementLayer = Layer.mergeAll(
    RemoteDeviceTrustRepositoryLive,
    AuthControlPlaneLive.pipe(Layer.provide(BootstrapCredentialServiceLive)),
  ).pipe(
    Layer.provide(sessionsLayer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(configLayer),
    Layer.provide(NodeServices.layer),
  );
  const serverAuthLayer = Layer.effect(
    ServerAuth,
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      return {
        authenticateWebSocketUpgrade: (request) => {
          const token = request.url?.searchParams.get("wsToken") ?? "";
          return sessions.verifyWebSocketToken(token).pipe(
            Effect.map((session) => ({
              sessionId: session.sessionId,
              subject: session.subject,
              method: session.method,
              role: session.role,
              ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
            })),
            Effect.mapError(
              (cause) => new AuthError({ message: "Unauthorized request.", status: 401, cause }),
            ),
          );
        },
        logoutSession: (sessionId) =>
          sessions
            .revoke(sessionId)
            .pipe(
              Effect.mapError(
                (cause) => new AuthError({ message: "Failed to log out session.", cause }),
              ),
            ),
      } as ServerAuthShape;
    }),
  ).pipe(Layer.provide(sessionsLayer));

  const serializationLayer = Layer.succeed(
    RpcSerialization.RpcSerialization,
    makeFrameKindEchoRpcSerialization(),
  );
  const handlers = EchoRpcGroup.toLayer(
    Effect.succeed({
      "e2e.echo": (payload: { readonly sequence: number; readonly payload: string }) =>
        Effect.succeed(payload),
    }),
  );
  const rpcSource = RpcServer.toHttpEffectWebsocket(EchoRpcGroup).pipe(
    Effect.provide(handlers.pipe(Layer.provideMerge(serializationLayer))),
  );
  const connectionSessions = await Effect.runPromise(makeWsConnectionSessions);
  const routes = Layer.mergeAll(
    makeWebsocketRpcRouteLayer(rpcSource),
    hostRemoteWebSocketRouteLayer,
  ).pipe(Layer.provide(Layer.succeed(WsConnectionSessions, connectionSessions)));

  const scope = await Effect.runPromise(Scope.make("sequential"));
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      Layer.mergeAll(
        configLayer,
        sessionsLayer,
        serverAuthLayer,
        remoteManagementLayer,
        NodeServices.layer,
      ),
      scope,
    ),
  );
  let nodeServer: http.Server | null = null;
  let stopConnectivity: (() => Promise<void>) | undefined;
  let closed = false;
  try {
    const started = await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          const sessions = yield* SessionCredentialService;
          patchBunWebSocketCloseEventCompatibility();
          const server = yield* makeBoundedNodeHttpServer(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          const httpApp = yield* HttpRouter.toHttpEffect(routes);
          yield* server.serve(httpApp);
          return {
            config,
            sessions,
            remoteTrust: yield* RemoteDeviceTrustRepository,
            authControlPlane: yield* AuthControlPlane,
          };
        }).pipe(Effect.provide(context)),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") throw new Error("real host did not bind TCP");
    const credentials = await readAccountFile(input.baseDir);
    if (!credentials?.hostId || !credentials.hostOwnerUserId || !credentials.organizationId)
      throw new Error("Missing linked owner");
    const environmentId = EnvironmentId.makeUnsafe(await resolveEnvironmentId(input.baseDir));
    // Explicit owner provisioning in this fixture, never automatic trust enrollment.
    const tlsIdentity = await initializeRemoteTlsIdentity(
      remoteTlsIdentityPath(started.config.secretsDir),
      environmentId,
    );
    const anchor = remoteTlsAnchor(tlsIdentity);
    const trustScope = {
      environmentId,
      rootFingerprint: anchor.rootFingerprint,
      accountAuthority: accountApiIssuer(credentials.accountUrl),
      userId: credentials.hostOwnerUserId,
      organizationId: credentials.organizationId,
    };
    const remoteSessions = new RemoteSessionRegistry();
    stopConnectivity = await startHostConnectivity({
      config: started.config,
      listeningPort: address.port,
      localSessions: started.sessions,
      remoteTrust: started.remoteTrust,
      authControlPlane: started.authControlPlane,
      remoteSessions,
      connectorExecutable: async () => input.connectorExecutable,
    });
    // The compact E2E host intentionally mounts only the echo RPC group. Drive
    // the production owner-guarded handlers directly so session visibility
    // exercises the same authorization boundary without pulling the complete
    // application RPC graph (and all of its unrelated services) into this host.
    const sessionHandlers = makeHostsRpcHandlers({
      remoteAccess: async () => {
        throw new Error("Pairing management is not mounted by the compact echo harness");
      },
      accountSession: {} as HostsAccountSession,
      remoteSessions,
      hostConnections: {
        connect: () => Promise.reject(new Error("not wired in the compact e2e host")),
        disconnect: () => Promise.resolve(),
        list: () => Promise.resolve({ connections: [] }),
      },
    });
    await input.waitReady();
    return {
      config: started.config,
      directUrl: `ws://127.0.0.1:${address.port}/ws/host/v2`,
      createInvitation: async () => ({
        v: 2,
        ...anchor,
        ...trustScope,
        ...(await Effect.runPromise(started.authControlPlane.remotePairing.create(trustScope))),
        channel: "dev",
        hostId: credentials.hostId!,
        label: "E2E host",
      }),
      approveInvitation: async (inviteId, deviceJkt) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (
            await Effect.runPromise(
              started.authControlPlane.remotePairing.approve(trustScope, inviteId, deviceJkt),
            )
          )
            return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("Exact device did not request owner approval");
      },
      revokeDevice: (jkt) =>
        Effect.runPromise(started.remoteTrust.revoke(trustScope, jkt, new Date().toISOString())),
      listSessions: () =>
        Effect.runPromise(
          provideWsConnectionSession(
            sessionHandlers[WS_METHODS.hostsListSessions](),
            OWNER_RPC_SESSION,
          ),
        ),
      endSession: (sessionId) =>
        Effect.runPromise(
          provideWsConnectionSession(
            sessionHandlers[WS_METHODS.hostsEndSession]({ sessionId }),
            OWNER_RPC_SESSION,
          ),
        ),
      dropExpiredSessions: (nowSeconds) => remoteSessions.dropExpired(nowSeconds),
      async [Symbol.asyncDispose]() {
        if (closed) return;
        closed = true;
        await stopConnectivity?.();
        await Effect.runPromise(Scope.close(scope, Exit.void));
      },
    };
  } catch (error) {
    await stopConnectivity?.();
    await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
    throw error;
  }
}
