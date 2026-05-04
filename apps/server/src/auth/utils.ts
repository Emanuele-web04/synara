import type { AuthClientMetadata, AuthClientMetadataDeviceType } from "@t3tools/contracts";
import * as Crypto from "node:crypto";

const SESSION_COOKIE_NAME = "t3_session";

export function resolveSessionCookieName(input: {
  readonly mode: "web" | "desktop";
  readonly port: number;
}): string {
  return input.mode === "desktop" ? `${SESSION_COOKIE_NAME}_${input.port}` : SESSION_COOKIE_NAME;
}

export function base64UrlEncode(input: string | Uint8Array): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buffer.toString("base64url");
}

export function base64UrlDecodeUtf8(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

export function signPayload(payload: string, secret: Uint8Array): string {
  return Crypto.createHmac("sha256", Buffer.from(secret)).update(payload).digest("base64url");
}

export function timingSafeEqualBase64Url(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "base64url");
  const rightBuffer = Buffer.from(right, "base64url");
  return (
    leftBuffer.length === rightBuffer.length && Crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function normalizeNonEmptyString(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIpAddress(value: string | null | undefined): string | undefined {
  const normalized = normalizeNonEmptyString(value);
  return normalized?.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

function inferDeviceType(userAgent: string | undefined): AuthClientMetadataDeviceType {
  const normalized = userAgent?.toLowerCase() ?? "";
  if (!normalized) return "unknown";
  if (/bot|crawler|spider|slurp|curl|wget/.test(normalized)) return "bot";
  if (/ipad|tablet/.test(normalized)) return "tablet";
  if (/iphone|android.+mobile|mobile/.test(normalized)) return "mobile";
  return "desktop";
}

function inferBrowser(userAgent: string | undefined): string | undefined {
  const normalized = userAgent?.toLowerCase() ?? "";
  if (!normalized) return undefined;
  if (/edg\//.test(normalized)) return "Edge";
  if (/opr\//.test(normalized)) return "Opera";
  if (/firefox\//.test(normalized)) return "Firefox";
  if (/electron\//.test(normalized)) return "Electron";
  if (/chrome\//.test(normalized) || /crios\//.test(normalized)) return "Chrome";
  if (/safari\//.test(normalized) && !/chrome\//.test(normalized)) return "Safari";
  return undefined;
}

function inferOs(userAgent: string | undefined): string | undefined {
  const normalized = userAgent?.toLowerCase() ?? "";
  if (!normalized) return undefined;
  if (/iphone|ipad|ipod/.test(normalized)) return "iOS";
  if (/android/.test(normalized)) return "Android";
  if (/mac os x|macintosh/.test(normalized)) return "macOS";
  if (/windows nt/.test(normalized)) return "Windows";
  if (/linux/.test(normalized)) return "Linux";
  return undefined;
}

export function deriveAuthClientMetadata(input: {
  readonly headers: Record<string, string | undefined>;
  readonly remoteAddress?: string | null;
  readonly label?: string;
}): AuthClientMetadata {
  const userAgent = normalizeNonEmptyString(input.headers["user-agent"]);
  const ipAddress = normalizeIpAddress(input.remoteAddress);
  const os = inferOs(userAgent);
  const browser = inferBrowser(userAgent);

  return {
    ...(input.label ? { label: input.label } : {}),
    ...(ipAddress ? { ipAddress } : {}),
    ...(userAgent ? { userAgent } : {}),
    deviceType: inferDeviceType(userAgent),
    ...(os ? { os } : {}),
    ...(browser ? { browser } : {}),
  };
}
