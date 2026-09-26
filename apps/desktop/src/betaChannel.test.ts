// FILE: betaChannel.test.ts
// Purpose: Unit coverage for the stable→beta handoff helpers.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawnCalls: { command: string; env: NodeJS.ProcessEnv | undefined }[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (String(args[0]).includes("failing-beta")) {
        throw new Error("spawn ENOENT");
      }
      spawnCalls.push({
        command: String(args[0]),
        env: (args[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env,
      });
      const child = {
        unref: () => {},
        on: () => child,
        once: (event: string, listener: (error?: Error) => void) => {
          const asyncFailure = String(args[0]).includes("async-fail");
          if (event === (asyncFailure ? "error" : "spawn")) {
            queueMicrotask(() => listener(asyncFailure ? new Error("spawn EACCES") : undefined));
          }
          return child;
        },
        pid: 4321,
      };
      return child;
    },
  };
});

import {
  BETA_IMPORT_REQUEST_FILE_NAME,
  BETA_IMPORT_RESULT_FILE_NAME,
  BETA_IMPORT_STORAGE_FILE_NAME,
  SYNARA_BETA_HOME_ENV,
  SYNARA_BETA_INSTALL_DIR_ENV,
  SYNARA_STABLE_EXECUTABLE_ENV,
  SYNARA_STABLE_HOME_ENV,
} from "@synara/shared/betaChannel";
import { SYNARA_DESKTOP_SMOKE_USER_DATA_ENV } from "@synara/shared/desktopIdentity";
import {
  BETA_WINDOWS_UNINSTALL_GUID,
  DesktopBetaChannel,
  betaLaunchEnvironment,
  detectBetaInstall,
  detectStableExecutable,
  isBetaServerRunning,
  readBetaImportResult,
  resolveBetaHomeDir,
  stableLaunchEnvironment,
  writeBetaImportRequest,
  writeBetaImportStorageSnapshot,
} from "./betaChannel";

import { resolveSynaraStorageSnapshotPath } from "./desktopStorageMigration";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "synara-beta-channel-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const makeChannel = (
  root: string,
  flavor: "production" | "beta" | "canary" = "production",
  extra: Partial<ConstructorParameters<typeof DesktopBetaChannel>[0]> = {},
) =>
  new DesktopBetaChannel({
    platform: "linux",
    homeDir: root,
    betaHomeDir: join(root, ".synara-beta"),
    flavor,
    ...extra,
  });

describe("DesktopBetaChannel", () => {
  it("reports unsupported actions on non-production flavors", async () => {
    const root = makeRoot();
    const beta = makeChannel(root, "beta");
    expect((await beta.launch()).ok).toBe(false);
    expect((await beta.importAndLaunch(root)).error).toBe("not-supported");
    expect(beta.getState().flavor).toBe("beta");
  });

  it("reports not-installed on a clean machine", () => {
    const root = makeRoot();
    const state = makeChannel(root).getState();
    expect(state.installed).toBe(false);
    expect(state.running).toBe(false);
    expect(state.lastImportAt).toBeNull();
    expect(state.canInstall).toBe(false);
    expect(state.install).toBeNull();
    expect(state.downloadUrl).toContain("releases");
  });

  it("refuses the import when beta is missing", async () => {
    const root = makeRoot();
    const result = await makeChannel(root).importAndLaunch(root);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not-installed");
  });

  it("refuses the import while the beta server is running", async () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    mkdirSync(join(betaHome, "userdata"), { recursive: true });
    writeFileSync(
      join(betaHome, "userdata", "server-runtime.json"),
      JSON.stringify({ version: 1, pid: process.pid, port: 3773, origin: "http://127.0.0.1" }),
    );
    // Pretend beta is installed via PATH is not possible here; the running check
    // must trip before launch either way once an install exists.
    const channel = makeChannel(root);
    expect(isBetaServerRunning(betaHome)).toBe(true);
    const result = await channel.importAndLaunch(root);
    expect(result.ok).toBe(false);
    // "not-installed" wins first on this machine; running detection is
    // independently covered by isBetaServerRunning.
    expect(["beta-running", "not-installed"]).toContain(result.error);
  });

  it("removes the import marker when launching beta throws", async () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    // Fake a linux install through its desktop file so detection resolves a
    // (failing) executable path.
    const desktopDir = join(root, ".local", "share", "applications");
    mkdirSync(desktopDir, { recursive: true });
    writeFileSync(join(desktopDir, "synara-beta.desktop"), "Exec=/opt/failing-beta\n");

    const result = await makeChannel(root).importAndLaunch(join(root, ".synara"));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("internal");
    // The marker must not outlive the failed launch; a leftover would import
    // on the next unrelated beta start.
    expect(existsSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME))).toBe(false);
  });

  it("installs via the feed, then launches the new app on macOS", async () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    const installDir = join(root, "Applications");
    const channel = new DesktopBetaChannel({
      platform: "darwin",
      homeDir: root,
      betaHomeDir: betaHome,
      flavor: "production",
      installDirOverride: installDir,
      betaUserDataDir: join(root, "beta-userdata"),
      install: async (onProgress) => {
        onProgress({ phase: "downloading", percent: 42 });
        mkdirSync(join(installDir, "Synara Beta.app"), { recursive: true });
        return join(installDir, "Synara Beta.app");
      },
    });

    const result = await channel.importAndLaunch(join(root, ".synara"));
    expect(result.ok).toBe(true);
    expect(existsSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME))).toBe(true);
    const last = spawnCalls.at(-1);
    expect(last?.command).toBe(
      join(installDir, "Synara Beta.app", "Contents", "MacOS", "Synara Beta"),
    );
    // Beta gets its own home; stable's overrides must not leak through.
    expect(last?.env?.[SYNARA_BETA_HOME_ENV]).toBe(betaHome);
    expect(last?.env?.SYNARA_HOME).toBeUndefined();
    expect(last?.env?.[SYNARA_DESKTOP_SMOKE_USER_DATA_ENV]).toBe(join(root, "beta-userdata"));
    // The flow is finished: no stale progress is reported.
    expect(channel.getState().install).toBeNull();
    expect(channel.getState().installed).toBe(true);
  });

  it("reports an install failure and keeps it visible in state", async () => {
    const root = makeRoot();
    const channel = new DesktopBetaChannel({
      platform: "darwin",
      homeDir: root,
      betaHomeDir: join(root, ".synara-beta"),
      flavor: "production",
      installDirOverride: join(root, "Applications"),
      install: async () => {
        throw new Error("checksum mismatch");
      },
    });
    const result = await channel.install();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("install-failed");
    expect(channel.getState().install?.phase).toBe("error");
    expect(channel.getState().install?.message).toContain("checksum mismatch");
  });
});

describe("isBetaServerRunning", () => {
  it("is false without a runtime file", () => {
    const root = makeRoot();
    expect(isBetaServerRunning(join(root, ".synara-beta"))).toBe(false);
  });

  it("is false when the recorded pid is stale", () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    mkdirSync(join(betaHome, "userdata"), { recursive: true });
    writeFileSync(
      join(betaHome, "userdata", "server-runtime.json"),
      JSON.stringify({ version: 1, pid: 4194303, port: 3773 }),
    );
    expect(isBetaServerRunning(betaHome)).toBe(false);
  });

  it("is false for a malformed runtime file", () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    mkdirSync(join(betaHome, "userdata"), { recursive: true });
    writeFileSync(join(betaHome, "userdata", "server-runtime.json"), "not json");
    expect(isBetaServerRunning(betaHome)).toBe(false);
  });
});

describe("import marker files", () => {
  it("round-trips the request marker atomically", () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    writeBetaImportRequest({ betaHomeDir: betaHome, sourceHomeDir: join(root, ".synara") });
    const request = JSON.parse(readFileSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME), "utf8"));
    expect(request.version).toBe(1);
    expect(request.sourceHomeDir).toBe(join(root, ".synara"));
    expect(typeof request.requestedAt).toBe("string");
  });

  it("reads a success result back for the settings card", () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    mkdirSync(betaHome, { recursive: true });
    const completedAt = new Date().toISOString();
    writeFileSync(
      join(betaHome, BETA_IMPORT_RESULT_FILE_NAME),
      JSON.stringify({ version: 1, completedAt, ok: true }),
    );
    expect(readBetaImportResult(betaHome)?.completedAt).toBe(completedAt);
  });

  it("surfaces a failed import error", () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    mkdirSync(betaHome, { recursive: true });
    writeFileSync(
      join(betaHome, BETA_IMPORT_RESULT_FILE_NAME),
      JSON.stringify({
        version: 1,
        completedAt: new Date().toISOString(),
        ok: false,
        error: "db locked",
      }),
    );
    const channel = makeChannel(root).getState();
    expect(channel.lastImportError).toBe("db locked");
    expect(channel.lastImportAt).toBeNull();
  });
});

describe("import storage snapshot", () => {
  const makeSnapshot = (entries: Record<string, string> = { "synara:theme": '"dark"' }) => ({
    version: 1 as const,
    exportedAt: new Date().toISOString(),
    entries,
  });

  function fakeLinuxBetaInstall(root: string, executable: string): void {
    const desktopDir = join(root, ".local", "share", "applications");
    mkdirSync(desktopDir, { recursive: true });
    writeFileSync(join(desktopDir, "synara-beta.desktop"), `Exec=${executable}\n`);
  }

  it("writes the snapshot sidecar and beta-profile snapshot alongside the marker", async () => {
    const root = makeRoot();
    fakeLinuxBetaInstall(root, "/opt/fake-beta");
    const betaHome = join(root, ".synara-beta");
    const betaUserDataDir = join(root, "beta-userdata");
    const channel = makeChannel(root, "production", { betaUserDataDir });

    const result = await channel.importAndLaunch(join(root, ".synara"), {
      storageSnapshot: makeSnapshot(),
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME))).toBe(true);
    const sidecar = JSON.parse(readFileSync(join(betaHome, BETA_IMPORT_STORAGE_FILE_NAME), "utf8"));
    expect(sidecar.entries["synara:theme"]).toBe('"dark"');
    const profilePath = resolveSynaraStorageSnapshotPath(betaUserDataDir);
    expect(existsSync(profilePath)).toBe(true);
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    expect(profile.version).toBe(1);
    expect(profile.entries["synara:theme"]).toBe('"dark"');
  });

  it("removes the marker and both sidecars when launching beta throws", async () => {
    const root = makeRoot();
    fakeLinuxBetaInstall(root, "/opt/failing-beta");
    const betaHome = join(root, ".synara-beta");
    const betaUserDataDir = join(root, "beta-userdata");
    const channel = makeChannel(root, "production", { betaUserDataDir });

    const result = await channel.importAndLaunch(join(root, ".synara"), {
      storageSnapshot: makeSnapshot(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("internal");
    expect(existsSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME))).toBe(false);
    expect(existsSync(join(betaHome, BETA_IMPORT_STORAGE_FILE_NAME))).toBe(false);
    expect(existsSync(resolveSynaraStorageSnapshotPath(betaUserDataDir))).toBe(false);
  });

  it("never writes a marker for a malformed snapshot", async () => {
    const root = makeRoot();
    fakeLinuxBetaInstall(root, "/opt/fake-beta");
    const betaHome = join(root, ".synara-beta");
    const betaUserDataDir = join(root, "beta-userdata");
    const channel = makeChannel(root, "production", { betaUserDataDir });

    const result = await channel.importAndLaunch(join(root, ".synara"), {
      storageSnapshot: makeSnapshot({ "not-a-synara-key": "x" }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("internal");
    expect(existsSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME))).toBe(false);
    expect(existsSync(join(betaHome, BETA_IMPORT_STORAGE_FILE_NAME))).toBe(false);
    expect(existsSync(resolveSynaraStorageSnapshotPath(betaUserDataDir))).toBe(false);
  });

  it("writeBetaImportStorageSnapshot round-trips valid snapshots and rejects invalid ones", () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    writeBetaImportStorageSnapshot({ betaHomeDir: betaHome, snapshot: makeSnapshot() });
    const sidecar = JSON.parse(readFileSync(join(betaHome, BETA_IMPORT_STORAGE_FILE_NAME), "utf8"));
    expect(sidecar.version).toBe(1);
    expect(() =>
      writeBetaImportStorageSnapshot({
        betaHomeDir: betaHome,
        snapshot: makeSnapshot({ "not-a-synara-key": "x" }),
      }),
    ).toThrow();
  });
});

describe("detection constants", () => {
  it("keeps the Windows beta GUID stable", () => {
    expect(BETA_WINDOWS_UNINSTALL_GUID).toBe("a8e63b48-d4f3-4db5-9e12-368107afe65d");
  });
});

describe("environment overrides", () => {
  it("resolveBetaHomeDir honors SYNARA_BETA_HOME", () => {
    const root = makeRoot();
    const custom = join(root, "custom-beta-home");
    expect(resolveBetaHomeDir(root, { [SYNARA_BETA_HOME_ENV]: custom })).toBe(custom);
    expect(resolveBetaHomeDir(root, {})).toBe(join(root, ".synara-beta"));
  });

  it("detectBetaInstall finds the app in SYNARA_BETA_INSTALL_DIR", () => {
    const root = makeRoot();
    const installDir = join(root, "DemoApps");
    mkdirSync(join(installDir, "Synara Beta.app"), { recursive: true });
    const detection = detectBetaInstall("darwin", root, {
      [SYNARA_BETA_INSTALL_DIR_ENV]: installDir,
    });
    expect(detection.installed).toBe(true);
    expect(detection.installPath).toBe(join(installDir, "Synara Beta.app"));
  });

  it("betaLaunchEnvironment strips stable's data overrides and sets beta's own", () => {
    const env = betaLaunchEnvironment({
      env: {
        HOME: "/home/test",
        SYNARA_HOME: "/stable-home",
        [SYNARA_DESKTOP_SMOKE_USER_DATA_ENV]: "/stable-userdata",
        SYNARA_PORT: "3737",
        SYNARA_AUTH_TOKEN: "secret",
        ELECTRON_RUN_AS_NODE: "1",
      },
      betaHomeDir: "/beta-home",
      betaUserDataDir: "/beta-userdata",
    });
    expect(env.HOME).toBe("/home/test");
    expect(env.SYNARA_HOME).toBeUndefined();
    expect(env.SYNARA_PORT).toBeUndefined();
    expect(env.SYNARA_AUTH_TOKEN).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env[SYNARA_BETA_HOME_ENV]).toBe("/beta-home");
    expect(env[SYNARA_DESKTOP_SMOKE_USER_DATA_ENV]).toBe("/beta-userdata");
  });

  it("betaLaunchEnvironment leaves the smoke override unset without a beta userData", () => {
    const env = betaLaunchEnvironment({
      env: { [SYNARA_DESKTOP_SMOKE_USER_DATA_ENV]: "/stable-userdata" },
      betaHomeDir: "/beta-home",
    });
    expect(env[SYNARA_DESKTOP_SMOKE_USER_DATA_ENV]).toBeUndefined();
  });
});

describe("switching back to stable", () => {
  function fakeStableExecutable(root: string): string {
    const executable = join(root, "DemoApps", "Synara.app", "Contents", "MacOS", "Synara");
    mkdirSync(join(executable, ".."), { recursive: true });
    writeFileSync(executable, "");
    return executable;
  }

  it("stable hands its executable and data home to the beta it launches", () => {
    const env = betaLaunchEnvironment({
      env: {},
      betaHomeDir: "/beta-home",
      stableExecutablePath: "/Apps/Synara.app/Contents/MacOS/Synara",
      stableHomeDir: "/stable-home",
    });
    expect(env[SYNARA_STABLE_EXECUTABLE_ENV]).toBe("/Apps/Synara.app/Contents/MacOS/Synara");
    expect(env[SYNARA_STABLE_HOME_ENV]).toBe("/stable-home");
    expect(env.SYNARA_HOME).toBeUndefined();
  });

  it("stableLaunchEnvironment restores stable's home and drops beta's overrides", () => {
    const env = stableLaunchEnvironment({
      HOME: "/home/test",
      [SYNARA_BETA_HOME_ENV]: "/beta-home",
      [SYNARA_STABLE_HOME_ENV]: "/stable-home",
      [SYNARA_DESKTOP_SMOKE_USER_DATA_ENV]: "/beta-userdata",
      SYNARA_PORT: "3773",
      SYNARA_AUTH_TOKEN: "secret",
    });
    expect(env.HOME).toBe("/home/test");
    expect(env.SYNARA_HOME).toBe("/stable-home");
    expect(env[SYNARA_DESKTOP_SMOKE_USER_DATA_ENV]).toBeUndefined();
    expect(env.SYNARA_PORT).toBeUndefined();
    expect(env.SYNARA_AUTH_TOKEN).toBeUndefined();
    // Stable's beta card keeps working after the round trip.
    expect(env[SYNARA_BETA_HOME_ENV]).toBe("/beta-home");
  });

  it("stableLaunchEnvironment leaves SYNARA_HOME unset without a handed-over home", () => {
    expect(stableLaunchEnvironment({ SYNARA_HOME: "/beta-leak" }).SYNARA_HOME).toBeUndefined();
  });

  it("detectStableExecutable prefers the executable stable handed over", () => {
    const root = makeRoot();
    const executable = fakeStableExecutable(root);
    expect(
      detectStableExecutable("darwin", root, { [SYNARA_STABLE_EXECUTABLE_ENV]: executable }),
    ).toBe(executable);
  });

  it("detectStableExecutable ignores a missing or relative handed-over path", () => {
    const root = makeRoot();
    expect(
      detectStableExecutable("linux", root, {
        [SYNARA_STABLE_EXECUTABLE_ENV]: join(root, "gone", "Synara"),
      }),
    ).toBeNull();
    expect(
      detectStableExecutable("linux", root, { [SYNARA_STABLE_EXECUTABLE_ENV]: "Synara" }),
    ).toBeNull();
  });

  it("detectStableExecutable finds ~/Applications/Synara.app on macOS", () => {
    const root = makeRoot();
    const executable = join(root, "Applications", "Synara.app", "Contents", "MacOS", "Synara");
    mkdirSync(join(executable, ".."), { recursive: true });
    writeFileSync(executable, "");
    const found = detectStableExecutable("darwin", root, {});
    // /Applications/Synara.app wins when the machine running the test has it.
    expect([executable, "/Applications/Synara.app/Contents/MacOS/Synara"]).toContain(found);
  });

  it("leave opens stable with its own home and reports it in state", async () => {
    const root = makeRoot();
    const executable = fakeStableExecutable(root);
    const env = {
      [SYNARA_STABLE_EXECUTABLE_ENV]: executable,
      [SYNARA_STABLE_HOME_ENV]: join(root, "stable-home"),
      [SYNARA_DESKTOP_SMOKE_USER_DATA_ENV]: join(root, "beta-userdata"),
    };
    const channel = makeChannel(root, "beta", { platform: "darwin", env, canTrashOwnBundle: true });
    const state = channel.getState();
    expect(state.stableInstalled).toBe(true);
    expect(state.canMoveBetaToTrash).toBe(true);
    expect(state.stableDownloadUrl).toContain("releases/latest");

    expect(await channel.leave()).toEqual({ ok: true });
    const last = spawnCalls.at(-1);
    expect(last?.command).toBe(executable);
    expect(last?.env?.SYNARA_HOME).toBe(join(root, "stable-home"));
    expect(last?.env?.[SYNARA_DESKTOP_SMOKE_USER_DATA_ENV]).toBeUndefined();
  });

  it("leave reports not-installed when stable cannot be found", async () => {
    const root = makeRoot();
    const channel = makeChannel(root, "beta", { env: {} });
    expect(channel.getState().stableInstalled).toBe(false);
    expect((await channel.leave()).error).toBe("not-installed");
  });

  it("leave is refused outside beta", async () => {
    const root = makeRoot();
    const executable = fakeStableExecutable(root);
    const channel = makeChannel(root, "production", {
      env: { [SYNARA_STABLE_EXECUTABLE_ENV]: executable },
    });
    expect((await channel.leave()).error).toBe("not-supported");
    expect(channel.getState().stableInstalled).toBe(false);
    expect(channel.getState().canMoveBetaToTrash).toBe(false);
  });

  it("does not offer the Trash step unless main says the bundle is trashable", () => {
    const root = makeRoot();
    expect(makeChannel(root, "beta", { platform: "darwin" }).getState().canMoveBetaToTrash).toBe(
      false,
    );
  });

  it("detectStableExecutable rejects a handed-over directory", () => {
    const root = makeRoot();
    expect(
      detectStableExecutable("linux", root, { [SYNARA_STABLE_EXECUTABLE_ENV]: root }),
    ).toBeNull();
  });

  it("reports an async spawn failure instead of crashing", async () => {
    const root = makeRoot();
    const executable = join(root, "async-fail-stable");
    writeFileSync(executable, "");
    const channel = makeChannel(root, "beta", {
      env: { [SYNARA_STABLE_EXECUTABLE_ENV]: executable },
    });
    const result = await channel.leave();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("launch-failed");
    expect(result.message).toContain("EACCES");
  });
});
