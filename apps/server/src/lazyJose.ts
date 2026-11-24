// FILE: lazyJose.ts
// Purpose: Single memoized loader for `jose` plus zero-dependency unverified JWT payload decode.
// Layer: Server shared helper
// Exports: loadJose, decodeJwtPayloadUnsafe

import { lazyModule } from "./lazyModule.ts";

export type JoseModule = typeof import("jose");

/**
 * Loads `jose` on first remote-auth / pairing / host-identity operation (~20 ms
 * saved on local desktop boot where no JWT signing or verification runs).
 */
export const loadJose: () => Promise<JoseModule> = lazyModule(() => import("jose"));

/**
 * Decodes the payload segment of a compact JWS without verifying the signature.
 * Mirrors `jose.decodeJwt` validation without pulling `jose` onto the boot path.
 */
export function decodeJwtPayloadUnsafe(jwt: string): Record<string, unknown> {
  if (typeof jwt !== "string") {
    throw new TypeError("JWTs must use Compact JWS serialization, JWT must be a string");
  }
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("Invalid JWT");
  }
  const decoded: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("Invalid JWT Claims Set");
  }
  return decoded as Record<string, unknown>;
}
