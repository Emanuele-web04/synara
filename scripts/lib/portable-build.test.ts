import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { portableBuildManifest, verifyPortableBuild } from "./portable-build.ts";

const commit = "a".repeat(40);
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "portable-build-test-"));
  roots.push(root);
  for (const path of [
    "bun.lock",
    ...["main", "preload", "guestPreload", "cuaDriverHostStandalone"].map(
      (name) => `apps/desktop/dist-electron/${name}.js`,
    ),
    ...["index", "restoreMigrationBackup", "runtimeDependencySmoke"].map(
      (name) => `apps/server/dist/${name}.mjs`,
    ),
    "apps/server/dist/client/index.html",
    "apps/server/dist/device-helper/build.sh",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), path, { mode: 0o755 });
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("portable release outputs", () => {
  it("accepts an exact output inventory and build settings", () => {
    const root = fixture();
    const manifest = portableBuildManifest(root, commit, {});
    expect(() =>
      verifyPortableBuild(root, commit, JSON.parse(JSON.stringify(manifest)), {}),
    ).not.toThrow();
  });
  it("rejects stale source, lockfile, publisher and Vite settings", () => {
    const root = fixture();
    const manifest = portableBuildManifest(root, commit, {});
    expect(() => verifyPortableBuild(root, "b".repeat(40), manifest, {})).toThrow("mismatch");
    for (const env of [
      { AZURE_TRUSTED_SIGNING_SUBJECT_DN: "publisher" },
      { VITE_FEEDBACK_ENDPOINT: "https://example.test" },
      { SYNARA_WEB_SOURCEMAP: "1" },
    ])
      expect(() => verifyPortableBuild(root, commit, manifest, env)).toThrow("mismatch");
    writeFileSync(join(root, "bun.lock"), "changed");
    expect(() => verifyPortableBuild(root, commit, manifest, {})).toThrow("mismatch");
  });
  it.each(["changed", "missing", "extra"])("rejects %s output bytes", (change) => {
    const root = fixture();
    const manifest = portableBuildManifest(root, commit, {});
    const path = join(
      root,
      "apps/desktop/dist-electron",
      change === "extra" ? "extra.js" : "main.js",
    );
    if (change === "missing") rmSync(path);
    else writeFileSync(path, "changed");
    expect(() => verifyPortableBuild(root, commit, manifest, {})).toThrow();
  });
  it("rejects symlinks, native products and lost helper executable modes", () => {
    const root = fixture();
    const extra = join(root, "apps/server/dist/extra");
    symlinkSync(join(root, "bun.lock"), extra);
    expect(() => portableBuildManifest(root, commit)).toThrow("symlink");
    rmSync(extra);
    writeFileSync(extra, Buffer.from("7f454c4600000000", "hex"));
    expect(() => portableBuildManifest(root, commit)).toThrow("native binary");
    rmSync(extra);
    chmodSync(join(root, "apps/server/dist/device-helper/build.sh"), 0o644);
    if (process.platform !== "win32")
      expect(() => portableBuildManifest(root, commit)).toThrow("not executable");
  });
});
