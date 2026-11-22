import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  SYNARA_BETA_BUNDLE_ID,
  SYNARA_DESKTOP_BUNDLE_ID_ENV,
} from "@synara/shared/desktopIdentity";
import { DEVICE_HELPER_SOURCE_DIR_ENV } from "@synara/shared/deviceHelperCache";
import { MIGRATION_RUNTIME_SOURCE_DIGEST_ENV } from "@synara/shared/migrationRecovery";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildDesktopServeEnv,
  extractDesktopServeCliArgs,
  resolveDesktopServeExitCode,
  runDesktopServeCli,
} from "./desktopServeCli";

describe("extractDesktopServeCliArgs", () => {
  it("extracts packaged `synara serve` invocations", () => {
    expect(extractDesktopServeCliArgs(["/opt/synara/synara", "serve"], true)).toEqual(["serve"]);
    expect(
      extractDesktopServeCliArgs(
        ["/opt/synara/synara", "serve", "--port", "4000", "--no-browser"],
        true,
      ),
    ).toEqual(["serve", "--port", "4000", "--no-browser"]);
    expect(extractDesktopServeCliArgs(["/opt/synara/synara", "serve", "--help"], true)).toEqual([
      "serve",
      "--help",
    ]);
  });

  it("extracts packaged invocations with root flags before `serve`", () => {
    expect(
      extractDesktopServeCliArgs(
        ["/opt/synara/synara", "--home-dir", "/tmp/synara-home", "serve", "--port", "4001"],
        true,
      ),
    ).toEqual(["--home-dir", "/tmp/synara-home", "serve", "--port", "4001"]);
    expect(
      extractDesktopServeCliArgs(
        ["/opt/synara/synara", "--home-dir=/tmp/synara-home", "--no-browser", "serve"],
        true,
      ),
    ).toEqual(["--home-dir=/tmp/synara-home", "--no-browser", "serve"]);
  });

  it("ignores normal packaged GUI launches and flag values named `serve`", () => {
    expect(extractDesktopServeCliArgs(["/opt/synara/synara"], true)).toBeNull();
    expect(
      extractDesktopServeCliArgs(["/opt/synara/synara", "--ozone-platform=wayland"], true),
    ).toBeNull();
    expect(extractDesktopServeCliArgs(["/opt/synara/synara", "-psn_0_12345"], true)).toBeNull();
    expect(extractDesktopServeCliArgs(["/opt/synara/synara", "--", "serve"], true)).toBeNull();
    expect(
      extractDesktopServeCliArgs(["/opt/synara/synara", "--home-dir", "serve"], true),
    ).toBeNull();
    expect(extractDesktopServeCliArgs(["/opt/synara/synara", "--home-dir=serve"], true)).toBeNull();
  });

  it("extracts unpackaged dev Electron invocations after the main entry argument", () => {
    expect(
      extractDesktopServeCliArgs(
        [
          "/path/to/electron",
          "--synara-dev-root=/repo",
          "dist-electron/main.js",
          "serve",
          "--port",
          "4123",
        ],
        false,
      ),
    ).toEqual(["serve", "--port", "4123"]);
    expect(
      extractDesktopServeCliArgs(["/path/to/electron", ".", "serve", "--no-browser"], false),
    ).toEqual(["serve", "--no-browser"]);
    expect(
      extractDesktopServeCliArgs(["/path/to/electron", "dist-electron/main.js"], false),
    ).toBeNull();
    expect(
      extractDesktopServeCliArgs(
        ["/path/to/electron", "--synara-dev-root=/repo", "dist-electron/main.js"],
        false,
      ),
    ).toBeNull();
  });
});

describe("buildDesktopServeEnv", () => {
  it("sets ELECTRON_RUN_AS_NODE, flavor defaults, packaged paths, and strips GUI-only tokens", () => {
    const env = buildDesktopServeEnv({
      baseEnv: {
        PATH: "/usr/bin",
        SYNARA_DESKTOP_PARENT_STDIN: "1",
        SYNARA_DESKTOP_SHUTDOWN_TOKEN: "desktop-secret",
      },
      backendEntry: "/opt/synara/resources/app.asar/apps/server/dist/index.mjs",
      defaultHomeDir: "/home/alice/.synara-beta",
      desktopBundleId: SYNARA_BETA_BUNDLE_ID,
      isPackaged: true,
      platform: "linux",
      resourcesPath: "/opt/synara/resources",
      staticDir: "/home/alice/.config/synara-beta/static-snapshots/abc",
      migrationSourceDigest: "digest-123",
    });

    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.SYNARA_SERVER_ENTRY).toBe(
      "/opt/synara/resources/app.asar/apps/server/dist/index.mjs",
    );
    expect(env.SYNARA_HOME).toBe("/home/alice/.synara-beta");
    expect(env[SYNARA_DESKTOP_BUNDLE_ID_ENV]).toBe(SYNARA_BETA_BUNDLE_ID);
    expect(env.SYNARA_STATIC_DIR).toBe("/home/alice/.config/synara-beta/static-snapshots/abc");
    expect(env[MIGRATION_RUNTIME_SOURCE_DIGEST_ENV]).toBe("digest-123");
    expect(env[DEVICE_HELPER_SOURCE_DIR_ENV]).toBe("/opt/synara/resources/device-helper");
    expect(env.SYNARA_CLOUDFLARED_PATH).toBe("/opt/synara/resources/cloudflared/cloudflared");
    expect(env.SYNARA_DESKTOP_PARENT_STDIN).toBeUndefined();
    expect(env.SYNARA_DESKTOP_SHUTDOWN_TOKEN).toBeUndefined();
  });

  it("preserves explicit user env overrides", () => {
    const env = buildDesktopServeEnv({
      baseEnv: {
        SYNARA_HOME: "/custom/home",
        SYNARA_STATIC_DIR: "/custom/static",
        SYNARA_AUTH_TOKEN: "my-token",
        SYNARA_PORT: "4888",
      },
      backendEntry: "/repo/apps/server/dist/index.mjs",
      defaultHomeDir: "/home/alice/.synara",
      desktopBundleId: "com.emanueledipietro.synara",
      isPackaged: false,
      staticDir: "/ignored/static",
    });

    expect(env.SYNARA_HOME).toBe("/custom/home");
    expect(env.SYNARA_STATIC_DIR).toBe("/custom/static");
    expect(env.SYNARA_AUTH_TOKEN).toBe("my-token");
    expect(env.SYNARA_PORT).toBe("4888");
  });
});

describe("resolveDesktopServeExitCode", () => {
  it("maps numeric codes and termination signals", () => {
    expect(resolveDesktopServeExitCode(0, null)).toBe(0);
    expect(resolveDesktopServeExitCode(2, null)).toBe(2);
    expect(resolveDesktopServeExitCode(null, "SIGINT")).toBe(130);
    expect(resolveDesktopServeExitCode(null, "SIGTERM")).toBe(143);
    expect(resolveDesktopServeExitCode(null, null)).toBe(1);
  });
});

describe("runDesktopServeCli", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      FS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("spawns the backend entry with ELECTRON_RUN_AS_NODE and propagates args and exit code", async () => {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-desktop-serve-cli-"));
    tempDirs.push(dir);
    const outFile = Path.join(dir, "result.json");
    const entryFile = Path.join(dir, "fake-server.mjs");
    FS.writeFileSync(
      entryFile,
      [
        'import fs from "node:fs";',
        "fs.writeFileSync(",
        `  ${JSON.stringify(outFile)},`,
        "  JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), runAsNode: process.env.ELECTRON_RUN_AS_NODE }),",
        ");",
        "process.exit(7);",
      ].join("\n"),
    );

    const exitCode = await new Promise<number>((resolve) => {
      runDesktopServeCli({
        execPath: process.execPath,
        nodeArgs: [],
        backendEntry: entryFile,
        serveArgs: ["serve", "--port", "4012", "--no-browser"],
        cwd: dir,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        onExit: resolve,
      });
    });

    expect(exitCode).toBe(7);
    const recorded = JSON.parse(FS.readFileSync(outFile, "utf8")) as {
      argv: string[];
      cwd: string;
      runAsNode: string;
    };
    expect(recorded.argv).toEqual(["serve", "--port", "4012", "--no-browser"]);
    expect(FS.realpathSync(recorded.cwd)).toBe(FS.realpathSync(dir));
    expect(recorded.runAsNode).toBe("1");
  });
});
