import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { promisify } from "node:util";

import { fetchJson } from "./http";

const execFileAsync = promisify(execFile);

const KEYCHAIN_TIMEOUT_MS = 5_000;
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 15_000;

/** non-secret identity for cache partitioning without retaining credentials */
export function credentialFingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url").slice(0, 18);
}

export type OAuthRefreshResult =
  | {
      readonly ok: true;
      readonly accessToken: string;
      readonly refreshToken?: string;
      readonly idToken?: string;
      readonly expiresAtMs?: number;
    }
  | {
      readonly ok: false;
      /** undefined on a transport failure */
      readonly status?: number;
      /** OAuth error code from a 4xx body, when identifiable */
      readonly errorCode?: string;
    };

export async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** atomic temp-file + rename with owner-only permissions — a crash can't leave a truncated auth file; throws on failure */
export async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  const directory = nodePath.dirname(path);
  const tempPath = nodePath.join(
    directory,
    `.${nodePath.basename(path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await fs.writeFile(tempPath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(tempPath, path);
  } catch (cause) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw cause;
  }
}

/** tolerates {error:{code}}, {error:{error}}, {error:"code"}, {code} */
function oauthErrorCode(json: unknown): string | undefined {
  if (!json || typeof json !== "object") {
    return undefined;
  }
  const record = json as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  if (error && typeof error === "object") {
    const nested = error as Record<string, unknown>;
    const code = nested.code ?? nested.error;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return typeof record.code === "string" && record.code.length > 0 ? record.code : undefined;
}

/** never logs secrets; discriminates a dead refresh token (re-read the CLI's rotated credential) from a transient failure (retry later) */
export async function refreshOAuthAccessToken(input: {
  service: string;
  refreshUrl: string;
  allowedOrigins: ReadonlyArray<string>;
  refreshToken: string;
  clientId: string;
  /** Google-style endpoints require the confidential-client secret next to `client_id` */
  clientSecret?: string;
  scope?: string;
  /** OAuth token endpoints commonly require form encoding; JSON for the rest */
  bodyFormat?: "json" | "form";
  timeoutMs?: number;
}): Promise<OAuthRefreshResult> {
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  };
  if (input.clientSecret) {
    body.client_secret = input.clientSecret;
  }
  if (input.scope) {
    body.scope = input.scope;
  }
  const bodyFormat = input.bodyFormat ?? "json";

  let response: Awaited<ReturnType<typeof fetchJson>>;
  try {
    response = await fetchJson({
      service: input.service,
      url: input.refreshUrl,
      allowedOrigins: input.allowedOrigins,
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type":
          bodyFormat === "form" ? "application/x-www-form-urlencoded" : "application/json",
      },
      body,
      bodyFormat,
      timeoutMs: input.timeoutMs ?? DEFAULT_OAUTH_REFRESH_TIMEOUT_MS,
    });
  } catch {
    return { ok: false };
  }

  if (!response.ok) {
    const errorCode = response.status < 500 ? oauthErrorCode(response.json) : undefined;
    return { ok: false, status: response.status, ...(errorCode ? { errorCode } : {}) };
  }
  const json = response.json;
  if (!json || typeof json !== "object") {
    return { ok: false, status: response.status };
  }

  const record = json as Record<string, unknown>;
  const asToken = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  const accessToken = asToken(record.access_token);
  if (!accessToken) {
    return { ok: false, status: response.status };
  }

  const refreshToken = asToken(record.refresh_token);
  const idToken = asToken(record.id_token);
  const expiresInSeconds =
    typeof record.expires_in === "number" && Number.isFinite(record.expires_in)
      ? record.expires_in
      : undefined;

  return {
    ok: true,
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(idToken ? { idToken } : {}),
    ...(expiresInSeconds !== undefined
      ? { expiresAtMs: Date.now() + expiresInSeconds * 1000 }
      : {}),
  };
}

/** read-only — never calls add-generic-password; null off darwin or on failure */
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

/** JWT `exp` → epoch ms, or null when unparseable */
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
