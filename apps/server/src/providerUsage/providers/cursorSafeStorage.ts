// FILE: providerUsage/providers/cursorSafeStorage.ts
// Purpose: Cursor >= 3.27 seals `cursorAuth/accessToken` with Electron safeStorage when
// `cursor.storage.authTokenEncryptionAtRest` is on: the ItemTable cell becomes
// "cursor-safe-storage:v1:" + standard base64 of a Chromium os_crypt blob ("v10" on macOS,
// "v11" on Linux). Detects the seal, reads the "Cursor Safe Storage" login-keychain key
// through a bounded /usr/bin/security child (same shape as droidSecureStorage), and
// decrypts macOS v10 blobs (PBKDF2-HMAC-SHA1 salt "saltysalt" x1003 -> AES-128-CBC, IV =
// 16 space bytes). Unsupported platforms or versions resolve to null so the sealed text
// is never sent as a Bearer token.

import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import nodePath from "node:path";

import type { ProviderUsageContext } from "../types";

const SEALED_MARK = "cursor-safe-storage:";
const SEALED_V1_PREFIX = "cursor-safe-storage:v1:";
// Chromium os_crypt macOS parameters (shared by every Electron safeStorage consumer).
const OS_CRYPT_SALT = "saltysalt";
const OS_CRYPT_ITERATIONS = 1003;
const OS_CRYPT_IV = Buffer.alloc(16, 0x20);
const MAX_TOKEN_LENGTH = 8192;
// A plausible bearer credential: printable ASCII, no whitespace.
const TOKENISH = /^[\x21-\x7e]+$/u;

/**
 * True when a stored `cursorAuth/accessToken` cell is safe-storage sealed rather than a
 * usable token. Covers the documented `cursor-safe-storage:` text envelope and a raw
 * os_crypt blob coerced to UTF-8 (version tag followed by binary ciphertext).
 */
export function isCursorSafeStorageValue(value: string): boolean {
  if (value.startsWith(SEALED_MARK)) {
    return true;
  }
  return (value.startsWith("v10") || value.startsWith("v11")) && !TOKENISH.test(value);
}

/**
 * Read the "Cursor Safe Storage" generic-password key from the macOS login keychain.
 * Bounded like readDroidSecureKey: fixed executable, clean environment, no shell.
 */
export function readCursorSafeStorageKey(
  ctx: Pick<ProviderUsageContext, "platform" | "homeDir" | "env">,
): Promise<string | null> {
  if (ctx.platform !== "darwin") {
    return Promise.resolve(null);
  }
  const executable = "/usr/bin/security";
  const args = ["find-generic-password", "-s", "Cursor Safe Storage", "-a", "Cursor", "-w"];
  return new Promise((resolve) => {
    const child = execFile(
      executable,
      args,
      {
        env: { HOME: ctx.homeDir, PATH: "/usr/bin:/bin" },
        cwd: nodePath.parse(executable).root || undefined,
        encoding: "utf8",
        timeout: 3_000,
        killSignal: "SIGKILL",
        maxBuffer: 4_096,
        windowsHide: true,
      },
      (error, stdout) => {
        // Never propagate child errors: they can contain stdout/stderr and therefore the key.
        resolve(error ? null : stdout.trim());
      },
    );
    child.stdin?.end();
  });
}

/**
 * Decrypt a `cursor-safe-storage:v1:` cell with the login-keychain safe-storage password.
 * Returns the plaintext token, or null for unsupported versions/platforms, malformed
 * envelopes, wrong keys, and implausible plaintext — callers must not send the sealed
 * text upstream in any of those cases.
 */
export function decryptCursorSafeStorageToken(stored: string, password: string): string | null {
  if (!stored.startsWith(SEALED_V1_PREFIX)) {
    return null;
  }
  const encoded = stored.slice(SEALED_V1_PREFIX.length);
  let blob: Buffer;
  try {
    blob = Buffer.from(encoded, "base64");
    if (blob.length === 0 || blob.toString("base64") !== encoded) {
      return null;
    }
  } catch {
    return null;
  }
  const ciphertext = blob.subarray(3);
  if (
    !blob.subarray(0, 3).equals(Buffer.from("v10", "ascii")) ||
    ciphertext.length < 16 ||
    ciphertext.length % 16 !== 0
  ) {
    return null;
  }
  const key = pbkdf2Sync(password, OS_CRYPT_SALT, OS_CRYPT_ITERATIONS, 16, "sha1");
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, OS_CRYPT_IV);
    const text = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return text.length <= MAX_TOKEN_LENGTH && TOKENISH.test(text) ? text : null;
  } catch {
    return null;
  } finally {
    key.fill(0);
  }
}

/**
 * Unseal a safe-storage cell to a usable access token. Only the macOS v10 scheme is
 * supported; everything else (Linux v11, Windows DPAPI, unknown versions, isolation
 * contexts, denied keychain reads) resolves to null so callers fall through to the
 * generic keychain entry or needs-auth without sending the sealed text as Bearer.
 */
export async function unsealCursorSafeStorageValue(
  ctx: Pick<ProviderUsageContext, "platform" | "homeDir" | "env" | "isolateCredentials">,
  stored: string,
): Promise<string | null> {
  if (ctx.platform !== "darwin" || ctx.isolateCredentials) {
    return null;
  }
  const password = await readCursorSafeStorageKey(ctx);
  if (!password) {
    return null;
  }
  return decryptCursorSafeStorageToken(stored, password);
}
