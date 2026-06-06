/**
 * Bearer-token authentication for every bridge route.
 *
 * The Synara server sends `Authorization: Bearer <BRIDGE_AUTH_TOKEN>` on each
 * HTTP request and as a query param (`?token=`) when opening the terminal
 * WebSocket (browsers cannot set headers on a WS handshake). Both are checked
 * with a constant-time comparison so a failed auth cannot be timed.
 *
 * @module auth
 */

/** Constant-time string compare to avoid leaking the token via timing. */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
};

const extractToken = (request: Request): string | null => {
  const header = request.headers.get("authorization");
  if (header !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  const url = new URL(request.url);
  return url.searchParams.get("token");
};

/** Whether a request carries the expected bearer token. */
export const isAuthorized = (request: Request, expected: string): boolean => {
  if (expected.length === 0) {
    return false;
  }
  const token = extractToken(request);
  return token !== null && timingSafeEqual(token, expected);
};
