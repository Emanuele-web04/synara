// FILE: tsdown.config.ts
// Purpose: Builds the Synara server CLI and controls diagnostic source maps.
// Layer: Server build config
// Depends on: tsdown.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsdown";

const sourcemapEnv = process.env.SYNARA_SERVER_SOURCEMAP?.trim().toLowerCase();
const buildSourcemap = sourcemapEnv === "1" || sourcemapEnv === "true";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationRuntimeSource = fs.readFileSync(
  path.join(repoRoot, "apps/server/src/persistence/Migrations.ts"),
  "utf8",
);
const migrationRuntimeSourceDigest = createHash("sha256")
  .update(migrationRuntimeSource, "utf8")
  .digest("hex");

// Effect and its platform packages are bundled: loading them file by file was about 270
// modules and 70 ms of every backend start, and bundling lets unused modules drop out.
// This is safe only because nothing left in node_modules imports Effect at runtime
// (@opencode/client is used through its promise entry, which does not). Two copies of
// Effect would break service identity, so a new runtime dependency that imports Effect
// must be added here too. Packages that an unbundled SDK also loads (undici, yaml, ws,
// zod, the Pi and MCP SDKs) and anything native (node-pty, msgpackr's optional
// accelerator) stay external.
const BUNDLED_RUNTIME_PACKAGES = [
  "effect",
  "@effect/platform-node",
  "@effect/platform-node-shared",
  "@effect/sql-sqlite-bun",
  // Pure-JS dependencies of the packages above.
  "@standard-schema/spec",
  "fast-check",
  "find-my-way-ts",
  "ini",
  "mime",
  "multipasta",
  "pure-rand",
  "toml",
  "uuid",
];

function isBundledRuntimePackage(id: string): boolean {
  return BUNDLED_RUNTIME_PACKAGES.some((name) => id === name || id.startsWith(`${name}/`));
}

export default defineConfig({
  entry: {
    index: "src/index.ts",
    restoreMigrationBackup: "src/restoreMigrationBackup.ts",
    compactDatabase: "src/compactDatabase.ts",
    runtimeDependencySmoke: "src/runtimeDependencySmoke.ts",
    languageWorker: "src/editor/languageWorker.ts",
  },
  format: ["esm"],
  outDir: "dist",
  // Bun builtins only resolve at runtime under Bun; MigrationBackup.ts guards
  // the import behind a `process.versions.bun` check.
  // The Pi SDK stays out of the bundle: the provider resolves it from the
  // user's `pi` CLI install at runtime (piSdkImports.ts).
  external: [/^bun:/u, /^@earendil-works\//u],
  sourcemap: buildSourcemap,
  define: {
    __SYNARA_MIGRATION_RUNTIME_SOURCE_DIGEST__: JSON.stringify(migrationRuntimeSourceDigest),
  },
  clean: true,
  noExternal: (id) => id.startsWith("@synara/") || isBundledRuntimePackage(id),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
