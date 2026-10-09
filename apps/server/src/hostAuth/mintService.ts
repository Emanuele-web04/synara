import { randomUUID } from "node:crypto";

import {
  HOST_CONNECT_SCOPE,
  JWT_CLOCK_TOLERANCE_SECONDS,
  MintRequestClaims,
  MINT_REQUEST_JWT_TYP,
  MINT_REQUEST_MAX_AGE_SECONDS,
  SESSION_CREDENTIAL_JWT_TYP,
  SESSION_CREDENTIAL_MAX_AGE_SECONDS,
  SYNARA_DEVICE_ISSUER,
  SYNARA_SESSION_AUDIENCE,
  type DevicePublicKeyJwk,
  type GrantClaims,
} from "@synara/contracts";
import { Schema } from "effect";
import {
  calculateJwkThumbprint,
  importJWK,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTHeaderParameters,
} from "jose";

import type { HostIdentity } from "../hostIdentity";
import {
  assertBoundedLifetime,
  HostGrantVerifier,
  HostMintError,
  type HostGrantVerifierOptions,
} from "./grantVerifier";

function hostIssuer(environmentId: string): string {
  return `synara-host:${environmentId}`;
}

async function deviceVerificationKey(jwk: DevicePublicKeyJwk): Promise<CryptoKey> {
  return importJWK(jwk as JWK, jwk.kty === "EC" ? "ES256" : "EdDSA") as Promise<CryptoKey>;
}

function assertDeviceHeader(header: JWTHeaderParameters, jwk: DevicePublicKeyJwk): void {
  const expectedAlgorithm = jwk.kty === "EC" ? "ES256" : "EdDSA";
  if (header.typ !== MINT_REQUEST_JWT_TYP || header.alg !== expectedAlgorithm) {
    throw new Error("mint request protected header is invalid");
  }
}

export interface HostMintServiceOptions extends HostGrantVerifierOptions {
  readonly identity: HostIdentity;
  readonly keyGeneration: number;
  readonly authorizeDevice: (userId: string, deviceJkt: string) => Promise<number>;
  /** Shared with pairing so one grant jti cannot be spent twice across both paths. */
  readonly grants?: HostGrantVerifier;
}

export interface MintedSessionCredential {
  readonly credential: string;
  readonly userId: string;
  readonly deviceJkt: string;
  readonly expiresAtSeconds: number;
}

export class HostMintService {
  readonly #grants: HostGrantVerifier;

  constructor(readonly options: HostMintServiceOptions) {
    this.#grants = options.grants ?? new HostGrantVerifier(options);
  }

  async mint(mintRequestJwt: string): Promise<MintedSessionCredential> {
    const now = this.#grants.now();
    let grant: GrantClaims;
    let deviceJkt: string;
    let trustGeneration: number;
    try {
      const unverifiedParts = mintRequestJwt.split(".");
      if (unverifiedParts.length !== 3) throw new Error("mint request is not a compact JWT");
      const unverifiedPayload = JSON.parse(
        Buffer.from(unverifiedParts[1] ?? "", "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      const publicKeyJwk = Schema.decodeUnknownSync(MintRequestClaims.fields.publicKeyJwk)(
        unverifiedPayload.publicKeyJwk,
      );
      const mintVerified = await jwtVerify(
        mintRequestJwt,
        await deviceVerificationKey(publicKeyJwk),
        {
          algorithms: [publicKeyJwk.kty === "EC" ? "ES256" : "EdDSA"],
          audience: hostIssuer(this.options.environmentId),
          issuer: SYNARA_DEVICE_ISSUER,
          clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
        },
      );
      assertDeviceHeader(mintVerified.protectedHeader, publicKeyJwk);
      const mint = Schema.decodeUnknownSync(MintRequestClaims)(mintVerified.payload);
      assertBoundedLifetime(mint, MINT_REQUEST_MAX_AGE_SECONDS, "mint request", now);
      deviceJkt = await calculateJwkThumbprint(publicKeyJwk as JWK, "sha256");
      grant = await this.#grants.verify(mint.grant, { deviceJkt, subject: mint.sub }, now);
      try {
        trustGeneration = await this.options.authorizeDevice(grant.sub, deviceJkt);
      } catch (cause) {
        throw new HostMintError("not_authorized", "Device has no current local approval", {
          cause,
        });
      }
      if (!Number.isSafeInteger(trustGeneration) || trustGeneration < 1) {
        throw new HostMintError("not_authorized", "Device has no local approval");
      }

      this.#grants.consume(grant, now);
    } catch (cause) {
      if (cause instanceof HostMintError) throw cause;
      const message = cause instanceof Error ? cause.message : "invalid mint request";
      const code =
        message.includes("grant") || message.includes("jti")
          ? "invalid_grant"
          : "invalid_mint_request";
      throw new HostMintError(code, message, { cause });
    }

    const expiresAtSeconds = now + SESSION_CREDENTIAL_MAX_AGE_SECONDS;
    const credential = await new SignJWT({
      trustGeneration,
      cnf: { jkt: deviceJkt },
      keyGeneration: this.options.keyGeneration,
      scope: [HOST_CONNECT_SCOPE],
    })
      .setProtectedHeader({ alg: "EdDSA", typ: SESSION_CREDENTIAL_JWT_TYP })
      .setIssuer(hostIssuer(this.options.environmentId))
      .setSubject(grant.sub)
      .setAudience(SYNARA_SESSION_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(expiresAtSeconds)
      .setJti(randomUUID())
      .sign(await importPKCS8(this.options.identity.privateKeyPem, "EdDSA"));
    return { credential, userId: grant.sub, deviceJkt, expiresAtSeconds };
  }
}
