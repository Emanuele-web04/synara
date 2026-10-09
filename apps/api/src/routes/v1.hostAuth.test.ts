import { randomUUID } from "node:crypto";
import {
  GRANT_JWT_TYP,
  GRANT_MAX_AGE_SECONDS,
  GrantClaims,
  type HostPublicKeyJwk,
} from "@synara/contracts";
import { and, eq, inArray } from "drizzle-orm";
import { Schema } from "effect";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT, type GenerateKeyPairResult } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkosApiConfig } from "../config";
import { createDb } from "../db";
import { runMigrations } from "../db/migrate";
import { devices, hosts, linkChallenges, revocationEvents } from "../db/schema";
import { createDeviceRegistry } from "../identity/deviceRegistry";
import { createHostGrantIssuer } from "../identity/grantIssuer";
import { createHostKeyRegistry } from "../identity/hostKeyRegistry";
import { createHostSecretStore } from "../identity/hostSecretStore";
import { clearOrgCache } from "../identity/orgProvisioning";
import { createApiSigningService, type ApiSigningService } from "../identity/signing";
import { createWorkosIdentityProvider } from "../identity/workos";
import { startFakeWorkos, type FakeWorkos } from "../testing/fakeWorkos";
import { createV1Routes, LINK_APPROVE_RATE_LIMIT_PER_MINUTE } from "./v1";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

type Session = { token: string; userId: string; orgId: string };
type HostKeyPair = GenerateKeyPairResult & { publicJwk: HostPublicKeyJwk };

const authHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

describe.skipIf(!TEST_DATABASE_URL)("Slice A host account API", () => {
  const databaseUrl = TEST_DATABASE_URL as string;
  let database: ReturnType<typeof createDb>;
  let pool: ReturnType<typeof createDb>["pool"];
  let workos: FakeWorkos;
  let config: WorkosApiConfig;
  let signing: ApiSigningService;
  const remoteTestUserIds: string[] = [];

  async function signIn(existing?: { userId: string; orgId: string }): Promise<Session> {
    const user = existing ? workos.addUser({ id: existing.userId }) : workos.addUser({});
    const org = existing
      ? workos.addOrganization({ id: existing.orgId })
      : workos.addOrganization({ name: `Workspace ${user.id}` });
    workos.addMembership(org.id, user.id);
    remoteTestUserIds.push(user.id);
    return {
      userId: user.id,
      orgId: org.id,
      token: await workos.signAccessToken({ sub: user.id, sid: randomUUID(), orgId: org.id }),
    };
  }

  async function teammate(owner: Session): Promise<Session> {
    const user = workos.addUser({});
    workos.addMembership(owner.orgId, user.id);
    remoteTestUserIds.push(user.id);
    return {
      userId: user.id,
      orgId: owner.orgId,
      token: await workos.signAccessToken({
        sub: user.id,
        sid: randomUUID(),
        orgId: owner.orgId,
      }),
    };
  }

  function buildApp(tunnels?: Parameters<typeof createV1Routes>[0]["tunnels"]) {
    const { db } = database;
    const { verifier, grants } = createWorkosIdentityProvider(config);
    const app = new Hono();
    app.route(
      "/api/v1",
      createV1Routes({
        remoteTestUserIds,
        ...(tunnels ? { tunnels } : {}),
        verifier,
        grants,
        signing,
        hostKeys: createHostKeyRegistry(
          db,
          config.apiPublicUrl,
          async (orgId) => (await grants.countOrganizationMembers(orgId, 2)) > 1,
        ),
        devices: createDeviceRegistry(db, config.apiPublicUrl),
        hostGrants: createHostGrantIssuer(signing),
        hostSecrets: createHostSecretStore(db),
        accountBaseUrl: config.baseUrl,
        db,
        trustedProxyHops: 1,
      }),
    );
    return { app, db };
  }

  async function hostKeyPair(): Promise<HostKeyPair> {
    const keys = await generateKeyPair("EdDSA", { extractable: true });
    const jwk = await exportJWK(keys.publicKey);
    return {
      ...keys,
      publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x as string },
    };
  }

  async function linkProof(
    key: HostKeyPair,
    challenge: { challengeId: string; nonce: string },
    environmentId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      publicKeyJwk: key.publicJwk,
      name: "Linked host",
      platform: "darwin",
      ...overrides,
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "synara-host-link+jwt" })
      .setIssuer(`synara-host:${environmentId}`)
      .setSubject(environmentId)
      .setAudience(config.apiPublicUrl)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti(randomUUID())
      .sign(key.privateKey);
  }

  async function hostProof(
    key: HostKeyPair,
    host: { id: string; environmentId: string; keyGeneration: number },
    overrides: {
      audience?: string;
      issuedAt?: number;
      expiresAt?: number;
      keyGeneration?: number;
    } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ keyGeneration: overrides.keyGeneration ?? host.keyGeneration })
      .setProtectedHeader({ alg: "EdDSA", typ: "synara-host-proof+jwt" })
      .setIssuer(`synara-host:${host.environmentId}`)
      .setSubject(host.id)
      .setAudience(overrides.audience ?? config.apiPublicUrl)
      .setIssuedAt(overrides.issuedAt ?? now)
      .setExpirationTime(overrides.expiresAt ?? now + 60)
      .setJti(randomUUID())
      .sign(key.privateKey);
  }

  async function linkHost(
    app: Hono,
    owner: Session,
    options: { environmentId?: string; key?: HostKeyPair } = {},
  ) {
    const environmentId = options.environmentId ?? randomUUID();
    const key = options.key ?? (await hostKeyPair());
    const start = await app.request("/api/v1/hosts/link/start", {
      method: "POST",
      headers: authHeaders(owner.token),
      body: JSON.stringify(
        options.environmentId === undefined
          ? {}
          : {
              environmentId,
              name: "Started host",
              platform: "darwin",
              kind: "local",
            },
      ),
    });
    expect(start.status).toBe(201);
    const challenge = (await start.json()) as {
      challengeId: string;
      nonce: string;
      hostId?: string;
    };
    const complete = await app.request("/api/v1/hosts/link/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        proof: await linkProof(key, challenge, environmentId),
      }),
    });
    expect(complete.status).toBe(200);
    const body = (await complete.json()) as {
      host: { id: string; environmentId: string; keyGeneration: number; linked: boolean };
    };
    return { ...body.host, key, challenge };
  }

  /**
   * Links a host and then opts it into org visibility, the way an owner does
   * via the consent prompt. Shared-workspace links now start PRIVATE (ADR
   * 0002), so any test about org-visible behavior must say so explicitly
   * rather than inheriting it.
   */
  async function linkSharedHost(
    app: Hono,
    owner: Session,
    options: { environmentId?: string; key?: HostKeyPair } = {},
  ) {
    const host = await linkHost(app, owner, options);
    const response = await app.request(`/api/v1/hosts/${host.id}`, {
      method: "PATCH",
      headers: authHeaders(owner.token),
      body: JSON.stringify({ discoverable: true }),
    });
    expect(response.status).toBe(200);
    return host;
  }

  async function deviceProof(
    key: GenerateKeyPairResult,
    userId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const publicKeyJwk = await exportJWK(key.publicKey);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      publicKeyJwk,
      displayName: "Test device",
      platform: "ios",
      ...overrides,
    })
      .setProtectedHeader({
        alg: publicKeyJwk.kty === "EC" ? "ES256" : "EdDSA",
        typ: "synara-device-register+jwt",
      })
      .setIssuer("synara-device")
      .setSubject(userId)
      .setAudience(config.apiPublicUrl)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti(randomUUID())
      .sign(key.privateKey);
  }

  async function registerDevice(app: Hono, session: Session, suppliedKey?: GenerateKeyPairResult) {
    const key = suppliedKey ?? (await generateKeyPair("ES256", { extractable: true }));
    const response = await app.request("/api/v1/devices", {
      method: "POST",
      headers: authHeaders(session.token),
      body: JSON.stringify({ proof: await deviceProof(key, session.userId) }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { device: { id: string; jkt: string } };
    return { ...body.device, key };
  }

  beforeAll(async () => {
    await runMigrations(databaseUrl);
    workos = await startFakeWorkos();
    config = workos.config({ databaseUrl });
    signing = await createApiSigningService({
      issuer: config.apiPublicUrl,
      seed: config.apiSigningKey,
    });
    database = createDb(databaseUrl);
    pool = database.pool;
  });

  afterAll(async () => {
    await pool?.end();
    await workos?.close();
  });

  beforeEach(() => clearOrgCache());

  describe("1. link", () => {
    it("links with both bound and host-reported environment ids", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const boundId = randomUUID();
      const bound = await linkHost(app, owner, { environmentId: boundId });
      const unbound = await linkHost(app, owner);
      expect(bound).toMatchObject({ environmentId: boundId, keyGeneration: 1, linked: true });
      expect(unbound).toMatchObject({ keyGeneration: 1, linked: true });
    });

    it("consumes a challenge atomically so a double complete has one winner", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const environmentId = randomUUID();
      const key = await hostKeyPair();
      const start = await app.request("/api/v1/hosts/link/start", {
        method: "POST",
        headers: authHeaders(owner.token),
        body: JSON.stringify({ environmentId, name: "Race", platform: "linux", kind: "local" }),
      });
      const challenge = (await start.json()) as { challengeId: string; nonce: string };
      const body = JSON.stringify({
        challengeId: challenge.challengeId,
        proof: await linkProof(key, challenge, environmentId),
      });
      const complete = () =>
        app.request("/api/v1/hosts/link/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
      const statuses = (await Promise.all([complete(), complete()])).map(
        (response) => response.status,
      );
      expect(statuses.toSorted()).toEqual([200, 409]);
    });

    it("burns bad signatures and nonce mismatches and classifies expired challenges", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      for (const failure of ["bad-signature", "bad-nonce", "expired"] as const) {
        const environmentId = randomUUID();
        const key = await hostKeyPair();
        const start = await app.request("/api/v1/hosts/link/start", {
          method: "POST",
          headers: authHeaders(owner.token),
          body: JSON.stringify({ environmentId, name: "Bad", platform: "darwin", kind: "local" }),
        });
        const challenge = (await start.json()) as { challengeId: string; nonce: string };
        if (failure === "expired") {
          await db
            .update(linkChallenges)
            .set({ expiresAt: new Date(Date.now() - 1) })
            .where(eq(linkChallenges.id, challenge.challengeId));
        }
        const signingKey = failure === "bad-signature" ? await hostKeyPair() : key;
        const proof = await linkProof(signingKey, challenge, environmentId, {
          ...(failure === "bad-nonce" ? { nonce: "wrong" } : {}),
          publicKeyJwk: key.publicJwk,
        });
        const response = await app.request("/api/v1/hosts/link/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ challengeId: challenge.challengeId, proof }),
        });
        expect(response.status).toBe(failure === "expired" ? 400 : 401);
      }
    });

    it("refuses same-org takeover without changing the victim generation", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const member = await teammate(owner);
      const environmentId = randomUUID();
      const victim = await linkHost(app, owner, { environmentId });
      const response = await app.request("/api/v1/hosts/link/start", {
        method: "POST",
        headers: authHeaders(member.token),
        body: JSON.stringify({ environmentId, name: "Takeover", platform: "linux", kind: "local" }),
      });
      expect(response.status).toBe(409);
      const [row] = await db.select().from(hosts).where(eq(hosts.id, victim.id));
      expect(row?.keyGeneration).toBe(victim.keyGeneration);
    });

    it("relink bumps generation and invalidates the old HostProof", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const environmentId = randomUUID();
      const first = await linkHost(app, owner, { environmentId });
      const oldProof = await hostProof(first.key, first);
      const nextKey = await hostKeyPair();
      // The start contract makes metadata optional. An existing row already
      // has it, so an owner may relink by environment id alone.
      const start = await app.request("/api/v1/hosts/link/start", {
        method: "POST",
        headers: authHeaders(owner.token),
        body: JSON.stringify({ environmentId }),
      });
      expect(start.status).toBe(201);
      const challenge = (await start.json()) as { challengeId: string; nonce: string };
      const complete = await app.request("/api/v1/hosts/link/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          proof: await linkProof(nextKey, challenge, environmentId),
        }),
      });
      expect(complete.status).toBe(200);
      const second = (await complete.json()) as {
        host: { id: string; environmentId: string; keyGeneration: number };
      };
      expect(second.host.keyGeneration).toBe(first.keyGeneration + 1);
      expect(
        (
          await app.request(`/api/v1/hosts/${first.id}/authorization`, {
            headers: { authorization: `HostProof ${oldProof}` },
          })
        ).status,
      ).toBe(401);
    });

    it("re-linking the same environment under another of the OWNER's orgs sweeps their old row", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const secondOrg = workos.addOrganization({ name: "Second workspace" });
      workos.addMembership(secondOrg.id, owner.userId);
      const ownerInSecondOrg: Session = {
        userId: owner.userId,
        orgId: secondOrg.id,
        token: await workos.signAccessToken({
          sub: owner.userId,
          sid: randomUUID(),
          orgId: secondOrg.id,
        }),
      };
      const environmentId = randomUUID();
      const first = await linkHost(app, owner, { environmentId });
      await linkHost(app, ownerInSecondOrg, { environmentId });
      const [old] = await db.select().from(hosts).where(eq(hosts.id, first.id));
      expect(old).toMatchObject({ publicKeyJwk: null, discoverable: false });
      expect(
        await db
          .select()
          .from(revocationEvents)
          .where(
            and(eq(revocationEvents.hostId, first.id), eq(revocationEvents.kind, "host_unlinked")),
          ),
      ).toHaveLength(1);
    });

    it("linking an environmentId NEVER touches another user's rows (no cross-user unlink DoS)", async () => {
      // environmentId is self-asserted in the proof and visible to org
      // members via GET /hosts. If the one-slot sweep crossed user
      // boundaries, anyone could force-unlink a victim's host by linking a
      // machine that merely claims the victim's environmentId.
      const { app, db } = buildApp();
      const victim = await signIn();
      const attacker = await signIn();
      const environmentId = randomUUID();
      const victimHost = await linkHost(app, victim, { environmentId });
      await linkHost(app, attacker, { environmentId });
      const [untouched] = await db.select().from(hosts).where(eq(hosts.id, victimHost.id));
      expect(untouched?.publicKeyJwk).not.toBeNull();
      expect(untouched).toMatchObject({ discoverable: true, ownerUserId: victim.userId });
      expect(
        await db.select().from(revocationEvents).where(eq(revocationEvents.hostId, victimHost.id)),
      ).toHaveLength(0);
    });
  });

  describe("2. device code", () => {
    it("mints, waits for approval, delivers once, and completes through the common proof", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const minted = await app.request("/api/v1/hosts/link/device", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.10" },
      });
      const code = (await minted.json()) as {
        deviceCode: string;
        userCode: string;
        verificationUri: string;
        interval: number;
      };
      expect(code.verificationUri).toBe(new URL("/link", config.baseUrl).toString());
      const tokenRequest = () =>
        app.request("/api/v1/hosts/link/device/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceCode: code.deviceCode }),
        });
      expect((await tokenRequest()).status).toBe(428);
      expect(
        (
          await app.request("/api/v1/hosts/link/approve", {
            method: "POST",
            headers: { ...authHeaders(owner.token), "x-forwarded-for": "203.0.113.11" },
            body: JSON.stringify({ userCode: code.userCode }),
          })
        ).status,
      ).toBe(204);
      const delivered = await tokenRequest();
      expect(delivered.status).toBe(200);
      expect((await tokenRequest()).status).toBe(409);
      const challenge = (await delivered.json()) as { challengeId: string; nonce: string };
      const environmentId = randomUUID();
      const key = await hostKeyPair();
      const complete = await app.request("/api/v1/hosts/link/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          proof: await linkProof(key, challenge, environmentId),
        }),
      });
      expect(complete.status).toBe(200);
      expect(code.interval).toBe(5);
    });

    it("rejects expired codes and rate-limits user-code guessing", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const minted = await app.request("/api/v1/hosts/link/device", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.12" },
      });
      const code = (await minted.json()) as { deviceCode: string; userCode: string };
      await db
        .update(linkChallenges)
        .set({ expiresAt: new Date(Date.now() - 1) })
        .where(eq(linkChallenges.userCode, code.userCode));
      const expired = await app.request("/api/v1/hosts/link/approve", {
        method: "POST",
        headers: { ...authHeaders(owner.token), "x-forwarded-for": "203.0.113.13" },
        body: JSON.stringify({ userCode: code.userCode }),
      });
      expect(expired.status).toBe(400);

      for (let attempt = 0; attempt < LINK_APPROVE_RATE_LIMIT_PER_MINUTE; attempt += 1) {
        await app.request("/api/v1/hosts/link/approve", {
          method: "POST",
          headers: { ...authHeaders(owner.token), "x-forwarded-for": "203.0.113.14" },
          body: JSON.stringify({ userCode: "AAAAAAAA" }),
        });
      }
      expect(
        (
          await app.request("/api/v1/hosts/link/approve", {
            method: "POST",
            headers: { ...authHeaders(owner.token), "x-forwarded-for": "203.0.113.14" },
            body: JSON.stringify({ userCode: "BBBBBBBB" }),
          })
        ).status,
      ).toBe(429);
    });

    it("reserves unique user codes among live challenges", async () => {
      const { app } = buildApp();
      const codes = await Promise.all(
        Array.from({ length: 20 }, async (_, index) => {
          const response = await app.request("/api/v1/hosts/link/device", {
            method: "POST",
            headers: { "x-forwarded-for": `203.0.114.${index + 1}` },
          });
          return ((await response.json()) as { userCode: string }).userCode;
        }),
      );
      expect(new Set(codes).size).toBe(codes.length);
    });
  });

  describe("3. HostProof", () => {
    it("returns revoked device thumbprints only for users who could reach this host", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const member = await teammate(owner);
      const host = await linkSharedHost(app, owner, { environmentId: randomUUID() });
      const ownerDevice = await registerDevice(app, owner);
      // Simulate the fail-open notification side of a membership-provider
      // outage: the durable device revocation exists, but no host event could
      // be fanned out. The owner's own host must still recover it directly.
      await db.update(devices).set({ revokedAt: new Date() }).where(eq(devices.id, ownerDevice.id));
      const memberDevice = await registerDevice(app, member);
      await app.request(`/api/v1/devices/${memberDevice.id}`, {
        method: "DELETE",
        headers: authHeaders(member.token),
      });

      const unrelatedOwner = await signIn();
      await linkSharedHost(app, unrelatedOwner, { environmentId: randomUUID() });
      const unrelatedDevice = await registerDevice(app, unrelatedOwner);
      await app.request(`/api/v1/devices/${unrelatedDevice.id}`, {
        method: "DELETE",
        headers: authHeaders(unrelatedOwner.token),
      });

      const response = await app.request(`/api/v1/hosts/${host.id}/authorization`, {
        headers: { authorization: `HostProof ${await hostProof(host.key, host)}` },
      });
      expect(response.status).toBe(200);
      const snapshot = (await response.json()) as { revokedDeviceJkts: string[] };
      expect(snapshot.revokedDeviceJkts).toContain(ownerDevice.jkt);
      expect(snapshot.revokedDeviceJkts).toContain(memberDevice.jkt);
      expect(snapshot.revokedDeviceJkts).not.toContain(unrelatedDevice.jkt);
    });

    it("accepts valid proof and rejects stale expiry, audience, generation, and unlink", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner, { environmentId: randomUUID() });
      const valid = await hostProof(host.key, host);
      expect(
        await Promise.all(
          [0, 1].map(
            async () =>
              (
                await app.request(`/api/v1/hosts/${host.id}/authorization`, {
                  headers: { authorization: `HostProof ${valid}` },
                })
              ).status,
          ),
        ),
      ).toEqual([200, 200]);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/endpoints`, {
            method: "PUT",
            headers: { authorization: `HostProof ${valid}`, "content-type": "application/json" },
            body: JSON.stringify({
              endpoints: [{ url: "http://192.168.1.10:48090", transport: "lan" }],
            }),
          })
        ).status,
      ).toBe(200);
      const authorization = await app.request(`/api/v1/hosts/${host.id}/authorization`, {
        headers: { authorization: `HostProof ${valid}` },
      });
      expect(await authorization.json()).toMatchObject({
        discoverable: true,
        ownerUserId: owner.userId,
        orgId: owner.orgId,
        ownerInOrg: true,
      });
      expect((await app.request(`/api/v1/hosts/${host.id}/authorization`)).status).toBe(401);
      const malformedSubject = await new SignJWT({ keyGeneration: host.keyGeneration })
        .setProtectedHeader({ alg: "EdDSA", typ: "synara-host-proof+jwt" })
        .setIssuer(`synara-host:${host.environmentId}`)
        .setSubject("not-a-uuid")
        .setAudience(config.apiPublicUrl)
        .setIssuedAt()
        .setExpirationTime("60s")
        .setJti(randomUUID())
        .sign(host.key.privateKey);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/authorization`, {
            headers: { authorization: `HostProof ${malformedSubject}` },
          })
        ).status,
      ).toBe(401);
      const now = Math.floor(Date.now() / 1000);
      for (const proof of [
        await hostProof(host.key, host, { issuedAt: now - 122, expiresAt: now - 62 }),
        await hostProof(host.key, host, { audience: "https://wrong.example" }),
        await hostProof(host.key, host, { keyGeneration: host.keyGeneration - 1 }),
      ]) {
        expect(
          (
            await app.request(`/api/v1/hosts/${host.id}/authorization`, {
              headers: { authorization: `HostProof ${proof}` },
            })
          ).status,
        ).toBe(401);
      }
      await db.update(hosts).set({ publicKeyJwk: null }).where(eq(hosts.id, host.id));
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/authorization`, {
            headers: { authorization: `HostProof ${valid}` },
          })
        ).status,
      ).toBe(401);
    });
  });

  describe("4. devices", () => {
    it("registers, lists, and removes devices with an org-less user session", async () => {
      const { app } = buildApp();
      const user = workos.addUser({});
      const token = await workos.signAccessToken({ sub: user.id, sid: randomUUID() });
      const key = await generateKeyPair("ES256", { extractable: true });
      const registered = await app.request("/api/v1/devices", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ proof: await deviceProof(key, user.id) }),
      });
      expect(registered.status).toBe(201);
      const device = (await registered.json()) as { device: { id: string } };
      expect(
        (
          (await (
            await app.request("/api/v1/devices", { headers: authHeaders(token) })
          ).json()) as { devices: Array<{ id: string }> }
        ).devices,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ id: device.device.id })]));
      expect(
        (
          await app.request(`/api/v1/devices/${device.device.id}`, {
            method: "DELETE",
            headers: authHeaders(token),
          })
        ).status,
      ).toBe(204);
    });

    it("requires PoP, scopes identical jkt per user, and refuses re-register after revoke", async () => {
      const { app } = buildApp();
      const a = await signIn();
      const b = await signIn();
      const key = await generateKeyPair("ES256", { extractable: true });
      const publicKeyJwk = await exportJWK(key.publicKey);
      const impostor = await generateKeyPair("ES256", { extractable: true });
      const bad = await app.request("/api/v1/devices", {
        method: "POST",
        headers: authHeaders(a.token),
        body: JSON.stringify({
          proof: await deviceProof(impostor, a.userId, { publicKeyJwk }),
        }),
      });
      expect(bad.status).toBe(401);
      const first = await registerDevice(app, a, key);
      expect(
        (
          (await (
            await app.request("/api/v1/devices", { headers: authHeaders(a.token) })
          ).json()) as { devices: Array<{ id: string; publicKeyJwk: unknown }> }
        ).devices,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.id, publicKeyJwk: expect.any(Object) }),
        ]),
      );
      expect(
        (
          await app.request(`/api/v1/devices/${first.id}`, {
            method: "DELETE",
            headers: authHeaders(b.token),
          })
        ).status,
      ).toBe(404);
      const second = await registerDevice(app, b, key);
      expect(second.id).not.toBe(first.id);
      expect(second.jkt).toBe(first.jkt);
      expect(
        (
          await app.request(`/api/v1/devices/${first.id}`, {
            method: "DELETE",
            headers: authHeaders(a.token),
          })
        ).status,
      ).toBe(204);
      const replacement = await app.request("/api/v1/devices", {
        method: "POST",
        headers: authHeaders(a.token),
        body: JSON.stringify({ proof: await deviceProof(key, a.userId) }),
      });
      expect(replacement.status).toBe(403);
      expect(await replacement.json()).toMatchObject({ error: "device_not_registered" });
    });

    it("binds verified sessions and independently revokes account access with retryable provider delivery", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const other = await signIn(owner);
      const outsider = await signIn();
      const device = await registerDevice(app, owner);
      const path = `/api/v1/devices/${device.id}/account-sessions`;
      expect(
        (await app.request(path, { method: "DELETE", headers: authHeaders(outsider.token) }))
          .status,
      ).toBe(404);
      // Local tombstone is committed even when the provider is unavailable.
      workos.failNextSessionRevocation();
      const pending = await app.request(path, {
        method: "DELETE",
        headers: authHeaders(other.token),
      });
      expect(pending.status).toBe(202);
      expect(await pending.json()).toEqual({ confirmed: 0, pending: 1 });
      expect(
        (await app.request("/api/v1/devices", { headers: authHeaders(owner.token) })).status,
      ).toBe(401);
      const retried = await app.request(path, {
        method: "DELETE",
        headers: authHeaders(other.token),
      });
      expect(retried.status).toBe(200);
      expect(await retried.json()).toEqual({ confirmed: 1, pending: 0 });
      expect(
        (await db.select().from(devices).where(eq(devices.id, device.id)))[0]?.revokedAt,
      ).toBeNull();
    });

    it("revocation over-notifies every host in the user's organizations", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const mate = await teammate(owner);
      const ownHost = await linkSharedHost(app, owner, { environmentId: randomUUID() });
      const mateHost = await linkSharedHost(app, mate, { environmentId: randomUUID() });
      const device = await registerDevice(app, owner);
      await app.request(`/api/v1/devices/${device.id}`, {
        method: "DELETE",
        headers: authHeaders(owner.token),
      });
      const events = await db
        .select()
        .from(revocationEvents)
        .where(
          and(
            inArray(revocationEvents.hostId, [ownHost.id, mateHost.id]),
            eq(revocationEvents.kind, "device_revoked"),
          ),
        );
      expect(new Set(events.map((event) => event.hostId))).toEqual(
        new Set([ownHost.id, mateHost.id]),
      );
    });

    it("reports host revocation as pending until that host proves durable delivery", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const first = await linkHost(app, owner, { environmentId: randomUUID() });
      const second = await linkHost(app, owner, { environmentId: randomUUID() });
      const device = await registerDevice(app, owner);
      expect(
        (
          await app.request(`/api/v1/devices/${device.id}`, {
            method: "DELETE",
            headers: authHeaders(owner.token),
          })
        ).status,
      ).toBe(204);
      const read = async () => {
        const response = await app.request("/api/v1/devices", {
          headers: authHeaders(owner.token),
        });
        const body = (await response.json()) as {
          devices: Array<{
            id: string;
            revocationDeliveries: Array<{ hostId: string; confirmedAt: string | null }>;
          }>;
        };
        return body.devices.find((entry) => entry.id === device.id)!.revocationDeliveries;
      };
      expect(await read()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ hostId: first.id, confirmedAt: null }),
          expect.objectContaining({ hostId: second.id, confirmedAt: null }),
        ]),
      );
      const endpoint = `/api/v1/hosts/${first.id}/device-revocations/ack`;
      const body = JSON.stringify({ deviceJkts: [device.jkt] });
      expect(
        (await app.request(endpoint, { method: "POST", headers: authHeaders(owner.token), body }))
          .status,
      ).toBe(401);
      expect(
        (
          await app.request(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `HostProof ${await hostProof(second.key, second)}`,
            },
            body,
          })
        ).status,
      ).not.toBe(204);
      expect(
        (
          await app.request(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `HostProof ${await hostProof(first.key, first)}`,
            },
            body,
          })
        ).status,
      ).toBe(204);
      const delivered = await read();
      expect(delivered.find((entry) => entry.hostId === first.id)!.confirmedAt).toEqual(
        expect.any(String),
      );
      expect(delivered.find((entry) => entry.hostId === second.id)!.confirmedAt).toBeNull();
    });
  });

  describe("5. grants", () => {
    it("issues owner grants with device binding and denies discoverable members", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const member = await teammate(owner);
      const host = await linkSharedHost(app, owner, { environmentId: randomUUID() });
      for (const session of [owner, member]) {
        const device = await registerDevice(app, session);
        const response = await app.request(`/api/v1/hosts/${host.id}/grant`, {
          method: "POST",
          headers: authHeaders(session.token),
          body: JSON.stringify({ deviceJkt: device.jkt }),
        });
        if (session === member) {
          expect(response.status).toBe(403);
          expect(await response.json()).toMatchObject({ error: "not_host_owner" });
          continue;
        }
        expect(response.status).toBe(200);
        const { grant } = (await response.json()) as { grant: string };
        const payload = await signing.verify(grant, {
          typ: GRANT_JWT_TYP,
          audience: "synara-relay",
          maxAgeSeconds: GRANT_MAX_AGE_SECONDS,
        });
        expect(Schema.decodeUnknownSync(GrantClaims)(payload).cnf.jkt).toBe(device.jkt);
      }
    });

    it("refuses hidden/nonmember, unregistered/revoked, and unlinked combinations", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const member = await teammate(owner);
      const outsider = await signIn();
      const host = await linkHost(app, owner, { environmentId: randomUUID() });
      const memberDevice = await registerDevice(app, member);
      const outsiderDevice = await registerDevice(app, outsider);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/grant`, {
            method: "POST",
            headers: authHeaders(owner.token),
            body: JSON.stringify({ deviceJkt: memberDevice.jkt }),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/grant`, {
            method: "POST",
            headers: authHeaders(owner.token),
            body: JSON.stringify({ deviceJkt: "not-registered" }),
          })
        ).status,
      ).toBe(403);
      // An outsider must not be able to tell a host they cannot see from one
      // that does not exist — the grant route answers 404, exactly like
      // requireHostOwner, so it is not an existence oracle.
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/grant`, {
            method: "POST",
            headers: authHeaders(outsider.token),
            body: JSON.stringify({ deviceJkt: outsiderDevice.jkt }),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}`, {
            method: "PATCH",
            headers: authHeaders(owner.token),
            body: JSON.stringify({ discoverable: false }),
          })
        ).status,
      ).toBe(200);
      // Undiscoverable makes the host invisible to org-mates too: 404, not a
      // 403 that would confirm it exists.
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/grant`, {
            method: "POST",
            headers: authHeaders(member.token),
            body: JSON.stringify({ deviceJkt: memberDevice.jkt }),
          })
        ).status,
      ).toBe(404);
      await app.request(`/api/v1/devices/${memberDevice.id}`, {
        method: "DELETE",
        headers: authHeaders(member.token),
      });
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/grant`, {
            method: "POST",
            headers: authHeaders(member.token),
            body: JSON.stringify({ deviceJkt: memberDevice.jkt }),
          })
        ).status,
      ).toBe(404);
      const ownerDevice = await registerDevice(app, owner);
      await app.request(`/api/v1/hosts/${host.id}/unlink`, {
        method: "POST",
        headers: authHeaders(owner.token),
      });
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/grant`, {
            method: "POST",
            headers: authHeaders(owner.token),
            body: JSON.stringify({ deviceJkt: ownerDevice.jkt }),
          })
        ).status,
      ).toBe(409);
    });

    it("does not mint across a concurrent device revoke or host unlink", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner, { environmentId: randomUUID() });
      const device = await registerDevice(app, owner);
      const requestGrant = () =>
        app.request(`/api/v1/hosts/${host.id}/grant`, {
          method: "POST",
          headers: authHeaders(owner.token),
          body: JSON.stringify({ deviceJkt: device.jkt }),
        });

      const revoking = await pool.connect();
      try {
        await revoking.query("BEGIN");
        await revoking.query("UPDATE devices SET revoked_at = now() WHERE id = $1", [device.id]);
        const pending = requestGrant();
        await Promise.resolve();
        await revoking.query("COMMIT");
        expect((await pending).status).toBe(403);
      } finally {
        await revoking.query("ROLLBACK").catch(() => {});
        revoking.release();
      }

      const replacement = await registerDevice(app, owner);
      const unlinking = await pool.connect();
      try {
        await unlinking.query("BEGIN");
        await unlinking.query("UPDATE hosts SET public_key_jwk = NULL WHERE id = $1", [host.id]);
        const pending = app.request(`/api/v1/hosts/${host.id}/grant`, {
          method: "POST",
          headers: authHeaders(owner.token),
          body: JSON.stringify({ deviceJkt: replacement.jkt }),
        });
        await Promise.resolve();
        await unlinking.query("COMMIT");
        expect((await pending).status).toBe(409);
      } finally {
        await unlinking.query("ROLLBACK").catch(() => {});
        unlinking.release();
      }
    });
  });

  describe("6. host management", () => {
    it("returns host_not_found instead of a database error for malformed host ids", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const device = await registerDevice(app, owner);
      const malformedHostUrl = "/api/v1/hosts/not-a-uuid";
      const responses = await Promise.all([
        app.request(malformedHostUrl, {
          method: "PATCH",
          headers: authHeaders(owner.token),
          body: JSON.stringify({ name: "Typo" }),
        }),
        app.request(malformedHostUrl, {
          method: "DELETE",
          headers: authHeaders(owner.token),
        }),
        app.request(`${malformedHostUrl}/unlink`, {
          method: "POST",
          headers: authHeaders(owner.token),
        }),
        app.request(`${malformedHostUrl}/grant`, {
          method: "POST",
          headers: authHeaders(owner.token),
          body: JSON.stringify({ deviceJkt: device.jkt }),
        }),
      ]);

      expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
      for (const response of responses) {
        await expect(response.json()).resolves.toMatchObject({ error: "host_not_found" });
      }
    });

    it("enforces visibility/owner writes and emits durable management events", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const member = await teammate(owner);
      const outsider = await signIn();
      const host = await linkSharedHost(app, owner, { environmentId: randomUUID() });
      const otherOrg = workos.addOrganization({ name: "Owner's other workspace" });
      workos.addMembership(otherOrg.id, owner.userId);
      const ownerOtherOrgToken = await workos.signAccessToken({
        sub: owner.userId,
        sid: randomUUID(),
        orgId: otherOrg.id,
      });
      clearOrgCache();
      expect(
        (
          (await (
            await app.request("/api/v1/hosts", { headers: authHeaders(owner.token) })
          ).json()) as { hosts: Array<{ mine: boolean }> }
        ).hosts.find((entry) => entry.mine),
      ).toBeTruthy();
      expect(
        (
          (await (
            await app.request("/api/v1/hosts", { headers: authHeaders(member.token) })
          ).json()) as { hosts: unknown[] }
        ).hosts,
      ).not.toHaveLength(0);
      expect(
        (
          (await (
            await app.request("/api/v1/hosts", { headers: authHeaders(outsider.token) })
          ).json()) as { hosts: Array<{ id: string }> }
        ).hosts.find((entry) => entry.id === host.id),
      ).toBeUndefined();
      expect(
        (
          (await (
            await app.request("/api/v1/hosts", { headers: authHeaders(ownerOtherOrgToken) })
          ).json()) as { hosts: Array<{ id: string; mine: boolean }> }
        ).hosts,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ id: host.id, mine: true })]));
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}`, {
            method: "PATCH",
            headers: authHeaders(member.token),
            body: JSON.stringify({ discoverable: false }),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/unlink`, {
            method: "POST",
            headers: authHeaders(member.token),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}`, {
            method: "DELETE",
            headers: authHeaders(member.token),
          })
        ).status,
      ).toBe(403);
      await app.request(`/api/v1/hosts/${host.id}`, {
        method: "PATCH",
        headers: authHeaders(owner.token),
        body: JSON.stringify({ discoverable: false }),
      });
      expect(
        (
          (await (
            await app.request("/api/v1/hosts", { headers: authHeaders(member.token) })
          ).json()) as { hosts: Array<{ id: string }> }
        ).hosts.find((entry) => entry.id === host.id),
      ).toBeUndefined();
      const selfProof = await hostProof(host.key, host);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/unlink`, {
            method: "POST",
            headers: { authorization: `HostProof ${selfProof}` },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}`, {
            method: "DELETE",
            headers: authHeaders(owner.token),
          })
        ).status,
      ).toBe(204);
      const kinds = (
        await db.select().from(revocationEvents).where(eq(revocationEvents.hostId, host.id))
      ).map((event) => event.kind);
      // Multiplicity matters and arrayContaining ignores it: the unlink and
      // the delete must EACH emit host_unlinked, so a delete that silently
      // dropped its event would still satisfy a containment-only assertion.
      expect(kinds.filter((kind) => kind === "discoverability_off")).toHaveLength(1);
      expect(kinds.filter((kind) => kind === "host_unlinked")).toHaveLength(2);
      expect(await db.select().from(hosts).where(eq(hosts.id, host.id))).toHaveLength(0);
    });
  });

  describe("managed remote token isolation", () => {
    it("delivers connector credentials only to the current host proof and publishes only the URL", async () => {
      const provision = vi.fn(async () => ({
        hostname: "managed.example.test",
        tunnelId: randomUUID(),
        connectorToken: "fixture-private-connector-token",
      }));
      const { app } = buildApp({
        provision,
        disable: async () => {},
        cleanup: async () => {},
        endpoints: async (ids) => new Map(ids.map((id) => [id, "https://managed.example.test"])),
      });
      const owner = await signIn();
      const host = await linkHost(app, owner);
      const path = `/api/v1/hosts/${host.id}/tunnel`;
      const denied = await app.request(path, {
        method: "POST",
        headers: authHeaders(owner.token),
        body: JSON.stringify({ originPort: 34567 }),
      });
      expect(denied.status).toBe(401);
      expect(provision).not.toHaveBeenCalled();
      const accepted = await app.request(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `HostProof ${await hostProof(host.key, host)}`,
        },
        body: JSON.stringify({ originPort: 34567 }),
      });
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("cache-control")).toBe("no-store");
      expect(await accepted.json()).toHaveProperty(
        "connectorToken",
        "fixture-private-connector-token",
      );
      const directory = await app.request("/api/v1/hosts", { headers: authHeaders(owner.token) });
      const text = await directory.text();
      expect(text).toContain("managed.example.test");
      expect(text).not.toContain("connector-token");
      const injection = await app.request(`/api/v1/hosts/${host.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `HostProof ${await hostProof(host.key, host)}`,
        },
        body: JSON.stringify({
          endpoints: [{ transport: "cloudflare", url: "https://attacker.invalid" }],
        }),
      });
      expect(injection.status).toBe(400);
      workos.removeMembership(owner.orgId, owner.userId);
      const removed = await app.request(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `HostProof ${await hostProof(host.key, host)}`,
        },
        body: JSON.stringify({ originPort: 34567 }),
      });
      expect(removed.status).toBe(403);
      expect(provision).toHaveBeenCalledTimes(1);
      const snapshot = await app.request(`/api/v1/hosts/${host.id}/authorization`, {
        headers: { authorization: `HostProof ${await hostProof(host.key, host)}` },
      });
      expect(await snapshot.json()).toMatchObject({ ownerInOrg: false });
    });
    it("refuses grants and authorization snapshots when the account loses the explicit test entitlement", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner);
      remoteTestUserIds.splice(remoteTestUserIds.indexOf(owner.userId), 1);
      const grant = await app.request(`/api/v1/hosts/${host.id}/grant`, {
        method: "POST",
        headers: authHeaders(owner.token),
        body: "{}",
      });
      expect(grant.status).toBe(403);
      const authorization = await app.request(`/api/v1/hosts/${host.id}/authorization`, {
        headers: { authorization: `HostProof ${await hostProof(host.key, host)}` },
      });
      expect(authorization.status).toBe(403);
    });
  });

  describe("8. JWKS", () => {
    it("serves a stable current kid and the configured previous key publicly", async () => {
      const { db } = buildApp();
      const rotated = await createApiSigningService({
        issuer: config.apiPublicUrl,
        seed: config.apiSigningKey,
        previousSeed: Buffer.alloc(32, 2).toString("base64url"),
      });
      const { verifier, grants } = createWorkosIdentityProvider(config);
      const app = new Hono();
      app.route(
        "/api/v1",
        createV1Routes({
          remoteTestUserIds,
          verifier,
          grants,
          signing: rotated,
          hostKeys: createHostKeyRegistry(
            db,
            config.apiPublicUrl,
            async (orgId) => (await grants.countOrganizationMembers(orgId, 2)) > 1,
          ),
          devices: createDeviceRegistry(db, config.apiPublicUrl),
          hostGrants: createHostGrantIssuer(rotated),
          hostSecrets: createHostSecretStore(db),
          accountBaseUrl: config.baseUrl,
          db,
        }),
      );
      const response = await app.request("/api/v1/keys/jwks");
      expect(response.status).toBe(200);
      const body = (await response.json()) as { keys: Array<{ kid: string }> };
      expect(body.keys).toHaveLength(2);
      expect(body.keys[0]?.kid).toBe(signing.currentKid);
    });
  });

  describe("9. cutover", () => {
    it("removes legacy registration and rejects synhost bearer credentials", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const registered = await app.request("/api/v1/hosts", {
        method: "POST",
        headers: authHeaders(owner.token),
        body: JSON.stringify({
          environmentId: randomUUID(),
          name: "Legacy",
          platform: "darwin",
          kind: "local",
          endpoints: [],
        }),
      });
      expect(registered.status).toBe(404);
      expect(
        (
          await app.request(`/api/v1/hosts/${randomUUID()}`, {
            method: "PATCH",
            headers: authHeaders("synhost_removed"),
            body: JSON.stringify({ name: "Must not apply" }),
          })
        ).status,
      ).toBe(401);
    });

    it("does not let an org-mate relink the owner's environment", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const member = await teammate(owner);
      const environmentId = randomUUID();
      const host = await linkSharedHost(app, owner, { environmentId });
      const takeover = await app.request("/api/v1/hosts/link/start", {
        method: "POST",
        headers: authHeaders(member.token),
        body: JSON.stringify({
          environmentId,
          name: "Legacy takeover",
          platform: "darwin",
          kind: "local",
        }),
      });
      expect(takeover.status).toBe(409);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}`, {
            method: "DELETE",
            headers: authHeaders(member.token),
          })
        ).status,
      ).toBe(403);
    });
  });

  describe("10. consent before discoverability (ADR 0002)", () => {
    it("starts a host PRIVATE when the workspace has other members", async () => {
      // ADR 0002 wants consent BEFORE a machine is reachable by a team.
      // Starting discoverable and asking afterwards is a race the user can
      // lose — and loses silently, since the window grants code execution.
      const { app, db } = buildApp();
      const owner = await signIn();
      await teammate(owner);
      clearOrgCache();
      const host = await linkHost(app, owner, { environmentId: randomUUID() });
      const [row] = await db.select().from(hosts).where(eq(hosts.id, host.id));
      expect(row?.discoverable).toBe(false);
    });

    it("keeps a solo workspace frictionless", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      clearOrgCache();
      const host = await linkHost(app, owner, { environmentId: randomUUID() });
      const [row] = await db.select().from(hosts).where(eq(hosts.id, host.id));
      expect(row?.discoverable).toBe(true);
    });
  });
});
