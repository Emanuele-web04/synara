// FILE: updateArtifactIdentity.ts
// Purpose: Fingerprints a downloaded updater payload and detects path/byte replacement.
// Layer: Desktop update utility

import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";

export interface UpdateArtifactIdentity {
  readonly path: string;
  readonly size: number;
  readonly sha512: string;
}

const SHA512_HEX_PATTERN = /^[0-9a-f]{128}$/;

export function isUpdateArtifactIdentity(value: unknown): value is UpdateArtifactIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.path === "string" &&
    identity.path.length > 0 &&
    resolve(identity.path) === identity.path &&
    typeof identity.size === "number" &&
    Number.isSafeInteger(identity.size) &&
    identity.size > 0 &&
    typeof identity.sha512 === "string" &&
    SHA512_HEX_PATTERN.test(identity.sha512)
  );
}

export function updateArtifactIdentitiesEqual(
  left: UpdateArtifactIdentity,
  right: UpdateArtifactIdentity,
): boolean {
  return left.path === right.path && left.size === right.size && left.sha512 === right.sha512;
}

export async function fingerprintUpdateArtifact(filePath: string): Promise<UpdateArtifactIdentity> {
  const resolvedPath = resolve(filePath);
  const pathEntryBefore = await lstat(resolvedPath);
  if (!pathEntryBefore.isFile() || pathEntryBefore.isSymbolicLink()) {
    throw new Error("Downloaded update payload must be a regular, non-symlink file.");
  }

  const handle = await open(resolvedPath, "r");
  try {
    const openedBefore = await handle.stat();
    if (!openedBefore.isFile() || openedBefore.size === 0) {
      throw new Error("Downloaded update payload is not a regular file.");
    }
    if (
      openedBefore.dev !== pathEntryBefore.dev ||
      (openedBefore.ino !== 0 &&
        pathEntryBefore.ino !== 0 &&
        openedBefore.ino !== pathEntryBefore.ino)
    ) {
      throw new Error("Downloaded update payload changed while it was opened.");
    }

    const hash = createHash("sha512");
    const stream = handle.createReadStream({ autoClose: false });
    await new Promise<void>((resolveHash, rejectHash) => {
      stream.on("data", (chunk) => hash.update(chunk));
      stream.once("error", rejectHash);
      stream.once("end", resolveHash);
    });

    const openedAfter = await handle.stat();
    const pathEntryAfter = await lstat(resolvedPath);
    if (
      openedAfter.size !== openedBefore.size ||
      openedAfter.mtimeMs !== openedBefore.mtimeMs ||
      !pathEntryAfter.isFile() ||
      pathEntryAfter.isSymbolicLink() ||
      pathEntryAfter.dev !== openedAfter.dev ||
      (pathEntryAfter.ino !== 0 && openedAfter.ino !== 0 && pathEntryAfter.ino !== openedAfter.ino)
    ) {
      throw new Error("Downloaded update payload changed while it was fingerprinted.");
    }

    return {
      path: resolvedPath,
      size: openedAfter.size,
      sha512: hash.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

export async function verifyUpdateArtifactIdentity(
  expected: UpdateArtifactIdentity,
): Promise<boolean> {
  if (!isUpdateArtifactIdentity(expected)) return false;
  try {
    const actual = await fingerprintUpdateArtifact(expected.path);
    return actual.size === expected.size && actual.sha512 === expected.sha512;
  } catch {
    return false;
  }
}
