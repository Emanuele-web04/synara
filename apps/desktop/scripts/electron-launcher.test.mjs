import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildMacLauncher, copyMacAppBundle } from "./electron-launcher.mjs";

function createLauncherFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "synara-electron-signing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const desktopDirectory = join(root, "desktop");
  const source = join(root, "vendor", "Electron.app");
  const electronBinaryPath = join(source, "Contents", "MacOS", "Electron");
  const helperDirectory = join(source, "Contents", "Frameworks", "Electron Helper.app");
  const metadataPath = join(desktopDirectory, ".electron-runtime", "metadata.json");
  mkdirSync(dirname(electronBinaryPath), { recursive: true });
  mkdirSync(join(source, "Contents", "Resources"), { recursive: true });
  mkdirSync(join(helperDirectory, "Contents"), { recursive: true });
  mkdirSync(join(desktopDirectory, "resources"), { recursive: true });
  writeFileSync(electronBinaryPath, "original executable");
  writeFileSync(join(source, "Contents", "Info.plist"), "original identity");
  writeFileSync(join(helperDirectory, "Contents", "Info.plist"), "original helper identity");
  writeFileSync(join(desktopDirectory, "resources", "icon.icns"), "synara icon");

  const commands = [];
  let codeSignFailure;
  const runCommand = (command, arguments_, options) => {
    commands.push({ command, arguments_, options });
    if (command === "ditto") {
      cpSync(arguments_[0], arguments_[1], { recursive: true, verbatimSymlinks: true });
    }
    if (command === "/usr/bin/codesign") {
      assert.equal(existsSync(metadataPath), false, "cache is committed only after verification");
      if (codeSignFailure?.argument === arguments_[0]) return codeSignFailure.result;
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return {
    source,
    metadataPath,
    commands,
    build: () => buildMacLauncher(electronBinaryPath, { desktopDirectory, runCommand }),
    failSigning: (argument, result) => {
      codeSignFailure = argument ? { argument, result } : undefined;
    },
  };
}

describe("macOS Electron launcher signature", () => {
  it("signs the generated bundle after all mutations and verifies before caching it", (t) => {
    const fixture = createLauncherFixture(t);
    mkdirSync(dirname(fixture.metadataPath), { recursive: true });
    writeFileSync(fixture.metadataPath, JSON.stringify({ launcherVersion: 2 }));
    const executable = fixture.build();
    const bundle = dirname(dirname(dirname(executable)));
    const signingCommands = fixture.commands.filter(
      ({ command }) => command === "/usr/bin/codesign",
    );

    assert.deepEqual(
      signingCommands.map(({ arguments_ }) => arguments_),
      [
        ["--force", "--deep", "--sign", "-", "--timestamp=none", bundle],
        ["--verify", "--deep", "--strict", bundle],
      ],
    );
    assert.deepEqual(fixture.commands.slice(-2), signingCommands);
    assert.equal(
      signingCommands.every(({ options }) => options.timeout === 60_000),
      true,
    );
    assert.equal(JSON.parse(readFileSync(fixture.metadataPath, "utf8")).launcherVersion, 3);
    assert.equal(
      readFileSync(join(bundle, "Contents", "Resources", "icon.icns"), "utf8"),
      "synara icon",
    );
    assert.equal(
      readFileSync(join(fixture.source, "Contents", "Info.plist"), "utf8"),
      "original identity",
    );
    assert.equal(
      signingCommands.some(({ arguments_ }) => arguments_.includes(fixture.source)),
      false,
    );
  });

  it("reuses the verified launcher without signing it again", (t) => {
    const fixture = createLauncherFixture(t);
    const executable = fixture.build();
    fixture.commands.length = 0;

    assert.equal(fixture.build(), executable);
    assert.deepEqual(fixture.commands, []);
  });

  it("rebuilds launchers cached before generated bundles were signed", (t) => {
    const fixture = createLauncherFixture(t);
    const executable = fixture.build();
    const metadata = JSON.parse(readFileSync(fixture.metadataPath, "utf8"));
    writeFileSync(fixture.metadataPath, JSON.stringify({ ...metadata, launcherVersion: 2 }));
    fixture.commands.length = 0;

    assert.equal(fixture.build(), executable);
    assert.equal(
      fixture.commands.some(({ command }) => command === "/usr/bin/codesign"),
      true,
    );
    assert.equal(JSON.parse(readFileSync(fixture.metadataPath, "utf8")).launcherVersion, 3);
  });

  for (const [argument, label, result] of [
    ["--force", "signing", { status: 1, stderr: "resource envelope is invalid" }],
    ["--verify", "verification", { status: 1, stderr: "nested code is invalid" }],
    ["--force", "codesign startup", { status: null, error: new Error("spawn ENOENT") }],
  ]) {
    it(`rejects ${label} failure and never caches the invalid bundle`, (t) => {
      const fixture = createLauncherFixture(t);
      fixture.failSigning(argument, result);

      assert.throws(() => fixture.build(), /Failed to (sign|verify) the generated Synara launcher/);
      assert.equal(existsSync(fixture.metadataPath), false);
      fixture.failSigning(null);
      assert.equal(existsSync(fixture.build()), true);
      assert.equal(existsSync(fixture.metadataPath), true);
    });
  }

  it("discards matching old metadata before rebuilding a missing executable", (t) => {
    const fixture = createLauncherFixture(t);
    const executable = fixture.build();
    rmSync(executable);
    fixture.failSigning("--verify", { status: 1, stderr: "invalid signature" });

    assert.throws(() => fixture.build(), /Failed to verify/);
    assert.equal(existsSync(fixture.metadataPath), false);
    fixture.commands.length = 0;
    fixture.failSigning(null);
    assert.equal(fixture.build(), executable);
    assert.equal(
      fixture.commands.some(({ command }) => command === "/usr/bin/codesign"),
      true,
    );
  });
});

describe("macOS Electron launcher copy", { skip: process.platform !== "darwin" }, () => {
  it("keeps framework symlink targets relative after relocation", (t) => {
    const root = mkdtempSync(join(tmpdir(), "synara-electron-launcher-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = join(root, "source", "Electron.app");
    const target = join(root, "runtime", "Synara (Dev).app");
    const framework = join(source, "Contents", "Frameworks", "Electron Framework.framework");

    mkdirSync(join(framework, "Versions", "A", "Resources"), { recursive: true });
    writeFileSync(join(framework, "Versions", "A", "Resources", "icudtl.dat"), "icu");
    symlinkSync("A", join(framework, "Versions", "Current"));
    symlinkSync("Versions/Current/Resources", join(framework, "Resources"));

    copyMacAppBundle(source, target);
    rmSync(join(root, "source"), { recursive: true });

    const copiedResources = join(
      target,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Resources",
    );
    assert.equal(lstatSync(copiedResources).isSymbolicLink(), true);
    assert.equal(readlinkSync(copiedResources), "Versions/Current/Resources");
    assert.equal(readFileSync(join(copiedResources, "icudtl.dat"), "utf8"), "icu");
  });
});
