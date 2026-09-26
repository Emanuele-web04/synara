// FILE: betaChannel.ts
// Purpose: Stable-side probe + handoff into a parallel Synara Beta install.
// Layer: Desktop platform adapter (no Electron imports; every path is injectable for tests).
//
// Flow: stable writes `<betaHome>/import-requested.json` and launches the beta
// app; the beta server consumes the marker at startup (see
// `apps/server/src/betaImport.ts`) and reports back through
// `<betaHome>/import-result.json`, which this module reads for the UI.

import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import {
  BETA_IMPORT_REQUEST_FILE_NAME,
  BETA_IMPORT_RESULT_FILE_NAME,
  BETA_IMPORT_STORAGE_FILE_NAME,
  SYNARA_BETA_HOME_DIR_NAME,
  SYNARA_BETA_HOME_ENV,
  SYNARA_BETA_INSTALL_DIR_ENV,
  SYNARA_BETA_RELEASES_URL,
  SYNARA_BETA_USER_DATA_ENV,
  SYNARA_BETA_WINDOWS_INSTALLER_GUID,
  SYNARA_STABLE_EXECUTABLE_ENV,
  SYNARA_STABLE_HOME_ENV,
  SYNARA_STABLE_RELEASES_URL,
  SYNARA_STABLE_WINDOWS_INSTALLER_GUID,
  type BetaImportResult,
} from "@synara/shared/betaChannel";
import {
  SYNARA_DESKTOP_SMOKE_USER_DATA_ENV,
  synaraDesktopIdentity,
} from "@synara/shared/desktopIdentity";
import type {
  DesktopBetaActionError,
  DesktopBetaActionResult,
  DesktopBetaChannelState,
  DesktopBetaInstallProgress,
  DesktopBridge,
  SynaraStorageSnapshot,
} from "@synara/contracts";

import { installBetaFromFeed, type BetaInstallDeps, type ExpectedTeamId } from "./betaInstaller";

import {
  resolveSynaraStorageSnapshotPath,
  validateSynaraStorageSnapshot,
} from "./desktopStorageMigration";
import { resolveDesktopAppDataBase, resolveDesktopUserDataPath } from "./desktopUserDataProfile";

// electron-builder registers the uninstall key under the raw NSIS guid (no
// braces); the value itself lives in @synara/shared/betaChannel.
export const BETA_WINDOWS_UNINSTALL_GUID = SYNARA_BETA_WINDOWS_INSTALLER_GUID;
const BETA_MAC_APP_NAME = "Synara Beta.app";
const BETA_MAC_EXECUTABLE_NAME = "Synara Beta";
const BETA_WINDOWS_EXE_NAME = "Synara Beta.exe";
const BETA_LINUX_DESKTOP_FILE = "synara-beta.desktop";
const STABLE_MAC_APP_NAME = "Synara.app";
const STABLE_MAC_EXECUTABLE_NAME = "Synara";
const STABLE_WINDOWS_EXE_NAME = "Synara.exe";

export interface BetaInstallDetection {
  readonly installed: boolean;
  readonly installPath: string | null;
  readonly executablePath: string | null;
  readonly version: string | null;
}

interface BetaChannelDeps {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly betaHomeDir: string;
  /** Flavor of the running app; only "production" may initiate the handoff. */
  readonly flavor: "production" | "beta" | "canary" | "cua";
  /** Base URL serving beta-mac.yml and its files; falls back to GitHub releases. */
  readonly feedUrlOverride?: string | undefined;
  /** Install target for the macOS bundle; defaults to /Applications. */
  readonly installDirOverride?: string | undefined;
  /** Team id the downloaded beta must be signed by; null when unsigned. */
  readonly expectedTeamId?: ExpectedTeamId | undefined;
  /** Electron userData handed to the launched beta when set. */
  readonly betaUserDataDir?: string | undefined;
  /** Stable's own executable and data home, handed to beta for the way back. */
  readonly stableExecutablePath?: string | undefined;
  readonly stableHomeDir?: string | undefined;
  /** Beta only: the running bundle is a packaged `Synara Beta.app` main may trash. */
  readonly canTrashOwnBundle?: boolean | undefined;
  /** Environment beta was launched with; read for the stable handoff (tests). */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Injectable installer (tests). Defaults to the real feed install. */
  readonly install?: (
    onProgress: (progress: DesktopBetaInstallProgress) => void,
  ) => Promise<string>;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Spawns a detached app and resolves once it has actually started. Spawn
 * failures (ENOENT, EACCES) arrive asynchronously as an `error` event; without
 * a listener they would crash the main process.
 */
export function spawnDetached(command: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [], { detached: true, stdio: "ignore", env });
    child.once("error", rejectPromise);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

/** Per-process overrides that belong to the launching app, never the launched one. */
const LAUNCHER_ONLY_ENV_KEYS = [
  "SYNARA_HOME",
  SYNARA_DESKTOP_SMOKE_USER_DATA_ENV,
  "SYNARA_PORT",
  "SYNARA_AUTH_TOKEN",
  "SYNARA_DESKTOP_WS_URL",
  "SYNARA_DESKTOP_SHUTDOWN_TOKEN",
  "SYNARA_DESKTOP_FLAVOR",
  "VITE_DEV_SERVER_URL",
  "ELECTRON_RUN_AS_NODE",
  SYNARA_STABLE_EXECUTABLE_ENV,
  SYNARA_STABLE_HOME_ENV,
];

function withoutLauncherOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of LAUNCHER_ONLY_ENV_KEYS) delete next[key];
  return next;
}

/** Environment inherited by a launched beta. Stable's own data-home and
 * userData overrides must not leak; beta gets its own. */
export function betaLaunchEnvironment(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly betaHomeDir: string;
  readonly betaUserDataDir?: string | undefined;
  readonly stableExecutablePath?: string | undefined;
  readonly stableHomeDir?: string | undefined;
}): NodeJS.ProcessEnv {
  const env = withoutLauncherOverrides(input.env ?? process.env);
  env[SYNARA_BETA_HOME_ENV] = input.betaHomeDir;
  const userData = input.betaUserDataDir ?? env[SYNARA_BETA_USER_DATA_ENV];
  if (userData) {
    env[SYNARA_DESKTOP_SMOKE_USER_DATA_ENV] = userData;
  }
  if (input.stableExecutablePath) env[SYNARA_STABLE_EXECUTABLE_ENV] = input.stableExecutablePath;
  if (input.stableHomeDir) env[SYNARA_STABLE_HOME_ENV] = input.stableHomeDir;
  return env;
}

/** Environment for reopening stable from beta: beta's overrides are dropped and
 * stable gets back the data home it handed over, when it handed one over. */
export function stableLaunchEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = withoutLauncherOverrides(env);
  const stableHome = env[SYNARA_STABLE_HOME_ENV]?.trim();
  if (stableHome) next.SYNARA_HOME = stableHome;
  return next;
}

/**
 * Finds the stable app to reopen from beta: the exact executable stable handed
 * over at launch, otherwise the standard install locations.
 */
export function detectStableExecutable(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const handedOver = env[SYNARA_STABLE_EXECUTABLE_ENV]?.trim();
  if (handedOver && isAbsolute(handedOver) && isFile(handedOver)) return handedOver;
  if (platform === "darwin") {
    for (const appPath of [
      `/Applications/${STABLE_MAC_APP_NAME}`,
      join(homeDir, "Applications", STABLE_MAC_APP_NAME),
    ]) {
      const executable = join(appPath, "Contents", "MacOS", STABLE_MAC_EXECUTABLE_NAME);
      if (isFile(executable)) return executable;
    }
    return null;
  }
  if (platform === "win32") {
    for (const hive of ["HKCU", "HKLM"]) {
      const installLocation = readRegistryValue(
        `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${SYNARA_STABLE_WINDOWS_INSTALLER_GUID}`,
        "InstallLocation",
      );
      const executable = installLocation ? join(installLocation, STABLE_WINDOWS_EXE_NAME) : null;
      if (executable && isFile(executable)) return executable;
    }
  }
  return null;
}

/** The directories macOS installs probe, honoring `SYNARA_BETA_INSTALL_DIR`. */
export function betaMacInstallDirs(input?: {
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}): string[] {
  const env = input?.env ?? process.env;
  const override = env[SYNARA_BETA_INSTALL_DIR_ENV]?.trim();
  const homeDir = input?.homeDir ?? homedir();
  return [
    ...(override ? [join(override, BETA_MAC_APP_NAME)] : []),
    `/Applications/${BETA_MAC_APP_NAME}`,
    join(homeDir, "Applications", BETA_MAC_APP_NAME),
  ];
}

const readRegistryValue = (key: string, value: string): string | null => {
  try {
    const output = execFileSync("reg.exe", ["query", key, "/v", value], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    const match = output.match(new RegExp(`${value}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+)`, "i"));
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
};

export function detectBetaInstall(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): BetaInstallDetection {
  const missing: BetaInstallDetection = {
    installed: false,
    installPath: null,
    executablePath: null,
    version: null,
  };
  if (platform === "darwin") {
    for (const appPath of betaMacInstallDirs({ homeDir, env })) {
      if (existsSync(appPath)) {
        return {
          installed: true,
          installPath: appPath,
          executablePath: appPath,
          version: readMacBundleVersion(appPath),
        };
      }
    }
    return missing;
  }
  if (platform === "win32") {
    for (const hive of ["HKCU", "HKLM"]) {
      const key = `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${BETA_WINDOWS_UNINSTALL_GUID}`;
      const installLocation = readRegistryValue(key, "InstallLocation");
      const displayVersion = readRegistryValue(key, "DisplayVersion");
      if (installLocation) {
        const executablePath = join(installLocation, BETA_WINDOWS_EXE_NAME);
        return {
          installed: existsSync(executablePath),
          installPath: installLocation,
          executablePath: existsSync(executablePath) ? executablePath : null,
          version: displayVersion,
        };
      }
    }
    return missing;
  }
  if (platform === "linux") {
    const executablePath = findOnPath("synara-beta");
    if (executablePath) {
      return {
        installed: true,
        installPath: executablePath,
        executablePath,
        version: null,
      };
    }
    const desktopFile = join(homeDir, ".local", "share", "applications", BETA_LINUX_DESKTOP_FILE);
    if (existsSync(desktopFile)) {
      const execLine = readFileSync(desktopFile, "utf8")
        .split("\n")
        .find((line) => line.startsWith("Exec="));
      const resolved = execLine
        ?.slice(5)
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .split(" ")[0];
      return {
        installed: true,
        installPath: resolved ?? null,
        executablePath: resolved && isAbsolute(resolved) ? resolved : null,
        version: null,
      };
    }
  }
  return missing;
}

function readMacBundleVersion(appPath: string): string | null {
  const plistPath = join(appPath, "Contents", "Info.plist");
  if (!existsSync(plistPath)) return null;
  try {
    const output = execFileSync(
      "/usr/bin/defaults",
      ["read", join(appPath, "Contents", "Info"), "CFBundleShortVersionString"],
      { encoding: "utf8", timeout: 5_000 },
    );
    return output.trim() || null;
  } catch {
    return null;
  }
}

function findOnPath(binary: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    try {
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // keep scanning
    }
  }
  return null;
}

/** Beta is considered running when its server runtime pid is still alive. */
export function isBetaServerRunning(betaHomeDir: string): boolean {
  const runtimePath = join(betaHomeDir, "userdata", "server-runtime.json");
  try {
    if (!existsSync(runtimePath)) return false;
    const parsed = JSON.parse(readFileSync(runtimePath, "utf8")) as { pid?: unknown };
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return false;
    }
    process.kill(parsed.pid, 0);
    return true;
  } catch (error) {
    // ESRCH means no such process; EPERM means it exists but is not ours.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readBetaImportResult(betaHomeDir: string): BetaImportResult | null {
  const resultPath = join(betaHomeDir, BETA_IMPORT_RESULT_FILE_NAME);
  try {
    if (!existsSync(resultPath)) return null;
    const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === 1 &&
      typeof parsed.completedAt === "string" &&
      typeof parsed.ok === "boolean"
    ) {
      return parsed as BetaImportResult;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeBetaImportRequest(input: {
  readonly betaHomeDir: string;
  readonly sourceHomeDir: string;
}): void {
  mkdirSync(input.betaHomeDir, { recursive: true });
  const requestPath = join(input.betaHomeDir, BETA_IMPORT_REQUEST_FILE_NAME);
  const tempPath = `${requestPath}.tmp-${process.pid}`;
  writeFileSync(
    tempPath,
    `${JSON.stringify({
      version: 1,
      requestedAt: new Date().toISOString(),
      sourceHomeDir: resolve(input.sourceHomeDir),
    })}\n`,
    "utf8",
  );
  renameSync(tempPath, requestPath);
}

/**
 * Writes the web-supplied storage snapshot beside the import marker for
 * debuggability (`<betaHome>/import-storage.json`). The validated snapshot is
 * also fanned out to beta's Electron profile by the caller; this sidecar
 * itself is never consumed at startup.
 *
 * Throws when the snapshot fails the shared storage-migration caps so the
 * caller can remove any half-written handoff.
 */
export function writeBetaImportStorageSnapshot(input: {
  readonly betaHomeDir: string;
  readonly snapshot: SynaraStorageSnapshot;
}): void {
  const validated = validateSynaraStorageSnapshot(input.snapshot);
  if (!validated) {
    throw new Error("Refusing to write an invalid Synara storage snapshot for the beta import.");
  }
  mkdirSync(input.betaHomeDir, { recursive: true });
  const snapshotPath = join(input.betaHomeDir, BETA_IMPORT_STORAGE_FILE_NAME);
  const tempPath = `${snapshotPath}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(validated)}\n`, "utf8");
  renameSync(tempPath, snapshotPath);
}

type BetaImportAndLaunchInput = Parameters<
  NonNullable<DesktopBridge["beta"]>["importAndLaunch"]
>[0];

/**
 * Launches the installed beta by executable path with a sanitized environment.
 * Spawning the binary directly (rather than `open`) keeps Launch Services from
 * re-activating a different copy, and the env scrub keeps stable's own data
 * overrides from leaking into the beta process.
 */
export async function launchBetaInstall(
  detection: BetaInstallDetection,
  platform: NodeJS.Platform = process.platform,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const executablePath = detection.executablePath;
  if (!detection.installed || !executablePath) {
    throw new Error("Synara Beta is not installed");
  }
  if (platform === "darwin") {
    const installPath = detection.installPath;
    if (!installPath) {
      throw new Error("Synara Beta is not installed");
    }
    await spawnDetached(
      join(installPath, "Contents", "MacOS", BETA_MAC_EXECUTABLE_NAME),
      env ?? process.env,
    );
    return;
  }
  await spawnDetached(executablePath, env ?? process.env);
}

const action = (
  ok: boolean,
  error?: DesktopBetaActionError,
  message?: string,
): DesktopBetaActionResult => ({
  ok,
  ...(error ? { error } : {}),
  ...(message ? { message } : {}),
});

export class DesktopBetaChannel {
  private installProgress: DesktopBetaInstallProgress | null = null;
  private installInFlight: Promise<void> | null = null;

  constructor(private readonly deps: BetaChannelDeps) {}

  /** macOS can install beta in place; other platforms keep the download page. */
  private get canInstall(): boolean {
    return this.deps.platform === "darwin";
  }

  private detect(): BetaInstallDetection {
    return detectBetaInstall(this.deps.platform, this.deps.homeDir);
  }

  private detectStable(): string | null {
    return detectStableExecutable(this.deps.platform, this.deps.homeDir, this.deps.env);
  }

  private launchEnv(): NodeJS.ProcessEnv {
    return betaLaunchEnvironment({
      betaHomeDir: this.deps.betaHomeDir,
      betaUserDataDir: this.deps.betaUserDataDir,
      stableExecutablePath: this.deps.stableExecutablePath,
      stableHomeDir: this.deps.stableHomeDir,
    });
  }

  /**
   * Beta side of "Switch back to Synara": opens stable with its own data home.
   * Beta data is never copied back; the caller quits beta once this succeeds.
   */
  async leave(): Promise<DesktopBetaActionResult> {
    if (this.deps.flavor !== "beta") {
      return action(false, "not-supported", "Switching back is only available from Synara Beta.");
    }
    const executable = this.detectStable();
    if (!executable) {
      return action(false, "not-installed", "Synara isn't installed on this computer.");
    }
    try {
      await spawnDetached(executable, stableLaunchEnvironment(this.deps.env ?? process.env));
      return action(true);
    } catch (error) {
      return action(false, "launch-failed", error instanceof Error ? error.message : String(error));
    }
  }

  getState(): DesktopBetaChannelState {
    const detection = this.detect();
    const running = isBetaServerRunning(this.deps.betaHomeDir);
    const result = readBetaImportResult(this.deps.betaHomeDir);
    const stableExecutable = this.deps.flavor === "beta" ? this.detectStable() : null;
    return {
      supported: true,
      flavor: this.deps.flavor,
      stableInstalled: stableExecutable !== null,
      canMoveBetaToTrash: this.deps.flavor === "beta" && this.deps.canTrashOwnBundle === true,
      stableDownloadUrl: SYNARA_STABLE_RELEASES_URL,
      installed: detection.installed,
      version: detection.version,
      canInstall: this.canInstall,
      running,
      lastImportAt: result && result.ok ? result.completedAt : null,
      lastImportError: result && !result.ok ? (result.error ?? "import failed") : null,
      downloadUrl: SYNARA_BETA_RELEASES_URL,
      install: this.installProgress,
    };
  }

  /** Launch beta as-is; refuses only when the install is missing. */
  async launch(): Promise<DesktopBetaActionResult> {
    if (this.deps.flavor !== "production") {
      return action(false, "not-supported", "Beta handoff is only available from stable Synara.");
    }
    const detection = this.detect();
    if (!detection.installed || !detection.executablePath) {
      return action(false, "not-installed", "Synara Beta is not installed yet.");
    }
    try {
      await launchBetaInstall(detection, this.deps.platform, this.launchEnv());
      return action(true);
    } catch (error) {
      return action(false, "launch-failed", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Ensures beta is installed, downloading it from the feed when missing.
   * Concurrent callers share one in-flight install.
   */
  private async ensureInstalled(): Promise<DesktopBetaActionResult> {
    if (this.detect().installed) return action(true);
    if (!this.canInstall) {
      return action(false, "not-installed", "Synara Beta is not installed yet.");
    }
    this.installInFlight ??= (async () => {
      const install =
        this.deps.install ??
        ((onProgress: (progress: DesktopBetaInstallProgress) => void) =>
          installBetaFromFeed(this.installDeps(), onProgress));
      try {
        await install((progress) => {
          this.installProgress = progress;
        });
        this.installProgress = null;
      } finally {
        this.installInFlight = null;
      }
    })();
    try {
      await this.installInFlight;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.installProgress = { phase: "error", percent: null, message };
      return action(false, "install-failed", message);
    }
    if (!this.detect().installed) {
      const message = "The beta install finished but the app was not found.";
      this.installProgress = { phase: "error", percent: null, message };
      return action(false, "install-failed", message);
    }
    return action(true);
  }

  private installDeps(): BetaInstallDeps {
    return {
      arch: process.arch,
      installDir: this.deps.installDirOverride ?? "/Applications",
      feedUrlOverride: this.deps.feedUrlOverride,
      expectedTeamId: this.deps.expectedTeamId ?? null,
    };
  }

  /**
   * Downloads and installs beta when needed, then opens it without importing.
   */
  async install(): Promise<DesktopBetaActionResult> {
    if (this.deps.flavor !== "production") {
      return action(false, "not-supported", "Beta handoff is only available from stable Synara.");
    }
    const installed = await this.ensureInstalled();
    if (!installed.ok) return installed;
    return this.launch();
  }

  /**
   * Downloads and installs beta when needed, writes the import marker into the
   * beta home, and launches the beta app. The beta server performs the data
   * import itself at startup, before opening its own database, so the stable
   * app never touches beta state directly. A supplied storage snapshot is
   * validated before anything is written, then fanned out to both
   * `<betaHome>/import-storage.json` (a debuggability sidecar) and beta's
   * Electron-profile snapshot file, which beta's existing storage-migration
   * read path consumes before its renderer stores hydrate.
   */
  async importAndLaunch(
    sourceHomeDir: string,
    input?: BetaImportAndLaunchInput,
  ): Promise<DesktopBetaActionResult> {
    if (this.deps.flavor !== "production") {
      return action(false, "not-supported", "Beta handoff is only available from stable Synara.");
    }
    const installed = await this.ensureInstalled();
    if (!installed.ok) return installed;
    const detection = this.detect();
    if (!detection.installed || !detection.executablePath) {
      return action(false, "not-installed", "Synara Beta is not installed yet.");
    }
    if (isBetaServerRunning(this.deps.betaHomeDir)) {
      return action(
        false,
        "beta-running",
        "Quit Synara Beta first so it can pick up the import on its next launch.",
      );
    }
    const suppliedSnapshot = input?.storageSnapshot;
    const validatedSnapshot = suppliedSnapshot
      ? validateSynaraStorageSnapshot(suppliedSnapshot)
      : null;
    if (suppliedSnapshot && !validatedSnapshot) {
      return action(
        false,
        "internal",
        "The browser settings snapshot was invalid, so nothing was handed off to Synara Beta.",
      );
    }
    const profileTarget = validatedSnapshot ? this.resolveBetaProfileSnapshotTarget() : null;
    try {
      writeBetaImportRequest({
        betaHomeDir: this.deps.betaHomeDir,
        sourceHomeDir,
      });
      if (validatedSnapshot) {
        writeBetaImportStorageSnapshot({
          betaHomeDir: this.deps.betaHomeDir,
          snapshot: validatedSnapshot,
        });
        if (profileTarget) {
          this.writeBetaProfileStorageSnapshot(profileTarget, validatedSnapshot);
        }
      }
      this.installProgress = { phase: "opening", percent: null };
      await launchBetaInstall(detection, this.deps.platform, this.launchEnv());
      this.installProgress = null;
      return action(true);
    } catch (error) {
      this.installProgress = null;
      // A marker without a launched beta would run the import on some later,
      // unrelated beta start; remove it and both snapshot sidecars so nothing
      // is consumed by surprise.
      this.removeHalfWrittenHandoff(profileTarget);
      return action(false, "internal", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Resolves where beta's Electron profile will read its storage-migration
   * snapshot: the injected dir in tests, `SYNARA_BETA_USER_DATA` when set, else
   * the beta identity's userData directory under the OS app-data base.
   */
  private resolveBetaProfileSnapshotTarget(): {
    readonly userDataDir: string;
    readonly snapshotPath: string;
  } {
    const env = this.deps.env ?? process.env;
    const betaUserDataOverride = this.deps.betaUserDataDir ?? env[SYNARA_BETA_USER_DATA_ENV];
    const betaUserDataDir = betaUserDataOverride
      ? betaUserDataOverride
      : resolveDesktopUserDataPath({
          appDataBase: resolveDesktopAppDataBase({
            platform: this.deps.platform,
            env,
            homeDir: this.deps.homeDir,
          }),
          userDataDirectoryName: synaraDesktopIdentity("beta").userDataDirectoryName,
        });
    return {
      userDataDir: betaUserDataDir,
      snapshotPath: resolveSynaraStorageSnapshotPath(betaUserDataDir),
    };
  }

  private writeBetaProfileStorageSnapshot(
    target: { readonly userDataDir: string; readonly snapshotPath: string },
    snapshot: SynaraStorageSnapshot,
  ): void {
    mkdirSync(target.userDataDir, { recursive: true });
    const profileTempPath = `${target.snapshotPath}.tmp-${process.pid}`;
    writeFileSync(profileTempPath, `${JSON.stringify(snapshot)}\n`, "utf8");
    renameSync(profileTempPath, target.snapshotPath);
  }

  /**
   * Removes every handoff artifact after a failure. A leftover marker or
   * sidecar would be consumed by an unrelated later beta start, so a cleanup
   * miss is logged but never hides the handoff error itself.
   */
  private removeHalfWrittenHandoff(profileTarget: { readonly snapshotPath: string } | null): void {
    const cleanupPaths = [
      join(this.deps.betaHomeDir, BETA_IMPORT_REQUEST_FILE_NAME),
      join(this.deps.betaHomeDir, BETA_IMPORT_STORAGE_FILE_NAME),
    ];
    if (profileTarget) {
      cleanupPaths.push(profileTarget.snapshotPath);
    }
    for (const cleanupPath of cleanupPaths) {
      try {
        rmSync(cleanupPath, { force: true });
      } catch (cleanupError) {
        console.warn(
          `[betaChannel] Failed to remove half-written beta handoff file ${cleanupPath}: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        );
      }
    }
  }
}

export const resolveBetaHomeDir = (
  homeDir: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string => env[SYNARA_BETA_HOME_ENV]?.trim() || join(homeDir, SYNARA_BETA_HOME_DIR_NAME);
