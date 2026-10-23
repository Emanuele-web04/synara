import http from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { generateDeviceKey, exportPublicJwk } from "@synara/shared/deviceKey";
import { initializeRemoteTlsIdentity, remoteTlsAnchor } from "../../remoteTransport/certificates";
import { RemoteTlsServer } from "../../remoteTransport/tunnel";
import { acceptRemotePairing } from "../../remotePairing/gateway";
import { pairRemoteHost } from "../../remotePairing/client";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  GRANT_JWT_TYP,
  HOST_CONNECT_SCOPE,
  SYNARA_RELAY_AUDIENCE,
  type RemotePairingDevice,
  type RemoteTrustScope,
} from "@synara/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { HostGrantVerifier } from "../../hostAuth/grantVerifier";
import { describe, expect, it, vi } from "vitest";
import { ServerConfig } from "../../config";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { RemoteDeviceTrustRepositoryLive } from "../../persistence/Layers/RemoteDeviceTrust";
import { RemoteDeviceTrustRepository } from "../../persistence/Services/RemoteDeviceTrust";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations";
import { AuthControlPlane } from "../Services/AuthControlPlane";
import { BootstrapCredentialService } from "../Services/BootstrapCredentialService";
import { AuthControlPlaneLive, AuthCoreLive } from "./AuthControlPlane";
import { ServerSecretStoreLive } from "./ServerSecretStore";

const scope: RemoteTrustScope = {
  environmentId: EnvironmentId.makeUnsafe("source-installation"),
  rootFingerprint: "a".repeat(64),
  accountAuthority: "https://accounts.example.test",
  userId: "owner",
  organizationId: "personal-org",
};

function layers(database = SqlitePersistenceMemory) {
  return Layer.mergeAll(
    AuthControlPlaneLive.pipe(Layer.provideMerge(AuthCoreLive)),
    RemoteDeviceTrustRepositoryLive,
  ).pipe(
    Layer.provideMerge(database),
    Layer.provide(ServerSecretStoreLive),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "synara-remote-trust-" })),
    Layer.provide(NodeServices.layer),
  );
}

async function device(): Promise<RemotePairingDevice> {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const publicKey = await exportJWK(keys.publicKey);
  return {
    deviceJkt: await calculateJwkThumbprint(publicKey),
    publicKey: publicKey as RemotePairingDevice["publicKey"],
    label: "Client laptop",
  };
}

describe("remote pairing through the durable auth control plane", () => {
  it("leaves publication headroom when the account API clock is 30 seconds behind", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* AuthControlPlane;
        const apiNow = Date.now() - 30_000;
        const invite = yield* control.remotePairing.create(scope);
        // The account API rejects any expiry more than ten minutes ahead of its clock.
        expect(Date.parse(invite.expiresAt)).toBeLessThanOrEqual(apiNow + 600_000);
        expect(Date.parse(invite.expiresAt)).toBeGreaterThan(Date.now());
        const verified = yield* control.remotePairing.verifyInvitation(
          scope,
          invite.inviteId,
          invite.secret,
        );
        expect(verified.expiresAt).toBe(invite.expiresAt);
      }).pipe(Effect.provide(layers())),
    );
  });

  it("an explicit identity reset revokes old devices and even unused invitations", async () => {
    const peer = await device();
    await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* AuthControlPlane;
        const trust = yield* RemoteDeviceTrustRepository;
        const invite = yield* control.remotePairing.create(scope);
        const unused = yield* control.remotePairing.create(scope);
        yield* control.remotePairing.requestApproval(scope, invite.inviteId, peer);
        expect(yield* control.remotePairing.approve(scope, invite.inviteId, peer.deviceJkt)).toBe(
          true,
        );
        yield* trust.resetEnvironment(scope.environmentId, new Date().toISOString());
        expect(yield* trust.authorize(scope, peer.deviceJkt)).toBeUndefined();
        expect(yield* control.remotePairing.approve(scope, invite.inviteId, peer.deviceJkt)).toBe(
          false,
        );
        expect(
          (yield* Effect.result(
            control.remotePairing.verifyInvitation(scope, unused.inviteId, unused.secret),
          ))._tag,
        ).toBe("Failure");
      }).pipe(Effect.provide(layers())),
    );
  });

  it("isolates the bootstrap purpose, requires exact-device approval and commits idempotently", async () => {
    const peer = await device();
    await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* AuthControlPlane;
        const bootstrap = yield* BootstrapCredentialService;
        const trust = yield* RemoteDeviceTrustRepository;
        const sql = yield* SqlClient.SqlClient;
        const invite = yield* control.remotePairing.create(scope);
        const stored = yield* sql<{
          credential: string;
        }>`SELECT credential FROM auth_pairing_links WHERE id = ${invite.inviteId}`;
        expect(stored[0]!.credential).not.toContain(invite.secret);
        expect(stored[0]!.credential).toMatch(/^[a-f0-9]{64}$/);
        expect(yield* bootstrap.listActive()).toEqual([]);
        for (const token of [invite.secret, stored[0]!.credential]) {
          expect((yield* Effect.result(bootstrap.consume(token)))._tag).toBe("Failure");
        }
        expect(yield* trust.authorize(scope, peer.deviceJkt)).toBeUndefined();
        yield* control.remotePairing.verifyInvitation(scope, invite.inviteId, invite.secret);
        expect(yield* control.remotePairing.requestApproval(scope, invite.inviteId, peer)).toBe(
          true,
        );
        expect(yield* control.remotePairing.approve(scope, invite.inviteId, "another-device")).toBe(
          false,
        );
        expect(yield* trust.authorize(scope, peer.deviceJkt)).toBeUndefined();
        expect(yield* control.remotePairing.approve(scope, invite.inviteId, peer.deviceJkt)).toBe(
          true,
        );
        const accepted = yield* trust.authorize(scope, peer.deviceJkt);
        expect(accepted?.generation).toBe(1);
        // A response lost after commit cannot enroll a second key or increment generation.
        expect(yield* control.remotePairing.approve(scope, invite.inviteId, peer.deviceJkt)).toBe(
          true,
        );
        expect((yield* trust.authorize(scope, peer.deviceJkt))?.generation).toBe(1);
        expect(
          yield* control.remotePairing.requestApproval(scope, invite.inviteId, {
            ...peer,
            deviceJkt: "new-key",
          }),
        ).toBe(false);
        const listed = yield* control.remotePairing.list(scope);
        expect(JSON.stringify(listed)).not.toContain(invite.secret);
        expect(JSON.stringify(listed)).not.toContain(stored[0]!.credential);
        expect(
          (yield* Effect.result(
            control.remotePairing.verifyInvitation(scope, invite.inviteId, "x".repeat(43)),
          ))._tag,
        ).toBe("Failure");
      }).pipe(Effect.provide(layers()), Effect.scoped),
    );
  });

  it("refuses expired, cancelled and imported invitations and trust", async () => {
    const peer = await device();
    await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* AuthControlPlane;
        const trust = yield* RemoteDeviceTrustRepository;
        const sql = yield* SqlClient.SqlClient;
        const expired = yield* control.remotePairing.create(scope);
        yield* sql`UPDATE auth_pairing_links SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ${expired.inviteId}`;
        expect(
          (yield* Effect.result(
            control.remotePairing.verifyInvitation(scope, expired.inviteId, expired.secret),
          ))._tag,
        ).toBe("Failure");
        expect(yield* control.remotePairing.requestApproval(scope, expired.inviteId, peer)).toBe(
          false,
        );
        const cancelled = yield* control.remotePairing.create(scope);
        yield* control.remotePairing.revoke(scope, cancelled.inviteId);
        expect(
          (yield* Effect.result(
            control.remotePairing.verifyInvitation(scope, cancelled.inviteId, cancelled.secret),
          ))._tag,
        ).toBe("Failure");
        const invite = yield* control.remotePairing.create(scope);
        yield* control.remotePairing.requestApproval(scope, invite.inviteId, peer);
        yield* control.remotePairing.approve(scope, invite.inviteId, peer.deviceJkt);
        for (const imported of [
          { ...scope, environmentId: EnvironmentId.makeUnsafe("beta-destination") },
          { ...scope, rootFingerprint: "b".repeat(64) },
          { ...scope, userId: "different-owner" },
        ]) {
          expect(yield* trust.authorize(imported, peer.deviceJkt)).toBeUndefined();
          expect(
            (yield* Effect.result(
              control.remotePairing.verifyInvitation(imported, invite.inviteId, invite.secret),
            ))._tag,
          ).toBe("Failure");
        }
      }).pipe(Effect.provide(layers()), Effect.scoped),
    );
  });

  it("keeps a revocation tombstone after database reopen and invalidates old generations after re-pair", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-trust-restart-"));
    const peer = await device();
    const database = () =>
      Layer.effectDiscard(runMigrations()).pipe(
        Layer.provideMerge(
          NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") }),
        ),
      );
    let inviteId = "";
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const control = yield* AuthControlPlane;
          const trust = yield* RemoteDeviceTrustRepository;
          const invite = yield* control.remotePairing.create(scope);
          inviteId = invite.inviteId;
          yield* control.remotePairing.requestApproval(scope, inviteId, peer);
          yield* control.remotePairing.approve(scope, inviteId, peer.deviceJkt);
          let notified = false;
          const unsubscribe = trust.onRevoked(() => {
            notified = true;
          });
          yield* trust.revoke(scope, peer.deviceJkt, new Date().toISOString());
          expect(notified).toBe(true);
          unsubscribe();
        }).pipe(Effect.provide(layers(database())), Effect.scoped),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const control = yield* AuthControlPlane;
          const trust = yield* RemoteDeviceTrustRepository;
          expect(yield* trust.authorize(scope, peer.deviceJkt)).toBeUndefined();
          expect(yield* trust.authorize(scope, "cloud-new-key")).toBeUndefined();
          expect(yield* control.remotePairing.approve(scope, inviteId, peer.deviceJkt)).toBe(false);
          expect((yield* trust.list(scope))[0]?.revokedAt).not.toBeNull();
          const fresh = yield* control.remotePairing.create(scope);
          yield* control.remotePairing.requestApproval(scope, fresh.inviteId, peer);
          yield* control.remotePairing.approve(scope, fresh.inviteId, peer.deviceJkt);
          expect(yield* trust.authorize(scope, peer.deviceJkt, 1)).toBeUndefined();
          expect((yield* trust.authorize(scope, peer.deviceJkt))?.generation).toBe(3);
        }).pipe(Effect.provide(layers(database())), Effect.scoped),
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it("pairs over TLS only after proof of the client key and explicit owner approval", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-pair-flow-"));
    try {
      const identity = await initializeRemoteTlsIdentity(
        path.join(directory, "tls.json"),
        scope.environmentId,
      );
      const anchor = remoteTlsAnchor(identity);
      const pairingScope = { ...scope, rootFingerprint: anchor.rootFingerprint };
      const key = await generateDeviceKey();
      const publicJwk = await exportPublicJwk(key);
      const deviceJkt = await calculateJwkThumbprint(publicJwk);
      await Effect.runPromise(
        Effect.gen(function* () {
          const control = yield* AuthControlPlane;
          const trust = yield* RemoteDeviceTrustRepository;
          const invitation = yield* control.remotePairing.create(pairingScope);
          yield* Effect.promise(async () => {
            const server = http.createServer((_request, response) => response.end("ok"));
            const websocket = new WebSocketServer({ server, perMessageDeflate: false });
            const tunnel = new RemoteTlsServer({
              identity,
              accept: (socket) =>
                acceptRemotePairing(socket, pairingScope, control.remotePairing, trust),
            });
            websocket.on("connection", (socket) => tunnel.accept(socket));
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const address = server.address() as { port: number };
            const hostId = "10000000-0000-4000-8000-000000000001";
            const abort = new AbortController();
            let pairing: Promise<void> | undefined;
            try {
              pairing = pairRemoteHost({
                host: {
                  id: hostId,
                  environmentId: scope.environmentId,
                  endpoints: [{ url: `http://127.0.0.1:${address.port}`, transport: "lan" }],
                },
                anchor,
                bundle: {
                  v: 2,
                  ...pairingScope,
                  ...anchor,
                  environmentId: scope.environmentId,
                  ...invitation,
                  hostId,
                  label: "Host",
                  channel: "dev",
                },
                identity: { userId: scope.userId, key, publicJwk },
                label: "Client laptop",
                signal: abort.signal,
                requestGrant: async () => "routing-only-grant",
              });
              // Observe the proof-driven request at the owner control plane before approving it.
              await vi.waitFor(async () => {
                const pending = await Effect.runPromise(control.remotePairing.list(pairingScope));
                expect(pending[0]?.pendingDevice?.deviceJkt).toBe(deviceJkt);
              });
              expect(
                await Effect.runPromise(trust.authorize(pairingScope, deviceJkt)),
              ).toBeUndefined();
              expect(
                await Effect.runPromise(
                  control.remotePairing.approve(pairingScope, invitation.inviteId, "wrong-key"),
                ),
              ).toBe(false);
              expect(
                await Effect.runPromise(
                  control.remotePairing.approve(pairingScope, invitation.inviteId, deviceJkt),
                ),
              ).toBe(true);
              await pairing;
              expect(
                (await Effect.runPromise(trust.authorize(pairingScope, deviceJkt)))?.generation,
              ).toBe(1);
            } finally {
              abort.abort();
              await pairing?.catch(() => {});
              tunnel.close();
              for (const socket of websocket.clients) socket.terminate();
              websocket.close();
              server.closeAllConnections();
              await new Promise<void>((resolve) => server.close(() => resolve()));
            }
          });
        }).pipe(Effect.provide(layers()), Effect.scoped),
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("pauses connections without forgetting devices and keeps the switch across approvals", async () => {
    const peer = await device();
    const other = await device();
    await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* AuthControlPlane;
        const trust = yield* RemoteDeviceTrustRepository;
        const invite = yield* control.remotePairing.create(scope);
        yield* control.remotePairing.requestApproval(scope, invite.inviteId, peer);
        yield* control.remotePairing.approve(scope, invite.inviteId, peer.deviceJkt);
        expect(yield* trust.allowsConnections(scope)).toBe(true);
        const closed: Array<string | undefined> = [];
        const unsubscribe = trust.onRevoked((_scope, jkt) => closed.push(jkt));
        yield* trust.setAllowConnections(scope, false);
        unsubscribe();
        expect(closed).toEqual([peer.deviceJkt]);
        expect(yield* trust.allowsConnections(scope)).toBe(false);
        expect(yield* trust.authorize(scope, peer.deviceJkt)).toBeUndefined();
        // A later approval must not silently turn the owner's switch back on.
        const second = yield* control.remotePairing.create(scope);
        yield* control.remotePairing.requestApproval(scope, second.inviteId, other);
        yield* control.remotePairing.approve(scope, second.inviteId, other.deviceJkt);
        expect(yield* trust.authorize(scope, other.deviceJkt)).toBeUndefined();
        const devices = yield* trust.list(scope);
        expect(devices.map((entry) => [entry.revokedAt, entry.enrolledVia])).toEqual([
          [null, "approval"],
          [null, "approval"],
        ]);
        yield* trust.setAllowConnections(scope, true);
        expect((yield* trust.authorize(scope, peer.deviceJkt))?.generation).toBe(1);
        yield* trust.markConnected(scope, peer.deviceJkt, "2026-10-06T12:00:00.000Z");
        expect(
          (yield* trust.list(scope)).find((entry) => entry.deviceJkt === peer.deviceJkt)
            ?.lastConnectedAt,
        ).toBe("2026-10-06T12:00:00.000Z");
      }).pipe(Effect.provide(layers()), Effect.scoped),
    );
  });

  describe("owner-grant pairing", () => {
    const hostId = "10000000-0000-4000-8000-000000000001";
    const apiIssuer = "https://accounts.example.test/api/v1";

    async function pairWithGrant(input: {
      grant: (deviceJkt: string, apiKey: CryptoKey) => Promise<string>;
      allowConnections?: boolean;
    }) {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-grant-pair-"));
      const identity = await initializeRemoteTlsIdentity(
        path.join(directory, "tls.json"),
        scope.environmentId,
      );
      const anchor = remoteTlsAnchor(identity);
      const pairingScope = { ...scope, rootFingerprint: anchor.rootFingerprint };
      const key = await generateDeviceKey();
      const publicJwk = await exportPublicJwk(key);
      const deviceJkt = await calculateJwkThumbprint(publicJwk);
      const api = await generateKeyPair("EdDSA", { extractable: true });
      const apiJwk = await exportJWK(api.publicKey);
      const grants = new HostGrantVerifier({
        apiIssuer,
        environmentId: scope.environmentId,
        hostId,
        ownerUserId: scope.userId,
        getApiJwks: async () => ({
          keys: [
            { kty: "OKP", crv: "Ed25519", x: apiJwk.x!, kid: "api-1", alg: "EdDSA", use: "sig" },
          ],
        }),
      });
      try {
        return await Effect.runPromise(
          Effect.gen(function* () {
            const control = yield* AuthControlPlane;
            const trust = yield* RemoteDeviceTrustRepository;
            if (input.allowConnections === false)
              yield* trust.setAllowConnections(pairingScope, false);
            const invitation = yield* control.remotePairing.create(pairingScope);
            return yield* Effect.promise(async () => {
              const server = http.createServer((_request, response) => response.end("ok"));
              const websocket = new WebSocketServer({ server, perMessageDeflate: false });
              const tunnel = new RemoteTlsServer({
                identity,
                accept: (socket) =>
                  acceptRemotePairing(socket, pairingScope, control.remotePairing, trust, grants),
              });
              websocket.on("connection", (socket) => tunnel.accept(socket));
              server.listen(0, "127.0.0.1");
              await once(server, "listening");
              const address = server.address() as { port: number };
              const abort = new AbortController();
              let routed = 0;
              let pairing: Promise<"approved" | Error> | undefined;
              try {
                pairing = pairRemoteHost({
                  host: {
                    id: hostId,
                    environmentId: scope.environmentId,
                    endpoints: [{ url: `http://127.0.0.1:${address.port}`, transport: "lan" }],
                  },
                  anchor,
                  bundle: {
                    v: 2,
                    ...pairingScope,
                    ...anchor,
                    environmentId: scope.environmentId,
                    ...invitation,
                    hostId,
                    label: "Host",
                    channel: "dev",
                  },
                  identity: { userId: scope.userId, key, publicJwk },
                  label: "Owner phone",
                  signal: abort.signal,
                  // The first grant only routes the channel; the next one rides in the proof.
                  requestGrant: async () =>
                    routed++ === 0 ? "routing-only-grant" : input.grant(deviceJkt, api.privateKey),
                }).then(
                  () => "approved" as const,
                  (error: Error) => error,
                );
                await vi.waitFor(async () => {
                  const pending = await Effect.runPromise(control.remotePairing.list(pairingScope));
                  expect(pending[0]?.pendingDevice?.deviceJkt).toBe(deviceJkt);
                });
                const outcome = await Promise.race([
                  pairing,
                  new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 300)),
                ]);
                return {
                  outcome,
                  devices: await Effect.runPromise(trust.list(pairingScope)),
                  authorized: await Effect.runPromise(trust.authorize(pairingScope, deviceJkt)),
                };
              } finally {
                abort.abort();
                await pairing;
                tunnel.close();
                for (const socket of websocket.clients) socket.terminate();
                websocket.close();
                server.closeAllConnections();
                await new Promise<void>((resolve) => server.close(() => resolve()));
              }
            });
          }).pipe(Effect.provide(layers()), Effect.scoped),
        );
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }

    const ownerGrant =
      (overrides: { jkt?: string; sub?: string } = {}) =>
      (deviceJkt: string, apiKey: CryptoKey) =>
        new SignJWT({
          hostId,
          environmentId: scope.environmentId,
          cnf: { jkt: overrides.jkt ?? deviceJkt },
          scope: [HOST_CONNECT_SCOPE],
        })
          .setProtectedHeader({ alg: "EdDSA", typ: GRANT_JWT_TYP, kid: "api-1" })
          .setIssuer(apiIssuer)
          .setSubject(overrides.sub ?? scope.userId)
          .setAudience(SYNARA_RELAY_AUDIENCE)
          .setIssuedAt()
          .setExpirationTime("60s")
          .setJti(crypto.randomUUID())
          .sign(apiKey);

    it("approves the owner's own device in one step", async () => {
      const result = await pairWithGrant({ grant: ownerGrant() });
      expect(result.outcome).toBe("approved");
      expect(result.authorized?.generation).toBe(1);
      expect(result.devices.map((entry) => entry.enrolledVia)).toEqual(["qr"]);
    });

    it.each([
      ["no grant", () => Promise.reject(new Error("grant unavailable"))],
      ["a grant for another key", ownerGrant({ jkt: "another-device" })],
      ["another account's grant", ownerGrant({ sub: "someone-else" })],
    ])("keeps owner approval for %s", async (_label, grant) => {
      const result = await pairWithGrant({ grant });
      expect(result.outcome).toBe("pending");
      expect(result.authorized).toBeUndefined();
      expect(result.devices).toEqual([]);
    });

    it("does not auto-approve while connections are off", async () => {
      const result = await pairWithGrant({ grant: ownerGrant(), allowConnections: false });
      expect(result.outcome).toBe("pending");
      expect(result.devices).toEqual([]);
    });
  });
});
