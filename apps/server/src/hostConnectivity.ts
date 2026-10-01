import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { installCloudflared, CLOUDFLARED_VERSION } from "@synara/shared/cloudflared";
import { startCloudflareIngress } from "./cloudflare/ingress";
import { startCloudflareConnector } from "./cloudflare/connector";
import { startRemoteAuthorization } from "./cloudflare/authorization";
import { accountStateDirectory } from "./accountAuth";
import { createRemoteResourceGateway } from "./remoteTransport/resourceGateway";
import { requireRemoteConnections } from "./remoteFeaturePolicy";
import http from "node:http";
import { Effect } from "effect";
import type { AuthControlPlaneShape } from "./auth/Services/AuthControlPlane";
import type { RemoteDeviceTrustRepositoryShape } from "./persistence/Services/RemoteDeviceTrust";
import { acceptRemotePairing } from "./remotePairing/gateway";

import { createAccountClient } from "@synara/shared/account";
import WebSocket, { WebSocketServer } from "ws";
import {
  loadRemoteTlsIdentity,
  remoteTlsIdentityPath,
  remoteTlsAnchor,
} from "./remoteTransport/certificates";
import {
  RemoteTlsServer,
  REMOTE_INNER_RPC_PATH,
  REMOTE_INNER_PAIRING_PATH,
} from "./remoteTransport/tunnel";

import { EnvironmentId } from "@synara/contracts";
import {
  accountApiIssuer,
  readAccountFile,
  refreshHostRegistration,
  resolveEnvironmentId,
} from "./accountAuth";
import type { SessionCredentialServiceShape } from "./auth/Services/SessionCredentialService";
import type { ServerConfigShape } from "./config";
import { startEndpointReporter } from "./endpointReporter";
import { ApiJwksCache, HostMintService } from "./hostAuth";
import { mintHostProof, readHostIdentity } from "./hostIdentity";
import { MAX_WEBSOCKET_MESSAGE_BYTES } from "./nodeHttpServer";
import {
  bridgeRemoteSocketToLocalRpc,
  RemoteConnectionGateway,
  RemoteSessionRegistry,
  registerHostRemoteSocketAcceptor,
} from "./remoteSessions";

export interface HostConnectivityOptions {
  readonly config: ServerConfigShape;
  readonly connectorExecutable?: () => Promise<string>;
  readonly listeningPort: number;
  readonly localSessions: SessionCredentialServiceShape;
  readonly remoteSessions: RemoteSessionRegistry;
  readonly remoteTrust: RemoteDeviceTrustRepositoryShape;
  readonly authControlPlane: AuthControlPlaneShape;
}

export async function startHostConnectivity(
  options: HostConnectivityOptions,
): Promise<() => Promise<void>> {
  requireRemoteConnections(options.config.stateDir);
  const credentials = await readAccountFile(
    accountStateDirectory(options.config.baseDir, options.config.devUrl),
  );
  if (
    !credentials?.hostId ||
    !credentials.hostOwnerUserId ||
    !credentials.organizationId ||
    credentials.hostKeyGeneration === undefined
  ) {
    return async () => {};
  }
  const identity = await readHostIdentity(options.config.hostIdentityPath);
  if (!identity) return async () => {};
  const environmentId = await resolveEnvironmentId(options.config.baseDir, options.config.devUrl);
  // Startup cannot silently replace a missing root. Only local pairing initializes it.
  const tlsIdentity = await loadRemoteTlsIdentity(
    remoteTlsIdentityPath(options.config.secretsDir),
    environmentId,
  );
  const trustScope = {
    environmentId: EnvironmentId.makeUnsafe(environmentId),
    rootFingerprint: remoteTlsAnchor(tlsIdentity).rootFingerprint,
    accountAuthority: accountApiIssuer(credentials.accountUrl),
    userId: credentials.hostOwnerUserId,
    organizationId: credentials.organizationId,
  };
  let admissionAvailable = () => false;
  const authorizeDevice = async (userId: string, deviceJkt: string, generation?: number) => {
    if (!admissionAvailable())
      throw new Error("Remote authorization is unavailable; reconnect after account verification");
    if (userId !== trustScope.userId)
      throw new Error("Only the locally linked owner is authorized");
    const trusted = await Effect.runPromise(
      options.remoteTrust.authorize(trustScope, deviceJkt, generation),
    );
    if (!trusted) throw new Error("Device approval is missing or revoked on this host");
    return trusted.generation;
  };
  const client = createAccountClient({ baseUrl: credentials.accountUrl });
  const hostProof = () =>
    mintHostProof({
      identity,
      apiIssuer: accountApiIssuer(credentials.accountUrl),
      environmentId,
      hostId: credentials.hostId!,
      keyGeneration: credentials.hostKeyGeneration!,
    });
  const refreshAuthorization = async () => {
    const authorization = await client.getHostAuthorization(
      await hostProof(),
      credentials.hostId!,
      controller.signal,
    );
    for (const jkt of authorization.revokedDeviceJkts) {
      options.remoteSessions.closeDevice(jkt);
      await Effect.runPromise(
        options.remoteTrust.revoke(trustScope, jkt, new Date().toISOString()),
      );
      options.remoteSessions.closeDevice(jkt);
    }
    const pending = authorization.pendingRevocationDeviceJkts ?? [];
    if (pending.length) {
      // Acknowledgement follows the durable local tombstone. Failed delivery
      // remains pending in the account service.
      await client
        .acknowledgeDeviceRevocations(
          await hostProof(),
          credentials.hostId!,
          pending,
          controller.signal,
        )
        .catch(() => {});
    }
    return authorization;
  };
  const remoteSessions = options.remoteSessions;
  const apiJwks = new ApiJwksCache(() => client.getApiJwks());
  const mintService = new HostMintService({
    identity,
    apiIssuer: accountApiIssuer(credentials.accountUrl),
    environmentId,
    hostId: credentials.hostId,
    keyGeneration: credentials.hostKeyGeneration,
    ownerUserId: credentials.hostOwnerUserId,
    authorizeDevice,
    getApiJwks: () => apiJwks.get(),
    refreshApiJwksForUnknownKid: () => apiJwks.refreshForUnknownKid(),
  });
  const gateway = new RemoteConnectionGateway({
    mintService,
    identity,
    environmentId,
    keyGeneration: credentials.hostKeyGeneration,
    sessions: remoteSessions,
    authorizeDevice: async (userId, deviceJkt, generation) => {
      await authorizeDevice(userId, deviceJkt, generation);
    },
    bridgeToLocal: (socket, peer) =>
      bridgeRemoteSocketToLocalRpc(socket, peer, {
        listeningPort: options.listeningPort,
        sessions: options.localSessions,
        attachmentScope: {
          ...trustScope,
          deviceJkt: peer.deviceJkt,
          trustGeneration: peer.trustGeneration,
        },
      }),
  });
  const controller = new AbortController();
  const stops: Array<() => void | Promise<void>> = [];
  let finishSetup!: () => void;
  const setupDone = new Promise<void>((resolve) => {
    finishSetup = resolve;
  });
  let activeTunnelId: string | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    controller.abort();
    remoteSessions.closeAll();
    return (stopping ??= (async () => {
      // A revocation can arrive while a listener is still binding. Own all
      // resources acquired by that setup before declaring teardown complete.
      await setupDone;
      const results = await Promise.allSettled(
        stops.splice(0).map((cleanup) => Promise.resolve().then(cleanup)),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })());
  };
  try {
    const tunnel = new RemoteTlsServer({
      identity: tlsIdentity,
      request: createRemoteResourceGateway({
        identity,
        environmentId,
        keyGeneration: credentials.hostKeyGeneration,
        rootFingerprint: trustScope.rootFingerprint,
        listeningPort: options.listeningPort,
        localSessions: options.localSessions,
        sessions: remoteSessions,
        authorizeDevice: async (userId, jkt, generation) => {
          await authorizeDevice(userId, jkt, generation);
        },
      }),
      accept: (socket, path, ingress) => {
        if (!admissionAvailable()) {
          socket.close(1008, "Remote authorization unavailable");
          return;
        }
        if (path === REMOTE_INNER_PAIRING_PATH) {
          acceptRemotePairing(
            socket,
            trustScope,
            options.authControlPlane.remotePairing,
            options.remoteTrust,
          );
          return;
        }
        if (path !== REMOTE_INNER_RPC_PATH) {
          socket.close(1008, "Pairing unavailable");
          return;
        }
        return gateway.accept(socket, ingress.via);
      },
    });
    stops.push(() => tunnel.close());
    stops.push(
      options.remoteTrust.onRevoked((scope, jkt) => {
        if (
          scope.environmentId !== environmentId ||
          scope.rootFingerprint !== trustScope.rootFingerprint
        )
          return;
        if (jkt) remoteSessions.closeDevice(jkt);
        else {
          remoteSessions.closeAll("remote access disabled");
          tunnel.close();
          const disabling = hostProof()
            .then((proof) => client.disableRemoteTunnel(proof, credentials.hostId!, activeTunnelId))
            .catch(() => {});
          // Serialize retirement with a replacement root/host instance. When an
          // allocation is known, its ID also fences a delayed disable response.
          stops.push(() => disabling);
          void stop().catch(() =>
            console.warn("[synara] Remote connector cleanup could not be verified."),
          );
        }
      }),
    );
    const renewal = setInterval(() => {
      void loadRemoteTlsIdentity(remoteTlsIdentityPath(options.config.secretsDir), environmentId)
        .then((renewed) => {
          if (!controller.signal.aborted) tunnel.renew(renewed);
        })
        .catch(() => {
          console.warn("[synara] Remote TLS identity unavailable; local re-pair is required.");
          void stop().catch(() =>
            console.warn("[synara] Remote connector cleanup could not be verified."),
          );
        });
    }, 60 * 60_000);
    renewal.unref();
    stops.push(() => clearInterval(renewal));
    stops.push(registerHostRemoteSocketAcceptor((socket) => tunnel.accept(socket)));
    const expirySweep = setInterval(() => remoteSessions.dropExpired(), 30_000);
    expirySweep.unref();
    stops.push(() => clearInterval(expirySweep));

    stops.push(
      startEndpointReporter({
        report: () =>
          refreshHostRegistration({
            baseDir: options.config.baseDir,
            ...(options.config.devUrl ? { devUrl: options.config.devUrl } : {}),
            client,
          }),
      }),
    );

    const authorizationPoll = startRemoteAuthorization({
      signal: controller.signal,
      refresh: refreshAuthorization,
      apply: async (snapshot) => {
        await remoteSessions.reverify(snapshot);
      },
      unavailable: async (permanent) => {
        remoteSessions.closeAll("Remote authorization unavailable");
        if (permanent)
          await Effect.runPromise(
            options.remoteTrust.disable(trustScope, new Date().toISOString()),
          );
      },
    });
    admissionAvailable = authorizationPoll.available;
    stops.push(() => authorizationPoll.done);
    let connectorReady = false;
    const ingress = await startCloudflareIngress(
      tunnel,
      () => admissionAvailable() && connectorReady,
    );
    stops.push(ingress.close);
    const connectorHome = join(options.config.baseDir, "tools", "cloudflared", "home");
    await mkdir(connectorHome, { recursive: true, mode: 0o700 });
    const connectorConfig = join(connectorHome, "managed.yml");
    await writeFile(connectorConfig, "{}\n", { mode: 0o600 });
    let executable: Promise<string> | undefined;
    const connector = startCloudflareConnector({
      home: connectorHome,
      configurationFile: connectorConfig,
      signal: controller.signal,
      executable:
        options.connectorExecutable ??
        ((signal) =>
          (executable ??= process.env.SYNARA_CLOUDFLARED_PATH
            ? isAbsolute(process.env.SYNARA_CLOUDFLARED_PATH)
              ? Promise.resolve(process.env.SYNARA_CLOUDFLARED_PATH)
              : Promise.reject(new Error("The connector override must be an absolute path"))
            : installCloudflared(
                join(options.config.baseDir, "tools", "cloudflared", CLOUDFLARED_VERSION),
                process.platform,
                process.arch,
                signal,
              ).catch((error) => {
                executable = undefined;
                throw error;
              }))),
      token: async (signal) => {
        if (!admissionAvailable()) throw new Error("Remote authorization unavailable");
        const config = await client.provisionRemoteTunnel(
          await hostProof(),
          credentials.hostId!,
          ingress.port,
          signal,
        );
        if (controller.signal.aborted) throw new Error("Remote connector stopped");
        activeTunnelId = config.tunnelId;
        ingress.setHostname(config.hostname);
        return config.connectorToken;
      },
      ready: (ready) => {
        connectorReady = ready;
      },
    });
    stops.push(connector.stop);

    if (options.config.sshForwardPort !== undefined) {
      const server = http.createServer((_request, response) => {
        response.writeHead(426).end("WebSocket upgrade required");
      });
      const websocket = new WebSocketServer({
        server,
        maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
        perMessageDeflate: false,
      });
      websocket.on("connection", (socket) => tunnel.accept(socket, { via: "ssh-forward" }));
      stops.push(() => {
        for (const socket of websocket.clients) socket.terminate();
        websocket.close();
        server.close();
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(options.config.sshForwardPort, "127.0.0.1", () => {
          server.off("error", onError);
          resolve();
        });
      });
    }
    return stop;
  } catch (error) {
    finishSetup();
    await stop();
    throw error;
  } finally {
    finishSetup();
  }
}
