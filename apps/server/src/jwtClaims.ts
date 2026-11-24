// FILE: jwtClaims.ts
// Purpose: Read the payload claims of a JWT that a provider CLI stores. Nothing
//   here checks the signature, so the claims must never decide authorization.
// Layer: Server utility (no IO)

import { decodeJwt } from "jose";

/** The payload claims of a JWT, or undefined when the token cannot be read as one. */
export function decodeJwtClaims(jwt: string | undefined): Record<string, unknown> | undefined {
  if (jwt === undefined) return undefined;
  try {
    return decodeJwt(jwt);
  } catch {
    return undefined;
  }
}
