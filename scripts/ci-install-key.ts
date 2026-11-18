// Fingerprint exact node_modules archives before installing workspace dependencies.

import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeBunLockfile } from "./bun-lockfile.ts";

const repository = fileURLToPath(new URL("../", import.meta.url));

export function workspaceInstallFingerprint(root = repository): string {
  const rootManifest = readFileSync(join(root, "package.json"), "utf8");
  const configuration = JSON.parse(rootManifest) as {
    workspaces: string[] | { packages: string[] };
    patchedDependencies?: Record<string, string>;
  };
  const workspaces = Array.isArray(configuration.workspaces)
    ? configuration.workspaces
    : configuration.workspaces.packages;
  const manifests = globSync(
    workspaces.map((workspace) => `${workspace}/package.json`),
    {
      cwd: root,
    },
  ).toSorted();
  const patches = Object.values(configuration.patchedDependencies ?? {}).toSorted();
  const hash = createHash("sha256");
  hash.update(process.versions.modules).update("\0");
  hash.update(rootManifest).update("\0");
  hash.update(normalizeBunLockfile(readFileSync(join(root, "bun.lock"), "utf8"))).update("\0");
  for (const name of ["bunfig.toml", "scripts/patch-workspace-typescript.ts", ...patches]) {
    hash
      .update(name)
      .update("\0")
      .update(readFileSync(join(root, name)))
      .update("\0");
  }
  for (const name of manifests) {
    const manifest = JSON.parse(readFileSync(join(root, name), "utf8")) as { version?: string };
    // Workspace links point to the current checkout. Release versions are read there.
    if (typeof manifest.version === "string") delete manifest.version;
    hash.update(name).update("\0").update(JSON.stringify(manifest)).update("\0");
  }
  return hash.digest("hex");
}

if (import.meta.main) {
  process.stdout.write(`${workspaceInstallFingerprint()}\n`);
}
