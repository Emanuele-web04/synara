import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { PORTABLE_BUILD_ROOTS, portableBuildManifest } from "./lib/portable-build.ts";

const commit = "a".repeat(40);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("imports a verified portable archive from a path containing a drive colon", () => {
  const root = mkdtempSync(join(tmpdir(), "synara-portable-import-"));
  roots.push(root);
  const source = join(root, "source");
  const destination = join(root, "destination");
  const artifact = join(root, process.platform === "win32" ? "portable-build" : "D:portable-build");
  for (const directory of [source, destination, artifact]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const directory of [source, destination]) {
    writeFileSync(join(directory, "bun.lock"), "fixture lockfile");
  }
  for (const path of [
    ...["main", "preload", "guestPreload", "cuaDriverHostStandalone"].map(
      (name) => `apps/desktop/dist-electron/${name}.js`,
    ),
    ...["index", "restoreMigrationBackup", "runtimeDependencySmoke"].map(
      (name) => `apps/server/dist/${name}.mjs`,
    ),
    "apps/server/dist/client/index.html",
    "apps/server/dist/device-helper/build.sh",
  ]) {
    const output = join(source, path);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, path, { mode: 0o755 });
  }
  writeFileSync(
    join(artifact, "manifest.json"),
    JSON.stringify(portableBuildManifest(source, commit)),
  );
  const archived = spawnSync("tar", ["-cf", "outputs.tar", "-C", source, ...PORTABLE_BUILD_ROOTS], {
    cwd: artifact,
    encoding: "utf8",
  });
  expect(archived.status, archived.stderr).toBe(0);

  const imported = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./import-portable-build.ts", import.meta.url)), artifact, commit],
    { cwd: destination, encoding: "utf8" },
  );
  expect(imported.status, imported.stderr).toBe(0);
  expect(readFileSync(join(destination, "apps/server/dist/index.mjs"), "utf8")).toBe(
    "apps/server/dist/index.mjs",
  );
});
