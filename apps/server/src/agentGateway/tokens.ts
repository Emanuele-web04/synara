/**
 * Legacy agent gateway token helpers.
 *
 * Kept only to verify and migrate historical token behavior in isolated tests.
 * Live gateway credentials are opaque, provider-session-lived, and held by
 * the in-memory AgentGatewaySessionRegistry; these helpers are not used for
 * live sessions.
 *
 * Format: `sagw_<base64url(threadId)>.<base64url(hmacSha256(secret, threadId))>`
 *
 * @module agentGateway/tokens
 */
import * as Crypto from "node:crypto";

const TOKEN_PREFIX = "sagw_";
const HMAC_CONTEXT = "synara-agent-gateway-v1";

function hmacForThreadId(secret: Uint8Array, threadId: string): Buffer {
  return Crypto.createHmac("sha256", secret).update(`${HMAC_CONTEXT}:${threadId}`).digest();
}

export function signAgentSessionToken(input: {
  readonly secret: Uint8Array;
  readonly threadId: string;
}): string {
  const threadIdPart = Buffer.from(input.threadId, "utf8").toString("base64url");
  const signaturePart = hmacForThreadId(input.secret, input.threadId).toString("base64url");
  return `${TOKEN_PREFIX}${threadIdPart}.${signaturePart}`;
}

export function verifyAgentSessionToken(input: {
  readonly secret: Uint8Array;
  readonly token: string;
}): string | null {
  if (!input.token.startsWith(TOKEN_PREFIX)) return null;
  const parts = input.token.slice(TOKEN_PREFIX.length).split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let threadId: string;
  let providedSignature: Buffer;
  try {
    threadId = Buffer.from(parts[0], "base64url").toString("utf8");
    providedSignature = Buffer.from(parts[1], "base64url");
  } catch {
    return null;
  }
  if (threadId.length === 0) return null;
  const expectedSignature = hmacForThreadId(input.secret, threadId);
  if (providedSignature.length !== expectedSignature.length) return null;
  if (!Crypto.timingSafeEqual(providedSignature, expectedSignature)) return null;
  return threadId;
}

export function extractBearerToken(authorizationHeader: string | undefined | null): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match?.[1]?.trim() || null;
}
