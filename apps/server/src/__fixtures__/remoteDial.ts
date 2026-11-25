import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  EnvironmentId,
  GRANT_JWT_TYP,
  HOST_CONNECT_SCOPE,
  SYNARA_RELAY_AUDIENCE,
  type AccountHost,
} from "@synara/contracts";
import { exportPublicJwk, generateDeviceKey } from "@synara/shared/deviceKey";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { vi } from "vitest";
import { WebSocketServer } from "ws";
import { initializeRemoteTlsIdentity, remoteTlsAnchor } from "../remoteTransport/certificates";
import { RemoteTlsServer } from "../remoteTransport/tunnel";
import { generateAndPersistHostIdentity } from "../hostIdentity";
import { HostMintService } from "../hostAuth";
import { RemoteConnectionGateway } from "../remoteSessions/gateway";
import { RemoteSessionRegistry } from "../remoteSessions/sessionRegistry";
import { createRemoteResourceGateway } from "../remoteTransport/resourceGateway";
import type { SessionCredentialServiceShape } from "../auth/Services/SessionCredentialService";

const environmentId = EnvironmentId.makeUnsafe("test-environment");
const hostId = "2f1f9dd7-56a5-45cf-b847-12e6658f3720";
const issuer = "https://fixture-account.test";

export async function createRemoteDialFixture(
  cleanups: Array<() => Promise<void> | void>,
  approved = true,
  resources?: { listeningPort: number; localSessions: SessionCredentialServiceShape },
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-dial-v2-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const tlsIdentity = await initializeRemoteTlsIdentity(
    path.join(directory, "tls.json"),
    environmentId,
  );
  const hostIdentity = await generateAndPersistHostIdentity(path.join(directory, "host.json"));
  const signing = await generateKeyPair("EdDSA", { extractable: true });
  const publicApi = await exportJWK(signing.publicKey);
  const key = await generateDeviceKey();
  const publicJwk = await exportPublicJwk(key);
  const deviceJkt = await calculateJwkThumbprint(publicJwk);
  const authorize = vi.fn(async () => {
    if (!approved) throw new Error("No local approval");
    return 1;
  });
  const mint = new HostMintService({
    identity: hostIdentity,
    apiIssuer: issuer,
    environmentId,
    hostId,
    keyGeneration: 1,
    ownerUserId: "owner",
    authorizeDevice: authorize,
    getApiJwks: async () => ({
      keys: [
        { kty: "OKP", crv: "Ed25519", x: publicApi.x!, kid: "fixture", alg: "EdDSA", use: "sig" },
      ],
    }),
  });
  const sessions = new RemoteSessionRegistry();
  const gateway = new RemoteConnectionGateway({
    mintService: mint,
    identity: hostIdentity,
    environmentId,
    keyGeneration: 1,
    sessions,
    authorizeDevice: async (_user, _jkt, generation) => {
      if (generation !== (await authorize())) throw new Error("Revoked generation");
    },
    bridgeToLocal: async (socket) => {
      socket.on("message", (data, binary) =>
        socket.send(binary ? Buffer.from(data as Buffer) : data.toString()),
      );
    },
  });
  const tunnel = new RemoteTlsServer({
    identity: tlsIdentity,
    accept: (socket) => gateway.accept(socket),
    ...(resources
      ? {
          request: createRemoteResourceGateway({
            ...resources,
            identity: hostIdentity,
            environmentId,
            keyGeneration: 1,
            rootFingerprint: remoteTlsAnchor(tlsIdentity).rootFingerprint,
            sessions,
            authorizeDevice: async (_user, _jkt, generation) => {
              if (generation !== (await authorize())) throw new Error("Revoked generation");
            },
          }),
        }
      : {}),
  });
  const server = http.createServer((_request, response) => response.end("ok"));
  const websocket = new WebSocketServer({
    server,
    perMessageDeflate: false,
    maxPayload: 2 * 1024 * 1024,
  });
  websocket.on("connection", (socket) => tunnel.accept(socket));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    sessions.closeAll();
    tunnel.close();
    for (const socket of websocket.clients) socket.terminate();
    websocket.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP");
  const host: Pick<AccountHost, "id" | "environmentId" | "endpoints"> = {
    id: hostId,
    environmentId,
    endpoints: [{ url: `http://127.0.0.1:${address.port}`, transport: "tailscale" }],
  };
  const requestGrant = vi.fn(async () =>
    new SignJWT({ hostId, environmentId, cnf: { jkt: deviceJkt }, scope: [HOST_CONNECT_SCOPE] })
      .setProtectedHeader({ typ: GRANT_JWT_TYP, alg: "EdDSA", kid: "fixture" })
      .setIssuer(issuer)
      .setSubject("owner")
      .setAudience(SYNARA_RELAY_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("60s")
      .setJti(randomUUID())
      .sign(signing.privateKey),
  );
  return {
    directory,
    host,
    anchor: remoteTlsAnchor(tlsIdentity),
    identity: { userId: "owner", key, publicJwk },
    requestGrant,
    authorize,
    sessions,
    tunnel,
    deviceJkt,
  };
}
