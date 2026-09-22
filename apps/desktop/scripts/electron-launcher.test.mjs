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
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildMacLauncher, configureMacLauncher, copyMacAppBundle } from "./electron-launcher.mjs";

function createLauncherFixture(t, { iconComposer = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "synara-electron-signing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const desktopDirectory = join(root, "apps", "desktop");
  const iconComposerPath = join(root, "assets", "prod", "Synara.icon");
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
  writeFileSync(join(desktopDirectory, "package.json"), JSON.stringify({ version: "0.8.3" }));
  if (iconComposer) {
    mkdirSync(iconComposerPath, { recursive: true });
    writeFileSync(join(iconComposerPath, "icon.json"), "{}");
  }

  const commands = [];
  let codeSignFailure;
  let iconCompileFailure;
  let displayedCdhashes = [];
  const runCommand = (command, arguments_, options) => {
    commands.push({ command, arguments_, options });
    if (command === "ditto") {
      cpSync(arguments_[0], arguments_[1], { recursive: true, verbatimSymlinks: true });
    }
    if (command === "xcrun") {
      if (iconCompileFailure) return iconCompileFailure;
      const resourcesDirectory = arguments_[arguments_.indexOf("--compile") + 1];
      const partialPlistPath = arguments_[arguments_.indexOf("--output-partial-info-plist") + 1];
      writeFileSync(join(resourcesDirectory, "Assets.car"), "compiled layered icon");
      writeFileSync(partialPlistPath, "partial plist");
    }
    if (command === "/usr/bin/codesign" && arguments_[0] === "--display") {
      return { status: 0, stdout: "", stderr: `CDHash=${displayedCdhashes.shift() ?? ""}\n` };
    }
    if (command === "/usr/bin/codesign") {
      assert.equal(existsSync(metadataPath), false, "cache is committed only after verification");
      const applicationDirectory = join(arguments_.at(-1), "Contents", "Resources", "app");
      assert.equal(existsSync(join(applicationDirectory, "package.json")), true);
      assert.equal(existsSync(join(applicationDirectory, "main.cjs")), true);
      if (codeSignFailure?.argument === arguments_[0]) return codeSignFailure.result;
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return {
    source,
    metadataPath,
    iconComposerPath,
    commands,
    build: () => buildMacLauncher(electronBinaryPath, { desktopDirectory, runCommand }),
    failSigning: (argument, result) => {
      codeSignFailure = argument ? { argument, result } : undefined;
    },
    failIconCompilation: (result) => {
      iconCompileFailure = result;
    },
    displayCdhashes: (...cdhashes) => {
      displayedCdhashes = cdhashes;
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
    assert.deepEqual(
      fixture.commands.filter(({ command }) => !command.endsWith("/lsregister")).slice(-2),
      signingCommands,
    );
    const registrationCommands = fixture.commands.slice(
      fixture.commands.indexOf(signingCommands.at(-1)) + 1,
    );
    const launchServicesPath =
      "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";
    assert.deepEqual(
      registrationCommands.map(({ command, arguments_ }) => [command, arguments_]),
      existsSync(launchServicesPath)
        ? [
            [launchServicesPath, ["-u", bundle]],
            [launchServicesPath, ["-f", "-R", bundle]],
          ]
        : [],
    );
    assert.equal(
      signingCommands.every(({ options }) => options.timeout === 60_000),
      true,
    );
    assert.equal(JSON.parse(readFileSync(fixture.metadataPath, "utf8")).launcherVersion, 6);
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

  it("compiles the layered icon through the injected runner before signing", (t) => {
    const fixture = createLauncherFixture(t, { iconComposer: true });
    const executable = fixture.build();
    const bundle = dirname(dirname(dirname(executable)));
    const compileIndex = fixture.commands.findIndex(({ command }) => command === "xcrun");
    const iconNameIndex = fixture.commands.findIndex(
      ({ command, arguments_ }) => command === "plutil" && arguments_[1] === "CFBundleIconName",
    );
    const signingIndex = fixture.commands.findIndex(
      ({ command }) => command === "/usr/bin/codesign",
    );

    assert.ok(compileIndex >= 0);
    assert.ok(iconNameIndex > compileIndex);
    assert.ok(signingIndex > iconNameIndex);
    assert.deepEqual(fixture.commands[compileIndex].arguments_.slice(0, 4), [
      "actool",
      fixture.iconComposerPath,
      "--compile",
      join(bundle, "Contents", "Resources"),
    ]);
    assert.deepEqual(fixture.commands[iconNameIndex].arguments_, [
      "-replace",
      "CFBundleIconName",
      "-string",
      "Synara",
      join(bundle, "Contents", "Info.plist"),
    ]);
    assert.equal(
      readFileSync(join(bundle, "Contents", "Resources", "Assets.car"), "utf8"),
      "compiled layered icon",
    );
    assert.equal(existsSync(join(dirname(fixture.metadataPath), "icon-partial.plist")), false);
    const metadata = JSON.parse(readFileSync(fixture.metadataPath, "utf8"));
    assert.equal(typeof metadata.iconComposerMtimeMs, "number");
    assert.equal(typeof metadata.bootstrapHash, "string");
    assert.equal(metadata.appVersion, "0.8.3");
    fixture.commands.length = 0;
    assert.equal(fixture.build(), executable);
    assert.deepEqual(fixture.commands, []);
  });

  it("still signs and caches the flat icon when actool is unavailable", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const fixture = createLauncherFixture(t, { iconComposer: true });
    fixture.failIconCompilation({ status: 1, stderr: "actool is unavailable" });

    assert.equal(existsSync(fixture.build()), true);
    assert.equal(existsSync(fixture.metadataPath), true);
    assert.equal(warn.mock.calls.length, 1);
    assert.equal(
      fixture.commands.some(
        ({ command, arguments_ }) => command === "plutil" && arguments_[1] === "CFBundleIconName",
      ),
      false,
    );
    assert.equal(
      fixture.commands.some(
        ({ command, arguments_ }) =>
          command === "/usr/bin/codesign" && arguments_[0] === "--verify",
      ),
      true,
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
    assert.equal(JSON.parse(readFileSync(fixture.metadataPath, "utf8")).launcherVersion, 6);
  });

  for (const [label, cdhashes, expectReset] of [
    [
      "clears this flavor's stale privacy grants when a rebuild changes the cdhash",
      ["aa", "bb"],
      true,
    ],
    ["keeps privacy grants when a rebuild reproduces the same cdhash", ["aa", "aa"], false],
  ]) {
    it(label, (t) => {
      const fixture = createLauncherFixture(t);
      fixture.build();
      const metadata = JSON.parse(readFileSync(fixture.metadataPath, "utf8"));
      writeFileSync(fixture.metadataPath, JSON.stringify({ ...metadata, appVersion: "0.0.1" }));
      fixture.commands.length = 0;
      fixture.displayCdhashes(...cdhashes);
      t.mock.method(console, "warn", () => {});

      fixture.build();
      const resets = fixture.commands.filter(({ command }) => command === "/usr/bin/tccutil");
      assert.deepEqual(
        resets.map(({ arguments_ }) => arguments_.slice(0, 2)),
        expectReset
          ? [
              ["reset", "Accessibility"],
              ["reset", "ScreenCapture"],
              ["reset", "ListenEvent"],
            ]
          : [],
      );
      assert.equal(
        resets.every(({ arguments_ }) => /^com\.[\w.]*synara/i.test(arguments_[2])),
        true,
      );
    });
  }

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

describe("macOS source bundle reopen", () => {
  function reopen(executable, environment = {}) {
    const applicationDirectory = join(dirname(dirname(executable)), "Resources", "app");
    const loaded = [];
    const errors = [];
    const nodeRequire = createRequire(import.meta.url);
    const process = {
      env: environment,
      argv: [executable],
      chdir: (path) => loaded.push(["cwd", path]),
    };
    const electron = {
      app: {
        setAppPath: (path) => loaded.push(["appPath", path]),
        exit: (code) => loaded.push(["exit", code]),
      },
      dialog: { showErrorBox: (...args) => errors.push(args) },
    };
    runInNewContext(readFileSync(join(applicationDirectory, "main.cjs"), "utf8"), {
      __dirname: applicationDirectory,
      process,
      require: (name) => {
        if (name === "electron") return electron;
        if (name.startsWith("node:")) return nodeRequire(name);
        loaded.push(["entry", name]);
      },
    });
    return { loaded, errors, environment };
  }

  it("opens Synara with no argv or inherited environment after the macOS permission restart", (t) => {
    const fixture = createLauncherFixture(t);
    const executable = fixture.build();
    const desktop = dirname(dirname(fixture.metadataPath));
    const entry = join(desktop, "dist-electron/main.js");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "// current build");
    configureMacLauncher(executable, {
      SYNARA_HOME: join(desktop, "isolated home"),
      VITE_DEV_SERVER_URL: "http://localhost:8891",
      SYNARA_AUTH_TOKEN: "synthetic-secret",
      PROVIDER_API_KEY: "another-secret",
    });

    const result = reopen(executable);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.loaded, [
      ["cwd", desktop],
      ["appPath", desktop],
      ["entry", entry],
    ]);
    assert.equal(result.environment.SYNARA_HOME, join(desktop, "isolated home"));
    assert.equal(result.environment.VITE_DEV_SERVER_URL, "http://localhost:8891");
    assert.equal(result.environment.SYNARA_DESKTOP_FLAVOR, "development");
    assert.equal(Object.keys(result.environment).length, 4);
    const configuration = readFileSync(
      join(desktop, ".electron-runtime", "Synara (Dev).app.launch.json"),
      "utf8",
    );
    assert.equal(configuration.includes("secret"), false);
  });

  it("changes launch routing without rebuilding or re-signing the bundle", (t) => {
    const fixture = createLauncherFixture(t);
    const executable = fixture.build();
    configureMacLauncher(executable, {
      SYNARA_HOME: "/tmp/first",
      VITE_DEV_SERVER_URL: "http://localhost:8891",
    });
    fixture.commands.length = 0;
    configureMacLauncher(executable, { SYNARA_HOME: "/tmp/second" });
    assert.equal(fixture.build(), executable);
    assert.deepEqual(fixture.commands, []);
    const configuration = readFileSync(
      join(dirname(fixture.metadataPath), "Synara (Dev).app.launch.json"),
      "utf8",
    );
    assert.equal(configuration.includes("8891"), false);
    assert.equal(configuration.includes("/tmp/second"), true);
  });

  it("preserves an explicit smoke launch's isolated home without requiring saved routing", (t) => {
    const fixture = createLauncherFixture(t);
    const executable = fixture.build();
    const desktop = dirname(dirname(fixture.metadataPath));
    mkdirSync(join(desktop, "dist-electron"), { recursive: true });
    writeFileSync(join(desktop, "dist-electron/main.js"), "// current build");
    const environment = {
      SYNARA_HOME: "/tmp/smoke-home",
      SYNARA_SOURCE_DESKTOP_BUILD_MARKER: "test-marker",
    };
    const result = reopen(executable, environment);
    assert.deepEqual(result.errors, []);
    assert.equal(result.environment.SYNARA_HOME, "/tmp/smoke-home");
    assert.equal(result.loaded.at(-1)[0], "entry");
  });

  it("shows an actionable error if reopened while the build is absent", (t) => {
    const fixture = createLauncherFixture(t);
    const executable = fixture.build();
    configureMacLauncher(executable, {});
    const result = reopen(executable);
    assert.deepEqual(result.loaded, [["exit", 1]]);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0][1], /bun run electron:dev/);
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
