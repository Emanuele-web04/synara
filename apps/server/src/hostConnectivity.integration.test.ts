import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { EnvironmentId, HOST_PROOF_JWT_TYP, type AccountHost } from "@synara/contracts";
import type { AccountClient } from "@synara/shared/account";
import { SYNARA_REMOTE_BUNDLE_ID } from "@synara/shared/desktopIdentity";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { importSPKI, jwtVerify } from "jose";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  accountApiIssuer,
  readAccountFile,
  runAuthLogin,
  writeAccountCredentials,
} from "./accountAuth";
import { generateAndPersistHostIdentity, readHostIdentity } from "./hostIdentity";
import { ServerConfig } from "./config";
import { startHostConnectivity, type HostConnectivityOptions } from "./hostConnectivity";
import { RemoteSessionRegistry } from "./remoteSessions/sessionRegistry";
import { remoteTlsIdentityPath } from "./remoteTransport/certificates";

const temporaryDirectories: string[] = [];
afterEach(() => vi.unstubAllEnvs());
afterAll(() => {
  for (const directory of temporaryDirectories)
    fs.rmSync(directory, { recursive: true, force: true });
});

// Real TLS/relay traffic and revocation live in remoteSessions/httpRoute.test.ts
// and hostConnections/resourcePool.test.ts. The removed fake-v1 splice did not
// exercise that boundary and incorrectly admitted an organization member.
it("persists host linking without creating remote device trust or a TLS root", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-connectivity-integration-"));
  temporaryDirectories.push(baseDir);
  const environmentId = "integration-environment";
  fs.mkdirSync(path.join(baseDir, "userdata"), { recursive: true });
  fs.writeFileSync(path.join(baseDir, "userdata", "environment-id"), environmentId);
  await writeAccountCredentials(baseDir, {
    accountUrl: "https://accounts.example.test",
    workosClientId: "workos-client",
    workosApiUrl: "https://workos.example.test",
    organizationId: "org",
    userId: "owner",
    accessToken: "account-session",
    refreshToken: "account-refresh",
  });
  const host: AccountHost = {
    id: "2f1f9dd7-56a5-45cf-b847-12e6658f3720",
    environmentId: EnvironmentId.makeUnsafe(environmentId),
    name: "Integration host",
    platform: "linux",
    kind: "local",
    endpoints: [],
    ownerUserId: "owner",
    discoverable: true,
    linked: true,
    keyGeneration: 1,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  let linkProof = "";
  const linkClient = {
    startHostLink: async () => ({
      challengeId: "ea4fc40a-a4f7-498f-bf78-c6a69536ecab",
      nonce: "aW50ZWdyYXRpb24tbm9uY2U",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }),
    completeHostLink: async (request: { proof: string }) => {
      linkProof = request.proof;
      return { host };
    },
  } as unknown as AccountClient;
  await runAuthLogin({
    accountUrl: "https://accounts.example.test",
    baseDir,
    client: linkClient,
    platform: "linux",
    hostname: host.name,
    stdout: () => {},
  });
  expect(linkProof.split(".")).toHaveLength(3);
  expect(await readAccountFile(baseDir)).toMatchObject({
    hostId: host.id,
    hostOwnerUserId: host.ownerUserId,
    hostKeyGeneration: 1,
  });

  const identity = await readHostIdentity(
    path.join(baseDir, "userdata", "secrets", "host-identity.json"),
  );
  if (!identity) throw new Error("link did not persist a host identity");
  expect(identity).toBeDefined();
  expect(fs.existsSync(path.join(baseDir, "userdata", "secrets", "remote-tls.json"))).toBe(false);
});

it.each([
  { name: "enforced snapshot", status: 200, enforced: true, code: undefined },
  { name: "subscription refusal", status: 403, enforced: true, code: "subscription_required" },
  { name: "billing outage", status: 503, enforced: true, code: "billing_unavailable" },
  { name: "explicitly disabled snapshot", status: 200, enforced: false, code: undefined },
  { name: "older default-off snapshot", status: 200, enforced: undefined, code: undefined },
])("learns $name before a missing TLS root can bypass commercial policy", async (scenario) => {
  vi.stubEnv("SYNARA_DESKTOP_BUNDLE_ID", SYNARA_REMOTE_BUNDLE_ID);
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-connectivity-policy-"));
  temporaryDirectories.push(baseDir);
  const config = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* ServerConfig;
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provide(NodeServices.layer)),
      ),
      Effect.scoped,
    ),
  );
  const environmentId = "policy-integration-environment";
  const hostId = "ad0871f7-e494-4a12-bb0e-2e088c2ea448";
  fs.writeFileSync(config.environmentIdPath, environmentId);
  const identity = await generateAndPersistHostIdentity(config.hostIdentityPath);
  const publicKey = await importSPKI(identity.publicKeyPem, "EdDSA");
  let accountUrl = "";
  const authenticatedRequests: string[] = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      const authorization = request.headers.authorization;
      if (
        request.method !== "GET" ||
        request.url !== `/api/v1/hosts/${hostId}/authorization` ||
        !authorization?.startsWith("HostProof ")
      ) {
        response.writeHead(401).end();
        return;
      }
      await jwtVerify(authorization.slice("HostProof ".length), publicKey, {
        algorithms: ["EdDSA"],
        typ: HOST_PROOF_JWT_TYP,
        issuer: `synara-host:${environmentId}`,
        subject: hostId,
        audience: accountApiIssuer(accountUrl),
      });
      authenticatedRequests.push(request.url);
      response.writeHead(scenario.status, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          scenario.code
            ? { error: scenario.code, message: "Commercial verification unavailable" }
            : {
                ownerUserId: "owner",
                orgId: "org",
                ownerInOrg: true,
                discoverable: true,
                revokedDeviceJkts: [],
                remoteBillingEnforced: scenario.enforced,
              },
        ),
      );
    })().catch(() => {
      response.writeHead(401).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Account fixture did not bind");
    accountUrl = `http://127.0.0.1:${address.port}`;
    await writeAccountCredentials(baseDir, {
      accountUrl,
      workosClientId: "workos-client",
      workosApiUrl: "https://workos.example.test",
      organizationId: "org",
      hostId,
      hostOwnerUserId: "owner",
      hostKeyGeneration: 1,
    });
    const registry = new RemoteSessionRegistry();
    const startup = startHostConnectivity({
      config,
      listeningPort: 0,
      remoteSessions: registry,
      // Missing TLS stops startup before these downstream services can be used.
      localSessions: {} as HostConnectivityOptions["localSessions"],
      remoteTrust: {} as HostConnectivityOptions["remoteTrust"],
      authControlPlane: {} as HostConnectivityOptions["authControlPlane"],
      connectorExecutable: async () => {
        throw new Error("Connector must not start before the local TLS identity exists");
      },
    });
    if (scenario.status === 200) await expect(startup).rejects.toMatchObject({ code: "ENOENT" });
    else
      await expect(startup).rejects.toMatchObject({ status: scenario.status, code: scenario.code });

    expect(authenticatedRequests).toEqual([`/api/v1/hosts/${hostId}/authorization`]);
    expect(fs.existsSync(remoteTlsIdentityPath(config.secretsDir))).toBe(false);
    const stored = await readAccountFile(baseDir);
    if (scenario.enforced === undefined) expect(stored?.remoteBillingPolicy).toBeUndefined();
    else
      expect(stored?.remoteBillingPolicy).toEqual({
        apiIssuer: accountApiIssuer(accountUrl),
        hostId,
        ownerUserId: "owner",
        enforced: scenario.enforced,
      });
    expect(registry.remoteBillingEnforced).toBe(scenario.enforced === true);
    expect(registry.canAdmitRemoteSession()).toBe(scenario.enforced !== true);
    const release = registry.registerLegacyConnection(vi.fn());
    if (scenario.enforced) expect(release).toBeUndefined();
    else expect(release).toBeTypeOf("function");
    release?.();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
