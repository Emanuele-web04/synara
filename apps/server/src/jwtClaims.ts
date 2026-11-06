// FILE: jwtClaims.ts
// Purpose: Read the payload claims of a JWT the way provider CLIs store them
//   (Codex id and access tokens, Grok and Cursor sessions). Nothing here checks
//   the signature: the claims label a credential Synara already trusts, and
//   never decide authorization.
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
