// A stable, anonymous id for the physical computer this server runs on, so a phone can tell
// that two pairings (a reinstall, a development build next to the app) are the same Mac while
// two Macs that share a name stay apart. The platform's hardware id is salted and hashed: the
// raw value never leaves the machine. Unreadable ids are omitted, never invented.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const MACHINE_ID_SALT = "synara-machine-id-v1:";
const READ_TIMEOUT_MS = 3_000;

/** The salted SHA-256 of a raw hardware id, 32 hex characters, or undefined for an empty one. */
export function hashMachineId(raw: string): string | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  return createHash("sha256")
    .update(MACHINE_ID_SALT + normalized)
    .digest("hex")
    .slice(0, 32);
}

/** `IOPlatformUUID` out of `ioreg -rd1 -c IOPlatformExpertDevice`. */
export function parseIoregPlatformUuid(output: string): string | undefined {
  return /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/u.exec(output)?.[1];
}

/** `MachineGuid` out of `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid`. */
export function parseWindowsMachineGuid(output: string): string | undefined {
  return /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{36})/u.exec(output)?.[1];
}

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: READ_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function readRawMachineId(): Promise<string | undefined> {
  switch (process.platform) {
    case "darwin":
      return parseIoregPlatformUuid(
        await run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]),
      );
    case "linux":
      for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        const value = (await readFile(path, "utf8").catch(() => "")).trim();
        if (value) return value;
      }
      return undefined;
    case "win32":
      return parseWindowsMachineGuid(
        await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]),
      );
    default:
      return undefined;
  }
}

/** This computer's machine id, or undefined when the platform will not say. Never rejects. */
export async function readMachineId(): Promise<string | undefined> {
  try {
    const raw = await readRawMachineId();
    return raw ? hashMachineId(raw) : undefined;
  } catch {
    return undefined;
  }
}
