import { randomUUID } from "node:crypto";

import {
  GRANT_JWT_TYP,
  HOST_CONNECT_SCOPE,
  SYNARA_RELAY_AUDIENCE,
  type ApiJwks,
} from "@synara/contracts";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { HostGrantVerifier } from "./grantVerifier";

const NOW = 1_800_000_000;
const API_ISSUER = "https://accounts.example.test";
const ENVIRONMENT_ID = "env-test";
const HOST_ID = "2f1f9dd7-56a5-45cf-b847-12e6658f3720";
const OWNER = "owner_1";

describe("HostGrantVerifier", () => {
  let apiKey: CryptoKey;
  let jwks: ApiJwks;
  let deviceJkt: string;

  beforeAll(async () => {
    const api = await generateKeyPair("EdDSA", { extractable: true });
    apiKey = api.privateKey;
    const publicJwk = await exportJWK(api.publicKey);
    jwks = {
      keys: [
        { kty: "OKP", crv: "Ed25519", x: publicJwk.x!, kid: "api-1", alg: "EdDSA", use: "sig" },
      ],
    };
    const device = await generateKeyPair("ES256", { extractable: true });
    deviceJkt = await calculateJwkThumbprint(await exportJWK(device.publicKey));
  });

  const grant = (
    claims: Partial<{ sub: string; jkt: string; hostId: string; environmentId: string }> = {},
    expiresAt = NOW + 60,
    jti = randomUUID(),
  ) =>
    new SignJWT({
      hostId: claims.hostId ?? HOST_ID,
      environmentId: claims.environmentId ?? ENVIRONMENT_ID,
      cnf: { jkt: claims.jkt ?? deviceJkt },
      scope: [HOST_CONNECT_SCOPE],
    })
      .setProtectedHeader({ alg: "EdDSA", typ: GRANT_JWT_TYP, kid: "api-1" })
      .setIssuer(API_ISSUER)
      .setSubject(claims.sub ?? OWNER)
      .setAudience(SYNARA_RELAY_AUDIENCE)
      .setIssuedAt(expiresAt - 60)
      .setExpirationTime(expiresAt)
      .setJti(jti)
      .sign(apiKey);

  const verifier = () =>
    new HostGrantVerifier({
      apiIssuer: API_ISSUER,
      environmentId: ENVIRONMENT_ID,
      hostId: HOST_ID,
      ownerUserId: OWNER,
      getApiJwks: async () => jwks,
      nowSeconds: () => NOW,
    });

  it("accepts the owner's grant for the presented device key", async () => {
    await expect(verifier().verify(await grant(), { deviceJkt })).resolves.toMatchObject({
      sub: OWNER,
      cnf: { jkt: deviceJkt },
    });
  });

  it("refuses another account's grant", async () => {
    await expect(
      verifier().verify(await grant({ sub: "someone-else" }), { deviceJkt }),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });

  it("refuses a grant whose subject differs from the presented one", async () => {
    await expect(
      verifier().verify(await grant(), { deviceJkt, subject: "someone-else" }),
    ).rejects.toThrow(/not bound/);
  });

  it.each([
    ["another device key", { jkt: "another-device" }],
    ["another host", { hostId: randomUUID() }],
    ["another environment", { environmentId: "env-other" }],
  ])("refuses a grant bound to %s", async (_label, claims) => {
    await expect(verifier().verify(await grant(claims), { deviceJkt })).rejects.toThrow(
      /not bound/,
    );
  });

  it("refuses an expired grant", async () => {
    await expect(verifier().verify(await grant({}, NOW - 120), { deviceJkt })).rejects.toThrow();
  });

  it("spends a grant once across every caller sharing the verifier", async () => {
    const shared = verifier();
    const claims = await shared.verify(await grant(), { deviceJkt });
    shared.consume(claims);
    expect(() => shared.consume(claims)).toThrow(/already been used/);
  });
});
