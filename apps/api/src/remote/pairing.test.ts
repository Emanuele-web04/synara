import { randomUUID } from "node:crypto";
import {
  EnvironmentId,
  type RemotePairingBundle,
  type DevicePublicKeyJwk,
} from "@synara/contracts";
import { eq } from "drizzle-orm";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../db";
import { runMigrations } from "../db/migrate";
import { devices, hosts, remotePairingCodes } from "../db/schema";
import type { HostRecord } from "../identity/interfaces";
import { createPairingRendezvous } from "./pairing";

const issuer = "https://api.example.test";
describe.skipIf(!process.env.TEST_DATABASE_URL)("pairing rendezvous (PostgreSQL)", () => {
  const database = createDb(process.env.TEST_DATABASE_URL ?? "postgres://unused");
  const service = createPairingRendezvous(database.db, issuer);
  beforeAll(() => runMigrations(process.env.TEST_DATABASE_URL!));
  afterAll(() => database.pool.end());
  async function fixture() {
    const id = randomUUID();
    const host: HostRecord = {
      id,
      ownerUserId: id,
      ownerOrgId: id,
      environmentId: id,
      keyGeneration: 1,
      discoverable: false,
      publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "fixture" },
    };
    await database.db
      .insert(hosts)
      .values({ ...host, name: "host", platform: "darwin", kind: "local" });
    const bundle: RemotePairingBundle = {
      v: 2,
      environmentId: EnvironmentId.makeUnsafe(id),
      rootFingerprint: "a".repeat(64),
      accountAuthority: issuer,
      userId: id,
      organizationId: id,
      channel: "dev",
      rootCertificate: "fixture root",
      hostId: id,
      label: "host",
      inviteId: randomUUID(),
      secret: "s".repeat(43),
      expiresAt: new Date(Date.now() + 590_000).toISOString(),
    };
    const keys = await generateKeyPair("ES256", { extractable: true });
    const jwk = (await exportJWK(keys.publicKey)) as DevicePublicKeyJwk;
    const jkt = await calculateJwkThumbprint(jwk);
    await database.db.insert(devices).values({
      userId: id,
      publicKeyJwk: jwk,
      jkt,
      displayName: "controller",
      platform: "darwin",
    });
    const session = { userId: id, orgId: id };
    const published = await service.publish(host, bundle);
    const proof = () =>
      new SignJWT({ code: published.code })
        .setProtectedHeader({ alg: "ES256", typ: "synara-pairing-code+jwt" })
        .setIssuer("synara-device")
        .setSubject(id)
        .setAudience(issuer)
        .setIssuedAt()
        .setExpirationTime("60s")
        .setJti(randomUUID())
        .sign(keys.privateKey);
    const redeem = async () => service.redeem(session, published.code, jkt, await proof());
    return { host, bundle, session, published, jkt, proof, redeem };
  }
  it("atomically delivers to one proven device, then refuses replay", async () => {
    const f = await fixture();
    expect(f.published.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const results = await Promise.allSettled([f.redeem(), f.redeem()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(f.redeem()).rejects.toThrow("invalid, used, or expired");
    const [row] = await database.db
      .select()
      .from(remotePairingCodes)
      .where(eq(remotePairingCodes.inviteId, f.bundle.inviteId));
    expect(row?.bundle).toBeNull();
    expect(row?.claimedJkt).toBe(f.jkt);
  });
  it("refuses another account, organization, or forged proof without spending the code", async () => {
    const f = await fixture();
    await expect(
      service.redeem({ ...f.session, userId: "other" }, f.published.code, f.jkt, await f.proof()),
    ).rejects.toThrow();
    await expect(
      service.redeem({ ...f.session, orgId: "other" }, f.published.code, f.jkt, await f.proof()),
    ).rejects.toThrow();
    await expect(service.redeem(f.session, f.published.code, f.jkt, "forged")).rejects.toThrow();
    expect(await f.redeem()).toEqual(f.bundle);
  });
  it("refuses expiry, cancellation, revoked device and replaced host identity", async () => {
    const expired = await fixture();
    await database.db
      .update(remotePairingCodes)
      .set({ expiresAt: new Date(0) })
      .where(eq(remotePairingCodes.inviteId, expired.bundle.inviteId));
    await expect(expired.redeem()).rejects.toThrow();
    const cancelled = await fixture();
    await service.cancel(cancelled.host, cancelled.bundle.inviteId);
    await expect(cancelled.redeem()).rejects.toThrow();
    const revoked = await fixture();
    await database.db
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(eq(devices.jkt, revoked.jkt));
    await expect(revoked.redeem()).rejects.toThrow();
    const replaced = await fixture();
    await database.db.update(hosts).set({ keyGeneration: 2 }).where(eq(hosts.id, replaced.host.id));
    await expect(replaced.redeem()).rejects.toThrow();
  });
  it("shares rate budgets across concurrent calls and service instances", async () => {
    const key = randomUUID();
    const other = createPairingRendezvous(database.db, issuer);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => (index % 2 ? other : service).consumeBudget(key, 5)),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
  });
  it("renewal cancels the earlier code", async () => {
    const f = await fixture();
    await service.publish(f.host, { ...f.bundle, inviteId: randomUUID() });
    await expect(f.redeem()).rejects.toThrow();
  });
});
