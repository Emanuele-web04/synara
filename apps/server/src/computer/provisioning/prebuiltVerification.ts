/**
 * The checksum every shipped native binary is verified with.
 *
 * What the checksum is for: catching a bundle that arrived damaged. The
 * prebuilt binaries ship inside the application package next to the manifest
 * that names them, so the failure modes are a truncated or corrupted file in a
 * half-written update, a packaging step that copied the wrong build under a
 * name, or an unpacker that mangled bytes. Every one of those turns into a
 * compositor plugin that KWin refuses or, worse, loads and crashes on, and the
 * checksum turns them into a clear error before the file reaches the plugin
 * directory.
 *
 * What it is not for: tampering. Anyone who can alter a binary in the bundle
 * can alter the manifest beside it in the same operation, so a matching hash
 * proves the two agree with each other and nothing more. Provenance of the
 * bundle as a whole is the installer's and the platform's job (package
 * signatures, update signing), not this file's.
 *
 * The bytes are verified once and then written as-is by the caller: hashing a
 * path and then copying that path again would verify one read and install
 * another. Backend-agnostic, so it lives on its own rather than inside one
 * backend's provisioning module.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Common manifest fields, checked before a backend selects or reads a binary. */
export function isPrebuiltBinaryRecord(value: unknown): value is Record<string, unknown> & {
  readonly arch: string;
  readonly file: string;
  readonly sha256: string;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const { arch, file, sha256 } = value as Record<string, unknown>;
  return (
    typeof arch === "string" &&
    arch.trim() !== "" &&
    typeof file === "string" &&
    file.trim() !== "" &&
    !file.includes("/") &&
    !file.includes("\\") &&
    !file.includes("\0") &&
    file !== "." &&
    file !== ".." &&
    typeof sha256 === "string" &&
    SHA256_HEX.test(sha256)
  );
}

/** Whether `bytes` are the bytes the manifest describes. */
export function verifyPrebuiltBytes(bytes: Uint8Array, sha256: string): boolean {
  return createHash("sha256").update(bytes).digest("hex") === sha256;
}

/**
 * Reads a shipped binary and hands back its bytes only if they verify.
 *
 * The returned buffer is what gets installed, so there is exactly one read of
 * the file and it is the one that was checked. A file that cannot be read at
 * all is a miss rather than a throw, because every caller's next move is the
 * same as for a mismatch.
 */
export async function readVerifiedPrebuilt(
  path: string,
  sha256: string,
): Promise<Buffer | undefined> {
  const bytes = await readFile(path).catch(() => undefined);
  if (!bytes || !verifyPrebuiltBytes(bytes, sha256)) return undefined;
  return bytes;
}
