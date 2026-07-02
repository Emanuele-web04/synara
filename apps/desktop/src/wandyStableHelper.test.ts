import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import {
  collectRunningWandyProcessIds,
  ensureStableWandyHelper,
  resolveWandyAppBundlePathFromLauncher,
} from "./wandyStableHelper";

function makeTempRoot(name: string): string {
  const root = path.join(tmpdir(), `synara-${name}-${process.pid}-${Date.now()}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

const FAKE_APP_MTIME_BY_VERSION: Record<string, number> = {
  v1: 1_700_000_000,
  v2: 1_700_000_100,
};

function writeFakeWandyApp(root: string, version: string): string {
  const appPath = path.join(root, "Wandy.app");
  const executablePath = path.join(appPath, "Contents", "MacOS", "Wandy");
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  mkdirSync(path.dirname(executablePath), { recursive: true });
  writeFileSync(plistPath, `<plist>${version}</plist>`);
  writeFileSync(executablePath, `#!/bin/sh\necho ${version}\n`);
  chmodSync(executablePath, 0o755);
  // Distinct builds carry distinct mtimes; pin them so the metadata
  // fingerprint distinguishes versions deterministically.
  const mtime = FAKE_APP_MTIME_BY_VERSION[version] ?? 1_700_000_000;
  utimesSync(plistPath, mtime, mtime);
  utimesSync(executablePath, mtime, mtime);
  return executablePath;
}

describe("resolveWandyAppBundlePathFromLauncher", () => {
  it("resolves the containing app bundle for a macOS launcher path", () => {
    assert.equal(
      resolveWandyAppBundlePathFromLauncher(
        "/Applications/Synara.app/Contents/Resources/app.asar.unpacked/node_modules/@t3tools/wandy/dist/Wandy.app/Contents/MacOS/Wandy",
      ),
      "/Applications/Synara.app/Contents/Resources/app.asar.unpacked/node_modules/@t3tools/wandy/dist/Wandy.app",
    );
  });
});

describe("ensureStableWandyHelper", () => {
  it("installs the bundled app into the stable helper location", () => {
    const root = makeTempRoot("wandy-install");
    const bundledLauncherPath = writeFakeWandyApp(path.join(root, "bundled"), "v1");
    const stableAppDir = path.join(root, "stable");

    try {
      const result = ensureStableWandyHelper({
        bundledLauncherPath,
        stableAppDir,
        platform: "darwin",
      });

      assert.equal(result.status, "ready");
      assert.equal(result.installed, true);
      assert.equal(result.replaced, false);
      assert.equal(
        result.launcherPath,
        path.join(stableAppDir, "Wandy.app", "Contents", "MacOS", "Wandy"),
      );
      assert.match(readFileSync(result.launcherPath, "utf8"), /v1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses an identical stable helper without replacing it", () => {
    const root = makeTempRoot("wandy-reuse");
    const bundledLauncherPath = writeFakeWandyApp(path.join(root, "bundled"), "v1");
    const stableAppDir = path.join(root, "stable");

    try {
      ensureStableWandyHelper({ bundledLauncherPath, stableAppDir, platform: "darwin" });
      const result = ensureStableWandyHelper({
        bundledLauncherPath,
        stableAppDir,
        platform: "darwin",
      });

      assert.equal(result.status, "ready");
      assert.equal(result.installed, false);
      assert.equal(result.replaced, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces a stale stable helper and asks the caller to terminate the old agent", () => {
    const root = makeTempRoot("wandy-replace");
    const bundledLauncherPath = writeFakeWandyApp(path.join(root, "bundled"), "v2");
    const stableAppDir = path.join(root, "stable");
    const staleStableLauncherPath = writeFakeWandyApp(stableAppDir, "v1");
    const killedAppPaths: string[] = [];

    try {
      const result = ensureStableWandyHelper({
        bundledLauncherPath,
        stableAppDir,
        platform: "darwin",
        terminateRunningHelper: (appPath) => {
          killedAppPaths.push(appPath);
        },
      });

      assert.equal(result.status, "ready");
      assert.equal(result.installed, true);
      assert.equal(result.replaced, true);
      assert.deepEqual(killedAppPaths, [path.join(stableAppDir, "Wandy.app")]);
      assert.match(readFileSync(staleStableLauncherPath, "utf8"), /v2/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses the stable helper when source mtimes carry sub-millisecond precision", () => {
    const root = makeTempRoot("wandy-submilli");
    const bundledLauncherPath = writeFakeWandyApp(path.join(root, "bundled"), "v1");
    const stableAppDir = path.join(root, "stable");
    // Real-world bundles carry fractional-millisecond mtimes on APFS; the
    // reuse path must not depend on copy-side timestamp fidelity.
    const fractionalMtime = 1_700_000_000.123_456_7;
    utimesSync(bundledLauncherPath, fractionalMtime, fractionalMtime);

    try {
      ensureStableWandyHelper({ bundledLauncherPath, stableAppDir, platform: "darwin" });
      const result = ensureStableWandyHelper({
        bundledLauncherPath,
        stableAppDir,
        platform: "darwin",
      });

      assert.equal(result.status, "ready");
      assert.equal(result.installed, false);
      assert.equal(result.replaced, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers by reinstalling when the stable app path is corrupted", () => {
    const root = makeTempRoot("wandy-recover");
    const bundledLauncherPath = writeFakeWandyApp(path.join(root, "bundled"), "v1");
    const stableAppDir = path.join(root, "stable");
    // A regular file where the stable Wandy.app directory is expected has no
    // recorded fingerprint, so it must be replaced with a fresh install.
    mkdirSync(stableAppDir, { recursive: true });
    writeFileSync(path.join(stableAppDir, "Wandy.app"), "not a directory");

    try {
      const result = ensureStableWandyHelper({
        bundledLauncherPath,
        stableAppDir,
        platform: "darwin",
      });

      assert.equal(result.status, "ready");
      assert.equal(result.installed, true);
      assert.ok(result.launcherPath);
      assert.match(readFileSync(result.launcherPath, "utf8"), /v1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the bundled launcher when the stable dir is not writable", () => {
    const root = makeTempRoot("wandy-fallback");
    const bundledLauncherPath = writeFakeWandyApp(path.join(root, "bundled"), "v1");
    const stableAppDir = path.join(root, "stable");
    mkdirSync(stableAppDir, { recursive: true });
    chmodSync(stableAppDir, 0o500);

    try {
      const result = ensureStableWandyHelper({
        bundledLauncherPath,
        stableAppDir,
        platform: "darwin",
      });

      assert.equal(result.status, "fallback");
      assert.equal(result.launcherPath, bundledLauncherPath);
      assert.equal(result.installed, false);
      assert.ok(result.reason);
    } finally {
      chmodSync(stableAppDir, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("collectRunningWandyProcessIds", () => {
  const stableAppPath = "/Users/me/.synara/wandy-app/Wandy.app";
  const bundledAppPath =
    "/Applications/Synara.app/Contents/Resources/app.asar.unpacked/node_modules/@t3tools/wandy/dist/Wandy.app";
  const psOutput = `
      101 ${stableAppPath}/Contents/MacOS/Wandy __wandy-app-agent /tmp/wandy-agent.sock
      102 ${bundledAppPath}/Contents/MacOS/Wandy
      103 /Applications/Synara.app/Contents/MacOS/Synara
      104 rg Wandy
      105 /Users/other/.synara-alt/wandy-app/Wandy.app/Contents/MacOS/Wandy
    `;

  it("finds Wandy processes for this install's app bundles only", () => {
    assert.deepEqual(
      collectRunningWandyProcessIds(psOutput, [stableAppPath, bundledAppPath]),
      [101, 102],
    );
  });

  it("does not match other installs' Wandy processes or unrelated commands", () => {
    assert.deepEqual(collectRunningWandyProcessIds(psOutput, [stableAppPath]), [101]);
    assert.deepEqual(collectRunningWandyProcessIds(psOutput, []), []);
  });
});
