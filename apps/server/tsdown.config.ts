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

export default defineConfig({
  entry: ["src/index.ts", "src/restoreMigrationBackup.ts", "src/runtimeDependencySmoke.ts"],
  format: ["esm"],
  outDir: "dist",
  // Bun builtins resolve only at runtime under Bun; MigrationBackup.ts guards the import behind process.versions.bun
  external: [/^bun:/u],
  sourcemap: buildSourcemap,
  define: {
    __SYNARA_MIGRATION_RUNTIME_SOURCE_DIGEST__: JSON.stringify(migrationRuntimeSourceDigest),
  },
  clean: true,
  noExternal: (id) => id.startsWith("@synara/"),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
