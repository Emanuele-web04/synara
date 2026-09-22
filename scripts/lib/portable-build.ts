// Same-run release outputs only: no dependencies or native compilation products.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PORTABLE_BUILD_ROOTS = ["apps/desktop/dist-electron", "apps/server/dist"] as const;
const required = [
  "apps/desktop/dist-electron/main.js",
  "apps/desktop/dist-electron/preload.js",
  "apps/desktop/dist-electron/guestPreload.js",
  "apps/desktop/dist-electron/cuaDriverHostStandalone.js",
  "apps/server/dist/index.mjs",
  "apps/server/dist/restoreMigrationBackup.mjs",
  "apps/server/dist/runtimeDependencySmoke.mjs",
  "apps/server/dist/client/index.html",
  "apps/server/dist/device-helper/build.sh",
];
const buildVariables = [
  "AZURE_TRUSTED_SIGNING_SUBJECT_DN",
  "SYNARA_WEB_SOURCEMAP",
  "SYNARA_SERVER_SOURCEMAP",
  "SYNARA_DESKTOP_SOURCEMAP",
  "VITE_WS_URL",
];
export const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export function portableBuildManifest(
  root: string,
  sourceCommit: string,
  env: NodeJS.ProcessEnv = process.env,
  sourceRoot: string = root,
) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit))
    throw new Error("Portable build requires the exact source commit.");
  const files: Record<string, { sha256: string; executable: boolean }> = {};
  function visit(relative: string) {
    const path = join(root, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Portable build contains a symlink: ${relative}`);
    if (stat.isDirectory()) {
      if (relative.split("/").includes("node_modules"))
        throw new Error("Portable build contains dependencies.");
      for (const entry of readdirSync(path).toSorted()) visit(`${relative}/${entry}`);
    } else if (stat.isFile()) {
      if (/\.(node|dylib|so|exe)$/i.test(relative))
        throw new Error(`Portable build contains a native binary: ${relative}`);
      const bytes = readFileSync(path);
      const magic = bytes.subarray(0, 4).toString("hex");
      if (
        ["7f454c46", "cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe"].includes(magic) ||
        bytes.subarray(0, 2).toString() === "MZ"
      ) {
        throw new Error(`Portable build contains a native binary: ${relative}`);
      }
      // GitHub zip artifacts lose modes. Transfer the tree as tar, and assert
      // executable scripts explicitly on Unix (Windows has no POSIX mode).
      files[relative] = { sha256: sha256(bytes), executable: relative.endsWith(".sh") };
      if (process.platform !== "win32" && relative.endsWith(".sh") && !(stat.mode & 0o111))
        throw new Error(`Portable script is not executable: ${relative}`);
    } else throw new Error(`Portable build contains a special file: ${relative}`);
  }
  for (const dir of PORTABLE_BUILD_ROOTS) visit(dir);
  for (const path of required)
    if (!files[path]) throw new Error(`Missing portable build output: ${path}`);
  return {
    schemaVersion: 1,
    sourceCommit,
    lockfileSha256: sha256(readFileSync(join(sourceRoot, "bun.lock"))),
    buildEnvironmentSha256: sha256(
      JSON.stringify(
        [
          ...new Set([
            ...buildVariables,
            ...Object.keys(env).filter((name) => name.startsWith("VITE_")),
          ]),
        ]
          .toSorted()
          .map((name) => [name, env[name] ?? ""]),
      ),
    ),
    files,
  };
}

export function verifyPortableBuild(
  root: string,
  sourceCommit: string,
  manifest: unknown,
  env: NodeJS.ProcessEnv = process.env,
  sourceRoot: string = root,
) {
  // Comparing the complete reconstructed inventory also rejects missing/extra
  // files and metadata. Paths from the downloaded manifest are never followed.
  if (
    JSON.stringify(manifest) !==
    JSON.stringify(portableBuildManifest(root, sourceCommit, env, sourceRoot))
  ) {
    throw new Error("Portable build source, lockfile, settings or output checksum mismatch.");
  }
}
