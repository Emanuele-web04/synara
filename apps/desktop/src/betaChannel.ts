// FILE: betaChannel.ts
// Purpose: Stable-side probe + handoff into a parallel Synara Beta install.
// Layer: Desktop platform adapter (no Electron imports; every path is injectable for tests).
//
// Flow: stable writes `<betaHome>/import-requested.json` and launches the beta
// app; the beta server consumes the marker at startup (see
// `apps/server/src/betaImport.ts`) and reports back through
// `<betaHome>/import-result.json`, which this module reads for the UI.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import {
  BETA_IMPORT_REQUEST_FILE_NAME,
  BETA_IMPORT_RESULT_FILE_NAME,
  SYNARA_BETA_HOME_DIR_NAME,
  SYNARA_BETA_RELEASES_URL,
  SYNARA_BETA_WINDOWS_INSTALLER_GUID,
  type BetaImportResult,
} from "@synara/shared/betaChannel";
import type {
  DesktopBetaActionError,
  DesktopBetaActionResult,
  DesktopBetaChannelState,
} from "@synara/contracts";

// electron-builder registers the uninstall key under the raw NSIS guid (no
// braces); the value itself lives in @synara/shared/betaChannel.
export const BETA_WINDOWS_UNINSTALL_GUID = SYNARA_BETA_WINDOWS_INSTALLER_GUID;
const BETA_MAC_APP_NAME = "Synara Beta.app";
const BETA_WINDOWS_EXE_NAME = "Synara Beta.exe";
const BETA_LINUX_DESKTOP_FILE = "synara-beta.desktop";

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
): BetaInstallDetection {
  const missing: BetaInstallDetection = {
    installed: false,
    installPath: null,
    executablePath: null,
    version: null,
  };
  if (platform === "darwin") {
    for (const appPath of [
      `/Applications/${BETA_MAC_APP_NAME}`,
      join(homeDir, "Applications", BETA_MAC_APP_NAME),
    ]) {
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

export function launchBetaInstall(
  detection: BetaInstallDetection,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!detection.installed || !detection.executablePath) {
    throw new Error("Synara Beta is not installed");
  }
  if (platform === "darwin") {
    // `open` re-activates an already-running instance instead of failing.
    spawn("open", ["-a", detection.installPath!], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }
  spawn(detection.executablePath, [], { detached: true, stdio: "ignore" }).unref();
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
  constructor(private readonly deps: BetaChannelDeps) {}

  getState(): DesktopBetaChannelState {
    const detection = detectBetaInstall(this.deps.platform, this.deps.homeDir);
    const running = isBetaServerRunning(this.deps.betaHomeDir);
    const result = readBetaImportResult(this.deps.betaHomeDir);
    return {
      supported: true,
      flavor: this.deps.flavor,
      installed: detection.installed,
      version: detection.version,
      running,
      lastImportAt: result && result.ok ? result.completedAt : null,
      lastImportError: result && !result.ok ? (result.error ?? "import failed") : null,
      downloadUrl: SYNARA_BETA_RELEASES_URL,
    };
  }

  /** Launch beta as-is; refuses only when the install is missing. */
  launch(): DesktopBetaActionResult {
    if (this.deps.flavor !== "production") {
      return action(false, "not-supported", "Beta handoff is only available from stable Synara.");
    }
    const detection = detectBetaInstall(this.deps.platform, this.deps.homeDir);
    if (!detection.installed || !detection.executablePath) {
      return action(false, "not-installed", "Synara Beta is not installed yet.");
    }
    try {
      launchBetaInstall(detection, this.deps.platform);
      return action(true);
    } catch (error) {
      return action(false, "launch-failed", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Writes the import marker into the beta home and launches the beta app.
   * The beta server performs the snapshot itself at startup, before opening its
   * own database, so the stable app never touches beta state directly.
   */
  importAndLaunch(sourceHomeDir: string): DesktopBetaActionResult {
    if (this.deps.flavor !== "production") {
      return action(false, "not-supported", "Beta handoff is only available from stable Synara.");
    }
    const detection = detectBetaInstall(this.deps.platform, this.deps.homeDir);
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
    try {
      writeBetaImportRequest({
        betaHomeDir: this.deps.betaHomeDir,
        sourceHomeDir,
      });
      launchBetaInstall(detection, this.deps.platform);
      return action(true);
    } catch (error) {
      // A marker without a launched beta would run the import on some later,
      // unrelated beta start; remove it so nothing consumes it by surprise.
      try {
        rmSync(join(this.deps.betaHomeDir, BETA_IMPORT_REQUEST_FILE_NAME), {
          recursive: true,
          force: true,
        });
      } catch {
        // best effort
      }
      return action(false, "internal", error instanceof Error ? error.message : String(error));
    }
  }
}

export const resolveBetaHomeDir = (homeDir: string = homedir()): string =>
  join(homeDir, SYNARA_BETA_HOME_DIR_NAME);
