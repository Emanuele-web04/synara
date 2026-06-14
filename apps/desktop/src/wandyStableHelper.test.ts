import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function writeFakeWandyApp(root: string, version: string): string {
  const appPath = path.join(root, "Wandy.app");
  const executablePath = path.join(appPath, "Contents", "MacOS", "Wandy");
  mkdirSync(path.dirname(executablePath), { recursive: true });
  writeFileSync(path.join(appPath, "Contents", "Info.plist"), `<plist>${version}</plist>`);
  writeFileSync(executablePath, `#!/bin/sh\necho ${version}\n`);
  chmodSync(executablePath, 0o755);
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
});

describe("collectRunningWandyProcessIds", () => {
  it("finds Wandy app bundle processes without matching unrelated commands", () => {
    const psOutput = `
      101 /Users/me/.synara/wandy-app/Wandy.app/Contents/MacOS/Wandy __wandy-app-agent /tmp/wandy-agent.sock
      102 /Applications/Synara.app/Contents/Resources/app.asar.unpacked/node_modules/@t3tools/wandy/dist/Wandy.app/Contents/MacOS/Wandy
      103 /Applications/Synara.app/Contents/MacOS/Synara
      104 rg Wandy
    `;

    assert.deepEqual(collectRunningWandyProcessIds(psOutput), [101, 102]);
  });
});
