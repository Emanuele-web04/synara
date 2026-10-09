import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPackagedDesktopSmokeEnvironment,
  assertDebianArchiveEntries,
  assertDebianPackageMetadata,
  parsePackagedDesktopStartupArgs,
  readPackagedStartupLogTails,
  prepareLinuxDebLaunch,
  verifyPackagedRuntimeDependencies,
  verifyPackagedDesktopStartup,
} from "./verify-packaged-desktop-startup.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("packaged desktop startup verification", () => {
  it.skipIf(process.platform !== "linux")(
    "retains the AppImage extraction failure gate",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "synara-appimage-failure-test-"));
      temporaryRoots.push(root);
      writeFileSync(join(root, "Synara.AppImage"), "#!/bin/sh\nexit 7\n");
      await expect(
        verifyPackagedDesktopStartup({
          assetsDirectory: root,
          platform: "linux",
          arch: "x64",
          target: "AppImage",
          version: "1.2.3",
          timeoutMs: 5_000,
          executableName: "synara",
        }),
      ).rejects.toThrow("--appimage-extract failed with exit 7");
    },
  );
  it("retains bounded failure diagnostics even when a startup log is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-startup-diagnostics-test-"));
    temporaryRoots.push(root);
    writeFileSync(join(root, "desktop-main.log"), "old entry" + "x".repeat(20_000) + "app ready");

    const diagnostics = readPackagedStartupLogTails(root);
    expect(diagnostics).toContain("app ready");
    expect(diagnostics).not.toContain("old entry");
    expect(diagnostics).toContain("server-child.log: unavailable");
    expect(diagnostics.length).toBeLessThan(16_500);
  });

  it("parses a bounded native payload request", () => {
    expect(
      parsePackagedDesktopStartupArgs([
        "--assets-dir",
        "./release-publish",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        "1.2.3",
      ]),
    ).toEqual({
      assetsDirectory: expect.stringMatching(/release-publish$/),
      platform: "linux",
      arch: "x64",
      target: "AppImage",
      version: "1.2.3",
      timeoutMs: 60_000,
      executableName: "synara",
    });

    expect(
      parsePackagedDesktopStartupArgs([
        "--assets-dir",
        "./release-publish",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        "1.2.3",
        "--executable-name",
        "synara-beta",
      ]),
    ).toMatchObject({ executableName: "synara-beta" });

    for (const bad of ["../outside", "a/b", "..", "synara\\beta"]) {
      expect(() =>
        parsePackagedDesktopStartupArgs([
          "--assets-dir",
          "./release-publish",
          "--platform",
          "linux",
          "--arch",
          "x64",
          "--version",
          "1.2.3",
          "--executable-name",
          bad,
        ]),
      ).toThrow("Invalid packaged startup executable name");
    }

    expect(() =>
      parsePackagedDesktopStartupArgs([
        "--assets-dir",
        "./release-publish",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        "1.2.3",
        "--timeout-ms",
        "4999",
      ]),
    ).toThrow("--timeout-ms must be an integer between 5000 and 180000");
  });

  it("requires every declared Linux format and rejects malformed target declarations", () => {
    const args = [
      "--assets-dir",
      "./release-publish",
      "--platform",
      "linux",
      "--arch",
      "x64",
      "--version",
      "1.2.3",
    ];
    expect(parsePackagedDesktopStartupArgs([...args, "--target", "AppImage,deb"])).toMatchObject({
      target: "AppImage,deb",
    });
    expect(parsePackagedDesktopStartupArgs([...args, "--target", "deb"])).toMatchObject({
      target: "deb",
    });
    for (const target of ["", "AppImage,", "deb,deb", "AppImage,rpm"]) {
      expect(() => parsePackagedDesktopStartupArgs([...args, "--target", target])).toThrow();
    }
  });

  it("checks Debian package architecture, version and Stable/Beta identity", () => {
    const stable = { arch: "x64", version: "1.2.3", executableName: "synara" };
    expect(() =>
      assertDebianPackageMetadata("synara-desktop\n1.2.3\namd64\n", stable),
    ).not.toThrow();
    expect(() =>
      assertDebianPackageMetadata("synara-desktop-beta\n1.2.4~beta.1\namd64\n", {
        ...stable,
        version: "1.2.4-beta.1",
        executableName: "synara-beta",
      }),
    ).not.toThrow();
    for (const metadata of [
      "synara-desktop-beta\n1.2.3\namd64\n",
      "synara-desktop\n1.2.2\namd64\n",
      "synara-desktop\n1.2.3\narm64\n",
    ]) {
      expect(() => assertDebianPackageMetadata(metadata, stable)).toThrow("mismatch");
    }
  });

  it("rejects unsafe Debian data archives before extraction", () => {
    expect(() =>
      assertDebianArchiveEntries(
        ["./", "./opt/", "./opt/Synara Beta/synara-beta"],
        ["d", "d", "-"],
      ),
    ).not.toThrow();
    for (const path of [
      "/",
      "/opt/Synara/synara",
      "../outside",
      "./opt/../../outside",
      "opt//file",
      "opt/./file",
      "opt\\file",
      "opt/line\nbreak",
    ]) {
      expect(() => assertDebianArchiveEntries([path], ["-"])).toThrow("Unsafe Debian payload");
    }
    for (const type of ["l", "h", "b", "c", "p"]) {
      expect(() => assertDebianArchiveEntries(["opt/Synara/file"], [type])).toThrow(
        "only files and directories",
      );
    }
    expect(() => assertDebianArchiveEntries([], [])).toThrow("inventory");
    expect(() => assertDebianArchiveEntries(["file"], [])).toThrow("inventory");
    expect(() => assertDebianArchiveEntries(["./file", "file"], ["-", "-"])).toThrow("Duplicate");
  });

  it("isolates user state and removes inherited runtime authority", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-packaged-smoke-env-test-"));
    temporaryRoots.push(root);

    const env = createPackagedDesktopSmokeEnvironment(
      root,
      { platform: "linux", version: "1.2.3", executableName: "synara-beta" },
      {
        PATH: process.env.PATH,
        SYNARA_AUTH_TOKEN: "must-not-leak",
        ELECTRON_RUN_AS_NODE: "1",
        APPIMAGE: "/production/Synara.AppImage",
        APPDIR: "/production/Synara",
        NODE_OPTIONS: "--production-loader",
        NODE_PATH: "/workspace/node_modules",
        SYNARA_DESKTOP_SMOKE_USER_DATA: "/production/profile",
      },
    );

    expect(env.SYNARA_AUTH_TOKEN).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    for (const name of [
      "APPIMAGE",
      "APPDIR",
      "NODE_OPTIONS",
      "NODE_PATH",
      "SYNARA_DESKTOP_SMOKE_USER_DATA",
    ])
      expect(env[name]).toBeUndefined();
    for (const name of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "SYNARA_HOME",
      "SYNARA_BETA_HOME",
    ] as const) {
      expect(env[name]?.startsWith(root)).toBe(true);
      expect(existsSync(env[name]!)).toBe(true);
    }
    expect(env.SYNARA_BETA_HOME).not.toBe(env.SYNARA_HOME);
  });

  it("rejects a missing packaged peer even when the development tree provides it", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-runtime-deps-test-"));
    temporaryRoots.push(root);
    const app = join(root, "app.asar");
    const dist = join(app, "apps/server/dist");
    const sdk = join(app, "node_modules/@agentclientprotocol/sdk");
    const developmentModules = join(root, "development/node_modules");
    const writeZod = (modules: string) => {
      const directory = join(modules, "zod");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "package.json"), '{"type":"module","exports":"./index.js"}');
      writeFileSync(join(directory, "index.js"), 'export const version = "test";');
    };
    mkdirSync(dist, { recursive: true });
    mkdirSync(sdk, { recursive: true });
    writeFileSync(
      join(dist, "runtimeDependencySmoke.mjs"),
      'await import("@agentclientprotocol/sdk");',
    );
    writeFileSync(join(sdk, "package.json"), '{"type":"module","exports":"./index.js"}');
    writeFileSync(join(sdk, "index.js"), 'export { version } from "zod";');
    writeZod(developmentModules);

    const runtime = { executable: process.execPath, resourcesDirectory: root };
    const env = {
      ...process.env,
      NODE_PATH: developmentModules,
      NODE_OPTIONS: "--invalid-development-node-option",
    };
    expect(() => verifyPackagedRuntimeDependencies(runtime, env, 5_000)).toThrow(
      /Cannot find package 'zod'/,
    );

    writeZod(join(app, "node_modules"));
    expect(() => verifyPackagedRuntimeDependencies(runtime, env, 5_000)).not.toThrow();
  });

  it("bounds a runtime import that never finishes", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-runtime-timeout-test-"));
    temporaryRoots.push(root);
    const dist = join(root, "app.asar/apps/server/dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "runtimeDependencySmoke.mjs"), "setInterval(() => {}, 1000);");

    expect(() =>
      verifyPackagedRuntimeDependencies(
        { executable: process.execPath, resourcesDirectory: root },
        process.env,
        200,
      ),
    ).toThrow(/ETIMEDOUT/);
  });
});

const hasDpkgDeb =
  process.platform === "linux" &&
  spawnSync("dpkg-deb", ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!hasDpkgDeb)(
  "native Debian payload extraction (no privileged installation)",
  () => {
    function fixture(beta = false) {
      const root = mkdtempSync(join(tmpdir(), "synara-deb-extraction-test-"));
      temporaryRoots.push(root);
      const packageRoot = join(root, "package");
      const assetsDirectory = join(root, "assets");
      const extractionRoot = join(root, "extract");
      const executableName = beta ? "synara-beta" : "synara";
      const product = beta ? "Synara Beta" : "Synara";
      const version = beta ? "1.2.4-beta.1" : "1.2.3";
      const application = join(packageRoot, "opt", product);
      const control = join(packageRoot, "DEBIAN");
      const desktop = join(packageRoot, "usr/share/applications");
      const icons = join(packageRoot, "usr/share/icons/hicolor/512x512/apps");
      for (const path of [
        control,
        join(application, "resources"),
        desktop,
        icons,
        assetsDirectory,
        extractionRoot,
      ])
        mkdirSync(path, { recursive: true });
      writeFileSync(
        join(control, "control"),
        `Package: synara-desktop${beta ? "-beta" : ""}\nVersion: ${version.replaceAll("-", "~")}\nArchitecture: amd64\nMaintainer: Synara <feedback@trysynara.com>\nDescription: Extraction fixture only\n`,
      );
      const marker = join(root, "postinst-must-not-run");
      writeFileSync(join(control, "postinst"), `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(join(control, "postinst"), 0o755);
      writeFileSync(join(application, executableName), "#!/bin/sh\nexit 0\n");
      chmodSync(join(application, executableName), 0o755);
      writeFileSync(join(application, "resources/app.asar"), "fixture-asar");
      const exec = `/opt/${product}/${executableName}`;
      writeFileSync(
        join(desktop, `${executableName}.desktop`),
        `[Desktop Entry]\nName=${product}\nExec=${beta ? `"${exec}"` : exec} %U\nIcon=${executableName}\nStartupWMClass=${executableName}\n`,
      );
      writeFileSync(join(icons, `${executableName}.png`), "fixture-icon");
      const deb = join(assetsDirectory, "Synara.deb");
      const build = () => {
        const result = spawnSync("dpkg-deb", ["--build", "--root-owner-group", packageRoot, deb], {
          encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(0);
      };
      build();
      return {
        root,
        application,
        packageRoot,
        extractionRoot,
        marker,
        build,
        options: { assetsDirectory, executableName, version, arch: "x64" },
      };
    }

    it.each([false, true])(
      "extracts a real Debian archive with isolated flavor identity (beta=%s)",
      (beta) => {
        const item = fixture(beta);
        const launch = prepareLinuxDebLaunch(item.options, item.extractionRoot);
        expect(launch.command).toBe("xvfb-run");
        expect(launch.runtime.executable).toBe(
          join(
            item.extractionRoot,
            "application/opt",
            beta ? "Synara Beta" : "Synara",
            item.options.executableName,
          ),
        );
        expect(existsSync(launch.runtime.executable)).toBe(true);
        expect(existsSync(item.marker)).toBe(false);
      },
    );

    it("rejects a symlink before extracting package data", () => {
      const item = fixture();
      symlinkSync(item.root, join(item.application, "escape"));
      item.build();
      expect(() => prepareLinuxDebLaunch(item.options, item.extractionRoot)).toThrow(
        "only files and directories",
      );
      expect(existsSync(join(item.extractionRoot, "application"))).toBe(false);
      expect(existsSync(item.marker)).toBe(false);
    });

    it("rejects a wrong flavor before extracting package data", () => {
      const item = fixture(true);
      expect(() =>
        prepareLinuxDebLaunch({ ...item.options, executableName: "synara" }, item.extractionRoot),
      ).toThrow("mismatch");
      expect(existsSync(join(item.extractionRoot, "payload.tar"))).toBe(false);
    });
  },
);
