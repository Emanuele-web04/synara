// FILE: compiler-cache-key.ts
// Purpose: Fingerprint the inputs shared by the CI archive and React Compiler cache.
// Layer: Web build config. Runs with Node before workspace dependencies install.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const inputFiles = [
  "package.json",
  "apps/web/vite.config.ts",
  "apps/web/scripts/compiler-cache-key.ts",
  "apps/web/scripts/react-compiler-plugin.mjs",
  "apps/web/scripts/transform-cache.ts",
  "apps/web/scripts/parallel-transform.ts",
  "apps/web/scripts/parallel-transform.worker.mjs",
];

function compilerLockfile(contents: string): string {
  try {
    // Bun's generated lockfile permits trailing commas. Match quoted strings
    // first so dependency values and integrity strings are preserved verbatim.
    const lockfile = JSON.parse(
      contents.replace(/"(?:[^"\\]|\\.)*"|,(?=\s*[}\]])/g, (token) => (token === "," ? "" : token)),
    ) as { lockfileVersion?: number; workspaces?: Record<string, { version?: string }> };
    if (lockfile.lockfileVersion !== 3 || !lockfile.workspaces) return contents;
    for (const workspace of Object.values(lockfile.workspaces)) {
      if (typeof workspace.version === "string") delete workspace.version;
    }
    return JSON.stringify(lockfile);
  } catch {
    // Unrecognized lockfile syntax still invalidates on every byte change.
    return contents;
  }
}

export function compilerCacheFingerprint(root = repository) {
  const hash = createHash("sha256").update(process.versions.node).update("\0");
  const patches = readdirSync(join(root, "patches"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .toSorted();
  for (const name of [...inputFiles, ...patches]) {
    hash
      .update(name)
      .update("\0")
      .update(readFileSync(join(root, name)))
      .update("\0");
  }
  hash.update(compilerLockfile(readFileSync(join(root, "bun.lock"), "utf8")));
  return hash.digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${compilerCacheFingerprint()}\n`);
}
