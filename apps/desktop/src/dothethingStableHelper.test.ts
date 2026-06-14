import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import {
  collectRunningDoTheThingProcessIds,
  ensureStableDoTheThingHelper,
  resolveDoTheThingAppBundlePathFromLauncher,
} from "./dothethingStableHelper";

function makeTempRoot(name: string): string {
  const root = path.join(tmpdir(), `synara-${name}-${process.pid}-${Date.now()}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

function writeFakeDoTheThingApp(root: string, version: string): string {
  const appPath = path.join(root, "Do The Thing.app");
  const executablePath = path.join(appPath, "Contents", "MacOS", "DoTheThing");
  mkdirSync(path.dirname(executablePath), { recursive: true });
  writeFileSync(path.join(appPath, "Contents", "Info.plist"), `<plist>${version}</plist>`);
  writeFileSync(executablePath, `#!/bin/sh\necho ${version}\n`);
  chmodSync(executablePath, 0o755);
  return executablePath;
}

describe("resolveDoTheThingAppBundlePathFromLauncher", () => {
  it("resolves the containing app bundle for a macOS launcher path", () => {
    assert.equal(
      resolveDoTheThingAppBundlePathFromLauncher(
        "/Applications/Synara.app/Contents/Resources/app.asar.unpacked/node_modules/@t3tools/dothething/dist/Do The Thing.app/Contents/MacOS/DoTheThing",
      ),
      "/Applications/Synara.app/Contents/Resources/app.asar.unpacked/node_modules/@t3tools/dothething/dist/Do The Thing.app",
    );
  });
});

describe("ensureStableDoTheThingHelper", () => {
  it("installs the bundled app into the stable helper location", () => {
    const root = makeTempRoot("dothething-install");
    const bundledLauncherPath = writeFakeDoTheThingApp(path.join(root, "bundled"), "v1");
    const stableAppDir = path.join(root, "stable");

    try {
      const result = ensureStableDoTheThingHelper({
        bundledLauncherPath,
        stableAppDir,
        platform: "darwin",
      });

      assert.equal(result.status, "ready");
      assert.equal(result.installed, true);
      assert.equal(result.replaced, false);
      assert.equal(
        result.launcherPath,
        path.join(stableAppDir, "Do The Thing.app", "Contents", "MacOS", "DoTheThing"),
      );
      assert.match(readFileSync(result.launcherPath, "utf8"), /v1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses an identical stable helper without replacing it", () => {
    const root = makeTempRoot("dothething-reuse");
    const bundledLauncherPath = writeFakeDoTheThingApp(path.join(root, "bundled"), "v1");
    const stableAppDir = path.join(root, "stable");

    try {
      ensureStableDoTheThingHelper({ bundledLauncherPath, stableAppDir, platform: "darwin" });
      const result = ensureStableDoTheThingHelper({
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
    const root = makeTempRoot("dothething-replace");
    const bundledLauncherPath = writeFakeDoTheThingApp(path.join(root, "bundled"), "v2");
    const stableAppDir = path.join(root, "stable");
    const staleStableLauncherPath = writeFakeDoTheThingApp(stableAppDir, "v1");
    const killedAppPaths: string[] = [];

    try {
      const result = ensureStableDoTheThingHelper({
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
      assert.deepEqual(killedAppPaths, [path.join(stableAppDir, "Do The Thing.app")]);
      assert.match(readFileSync(staleStableLauncherPath, "utf8"), /v2/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("collectRunningDoTheThingProcessIds", () => {
  it("finds Do The Thing app bundle processes without matching unrelated commands", () => {
    const psOutput = `
      101 /Users/me/.synara/dothething-app/Do The Thing.app/Contents/MacOS/DoTheThing __dothething-app-agent /tmp/dothething-agent.sock
      102 /Applications/Synara.app/Contents/Resources/app.asar.unpacked/node_modules/@t3tools/dothething/dist/Do The Thing.app/Contents/MacOS/DoTheThing
      103 /Applications/Synara.app/Contents/MacOS/Synara
      104 rg DoTheThing
    `;

    assert.deepEqual(collectRunningDoTheThingProcessIds(psOutput), [101, 102]);
  });
});
