// FILE: providerUsage/credentials.ts
// Purpose: Credential resolution helpers for the usage fetchers — JSON files, macOS Keychain
// reads (via the `security` CLI), OAuth refresh, JWT expiry decoding, and hex/JSON keychain
// payload decoding. Helpers are defensive and resolve to null/false on failure.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KEYCHAIN_TIMEOUT_MS = 5_000;
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 15_000;

export interface OAuthRefreshAccessTokenResult {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAtMs?: number;
}

export async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Refresh an OAuth access token with the provider's token endpoint. Never logs secrets. */
export async function refreshOAuthAccessToken(input: {
  refreshUrl: string;
  refreshToken: string;
  clientId: string;
  scope?: string;
  timeoutMs?: number;
}): Promise<OAuthRefreshAccessTokenResult | null> {
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  };
  if (input.scope) {
    body.scope = input.scope;
  }

  let response: Response;
  try {
    response = await fetch(input.refreshUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_OAUTH_REFRESH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok || !json || typeof json !== "object") {
    return null;
  }

  const record = json as Record<string, unknown>;
  const accessToken =
    typeof record.access_token === "string" && record.access_token.trim().length > 0
      ? record.access_token.trim()
      : null;
  if (!accessToken) {
    return null;
  }

  const refreshToken =
    typeof record.refresh_token === "string" && record.refresh_token.trim().length > 0
      ? record.refresh_token.trim()
      : undefined;
  const expiresInSeconds =
    typeof record.expires_in === "number" && Number.isFinite(record.expires_in)
      ? record.expires_in
      : undefined;

  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresInSeconds !== undefined
      ? { expiresAtMs: Date.now() + expiresInSeconds * 1000 }
      : {}),
  };
}

/**
 * Read a generic-password secret from the macOS Keychain. Returns the raw secret string (the
 * caller decodes hex/JSON as needed), or null on any platform other than darwin / on failure.
 * Read-only: we never call `add-generic-password`.
 */
export async function readKeychainPassword(input: {
  service: string;
  account?: string;
  platform: NodeJS.Platform;
}): Promise<string | null> {
  if (input.platform !== "darwin") {
    return null;
  }
  const args = ["find-generic-password", "-s", input.service, "-w"];
  if (input.account) {
    args.push("-a", input.account);
  }
  try {
    const { stdout } = await execFileAsync("security", args, { timeout: KEYCHAIN_TIMEOUT_MS });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Some CLIs store the JSON credential in the keychain hex-encoded (Claude Code on macOS),
 * others store raw JSON. Try direct JSON first, then hex-decode then parse.
 */
export function decodeKeychainJson(value: string): unknown | null {
  const trimmed = value.trim();
  const tryParse = (candidate: string): unknown | null => {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  };

  const direct = tryParse(trimmed);
  if (direct !== null) {
    return direct;
  }

  const hex = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  if (hex.length % 2 === 0 && /^[0-9a-fA-F]+$/u.test(hex)) {
    try {
      return tryParse(Buffer.from(hex, "hex").toString("utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

/** Decode a JWT's `exp` claim into epoch milliseconds, or null when not parseable. */
export function decodeJwtExpMs(jwt: string | undefined): number | null {
  if (!jwt) {
    return null;
  }
  const parts = jwt.split(".");
  const payloadPart = parts[1];
  if (!payloadPart) {
    return null;
  }
  try {
    const base64 = payloadPart.replace(/-/gu, "+").replace(/_/gu, "/");
    const payload = JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}
