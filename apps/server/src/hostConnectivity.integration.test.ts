import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EnvironmentId, type AccountHost } from "@synara/contracts";
import type { AccountClient } from "@synara/shared/account";
import { afterAll, expect, it } from "vitest";
import { readAccountFile, runAuthLogin, writeAccountCredentials } from "./accountAuth";
import { readHostIdentity } from "./hostIdentity";

const temporaryDirectories: string[] = [];
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
