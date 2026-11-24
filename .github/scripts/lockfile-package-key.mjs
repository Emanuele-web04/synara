// Fingerprint the bun.lock resolutions of named packages for runtime caches.
// Electron's download depends only on its own entries, so a release bump that
// rewrites workspace versions keeps the key.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Entry keys are a package name, optionally under a parent path for nested
// resolutions: "playwright-core", "betterwright/playwright-core", "@scope/pkg".
function packageName(key) {
  const segments = key.split("/");
  const scope = segments.at(-2);
  return scope?.startsWith("@") ? `${scope}/${segments.at(-1)}` : segments.at(-1);
}

/** Hashes every lockfile entry for `names`, including nested resolutions. */
export function lockfilePackageFingerprint(contents, names) {
  if (names.length === 0) throw new Error("Name at least one package.");
  const entries = contents.split("\n").filter((line) => {
    const key = /^\s*"([^"]+)": \[/.exec(line)?.[1];
    return key !== undefined && names.includes(packageName(key));
  });
  if (entries.length === 0) throw new Error(`bun.lock has no entry for ${names.join(", ")}.`);
  return createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 32);
}

if (import.meta.main) {
  const contents = readFileSync("bun.lock", "utf8");
  process.stdout.write(`${lockfilePackageFingerprint(contents, process.argv.slice(2))}\n`);
}
