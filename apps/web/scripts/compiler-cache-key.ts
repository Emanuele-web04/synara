// FILE: compiler-cache-key.ts
// Purpose: Fingerprint the inputs shared by the CI archive and React Compiler cache.
// Layer: Web build config. Runs with Node before workspace dependencies install.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeBunLockfile } from "../../../scripts/bun-lockfile.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const inputFiles = [
  "package.json",
  "scripts/bun-lockfile.ts",
  "apps/web/scripts/react-compiler-vite.ts",
  "apps/web/scripts/compiler-cache-key.ts",
  "apps/web/scripts/react-compiler-plugin.mjs",
  "apps/web/scripts/transform-cache.ts",
  "apps/web/scripts/parallel-transform.ts",
  "apps/web/scripts/parallel-transform.worker.mjs",
];

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
  hash.update(normalizeBunLockfile(readFileSync(join(root, "bun.lock"), "utf8")));
  return hash.digest("hex");
}

if (import.meta.main) {
  process.stdout.write(`${compilerCacheFingerprint()}\n`);
}
