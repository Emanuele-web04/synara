import {
  GrantClaims,
  GRANT_JWT_TYP,
  GRANT_MAX_AGE_SECONDS,
  JWT_CLOCK_TOLERANCE_SECONDS,
  SYNARA_RELAY_AUDIENCE,
  type ApiJwks,
} from "@synara/contracts";
import { Schema } from "effect";
import { createLocalJWKSet, errors, jwtVerify } from "jose";

import { JwtReplayCache } from "./replayCache";

/** jose's unknown-kid signal, matching the relay's detection. */
function isUnknownKidError(error: unknown): boolean {
  return (
    error instanceof errors.JWKSNoMatchingKey ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ERR_JWKS_NO_MATCHING_KEY")
  );
}

export class HostMintError extends Error {
  constructor(
    readonly code: "invalid_grant" | "invalid_mint_request" | "not_authorized",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostMintError";
  }
}

export function assertBoundedLifetime(
  claims: { iat: number; exp: number },
  maximumSeconds: number,
  label: string,
  nowSeconds: number,
): void {
  if (claims.exp <= claims.iat || claims.exp - claims.iat > maximumSeconds) {
    throw new Error(`${label} lifetime exceeds ${maximumSeconds}s`);
  }
  if (claims.iat > nowSeconds + JWT_CLOCK_TOLERANCE_SECONDS) {
    throw new Error(`${label} iat is too far in the future`);
  }
  if (claims.exp < nowSeconds) {
    throw new Error(`${label} has expired`);
  }
}

export interface HostGrantVerifierOptions {
  readonly apiIssuer: string;
  readonly environmentId: string;
  readonly hostId: string;
  /**
   * The owner recorded when this host was linked. Authoritative for the
   * owner path: it changes only through a re-link, which requires this
   * host's key, so no cloud-side compromise or outage can alter it.
   */
  readonly ownerUserId: string;
  readonly getApiJwks: () => Promise<ApiJwks>;
  /** Forced refetch when a grant names a kid we do not hold (key rotation). */
  readonly refreshApiJwksForUnknownKid?: () => Promise<ApiJwks | undefined>;
  readonly replayCache?: JwtReplayCache;
  readonly nowSeconds?: () => number;
}

/**
 * Verifies account-signed host grants for the owner's device keys. One
 * instance backs both session minting and pairing so a grant jti is spent once.
 */
export class HostGrantVerifier {
  readonly #replays: JwtReplayCache;

  constructor(readonly options: HostGrantVerifierOptions) {
    this.#replays = options.replayCache ?? new JwtReplayCache();
  }

  now(): number {
    return this.options.nowSeconds?.() ?? Math.floor(Date.now() / 1_000);
  }

  /**
   * Checks signature, lifetime, host/environment binding, the device key
   * thumbprint and, when given, the subject presented alongside the grant.
   * Does not spend the jti; call {@link consume} once the caller accepts it.
   */
  async verify(
    grantJwt: string,
    binding: { deviceJkt: string; subject?: string },
    now = this.now(),
  ): Promise<GrantClaims> {
    const verifyGrant = async (jwks: ApiJwks) =>
      jwtVerify(grantJwt, createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]), {
        algorithms: ["EdDSA"],
        audience: SYNARA_RELAY_AUDIENCE,
        issuer: this.options.apiIssuer,
        typ: GRANT_JWT_TYP,
        clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
      });
    let grantVerified: Awaited<ReturnType<typeof verifyGrant>>;
    try {
      grantVerified = await verifyGrant(await this.options.getApiJwks());
    } catch (cause) {
      // An unknown `kid` means the API rotated its signing key. Without a
      // forced refetch every grant fails until the periodic refresh window
      // elapses — a total outage of remote access after a routine rotation.
      const rotated =
        isUnknownKidError(cause) && (await this.options.refreshApiJwksForUnknownKid?.());
      if (!rotated) throw cause;
      grantVerified = await verifyGrant(rotated);
    }
    const grant = Schema.decodeUnknownSync(GrantClaims)(grantVerified.payload);
    assertBoundedLifetime(grant, GRANT_MAX_AGE_SECONDS, "grant", now);
    if (
      grant.hostId !== this.options.hostId ||
      grant.environmentId !== this.options.environmentId ||
      (binding.subject !== undefined && grant.sub !== binding.subject) ||
      grant.cnf.jkt !== binding.deviceJkt
    ) {
      throw new Error("grant is not bound to this host, user, and device key");
    }
    if (grant.sub !== this.options.ownerUserId) {
      throw new HostMintError(
        "not_authorized",
        "Only the locally linked owner can access this host",
      );
    }
    return grant;
  }

  consume(grant: GrantClaims, now = this.now()): void {
    this.#replays.consume(grant.jti, grant.exp, now);
  }
}
