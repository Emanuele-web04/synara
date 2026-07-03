import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import { WANDY_APP_BUNDLE_NAME, WANDY_MACOS_APP_EXECUTABLE_PARTS } from "@t3tools/shared/wandy";

const WANDY_EXECUTABLE_RELATIVE_PATH = Path.join(...WANDY_MACOS_APP_EXECUTABLE_PARTS);
const WANDY_SOURCE_FINGERPRINT_FILE = ".wandy-source-fingerprint";

export type EnsureStableWandyHelperResult = {
  readonly status: "ready" | "fallback";
  readonly launcherPath: string | null;
  readonly sourceAppPath: string | null;
  readonly stableAppPath: string;
  readonly installed: boolean;
  readonly replaced: boolean;
  readonly reason?: string;
};

export type EnsureStableWandyHelperInput = {
  readonly bundledLauncherPath: string | null;
  readonly stableAppDir: string;
  readonly platform?: NodeJS.Platform;
  readonly terminateRunningHelper?: (appPath: string) => void;
};

export function resolveWandyAppBundlePathFromLauncher(launcherPath: string): string | null {
  const normalized = Path.resolve(launcherPath);
  const parts = normalized.split(Path.sep);

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.endsWith(".app")) {
      const appPath = parts.slice(0, index + 1).join(Path.sep);
      return appPath.length > 0 ? appPath : Path.sep;
    }
  }

  return null;
}

export function ensureStableWandyHelper(
  input: EnsureStableWandyHelperInput,
): EnsureStableWandyHelperResult {
  const stableAppPath = Path.join(input.stableAppDir, WANDY_APP_BUNDLE_NAME);
  const stableLauncherPath = Path.join(stableAppPath, WANDY_EXECUTABLE_RELATIVE_PATH);
  const platform = input.platform ?? process.platform;

  if (platform !== "darwin") {
    return {
      status: "fallback",
      launcherPath: input.bundledLauncherPath,
      sourceAppPath: null,
      stableAppPath,
      installed: false,
      replaced: false,
      reason: "Stable Wandy helper is only used on macOS.",
    };
  }

  if (!input.bundledLauncherPath) {
    return {
      status: "fallback",
      launcherPath: null,
      sourceAppPath: null,
      stableAppPath,
      installed: false,
      replaced: false,
      reason: "Bundled Wandy launcher was not found.",
    };
  }

  const sourceAppPath = resolveWandyAppBundlePathFromLauncher(input.bundledLauncherPath);
  if (!sourceAppPath || !FS.existsSync(Path.join(sourceAppPath, WANDY_EXECUTABLE_RELATIVE_PATH))) {
    return {
      status: "fallback",
      launcherPath: input.bundledLauncherPath,
      sourceAppPath,
      stableAppPath,
      installed: false,
      replaced: false,
      reason: "Bundled Wandy launcher is not inside a valid app bundle.",
    };
  }

  const normalizedSourceAppPath = Path.resolve(sourceAppPath);
  const normalizedStableAppPath = Path.resolve(stableAppPath);
  if (normalizedSourceAppPath === normalizedStableAppPath) {
    return {
      status: "ready",
      launcherPath: stableLauncherPath,
      sourceAppPath: normalizedSourceAppPath,
      stableAppPath: normalizedStableAppPath,
      installed: false,
      replaced: false,
    };
  }

  // A stale-helper glitch must never escalate beyond "fall back to the bundled
  // launcher": fingerprinting and installation both touch the filesystem and can
  // fail transiently (Gatekeeper scans, dangling symlinks, permission hiccups).
  let stableExists = false;
  try {
    const stableAppDir = Path.resolve(input.stableAppDir);
    const fingerprintPath = Path.join(stableAppDir, WANDY_SOURCE_FINGERPRINT_FILE);
    const sourceFingerprint = fingerprintDirectory(normalizedSourceAppPath);
    stableExists = FS.existsSync(normalizedStableAppPath);

    // The recorded fingerprint of the source bundle that produced the stable
    // copy is the staleness signal. Fingerprinting the copy itself would
    // compare timestamps through cpSync, which loses sub-millisecond
    // precision and would force a reinstall on every launch.
    const recordedFingerprint = stableExists ? readFingerprintRecord(fingerprintPath) : null;
    if (recordedFingerprint === sourceFingerprint && FS.existsSync(stableLauncherPath)) {
      ensureExecutable(stableLauncherPath);
      return {
        status: "ready",
        launcherPath: stableLauncherPath,
        sourceAppPath: normalizedSourceAppPath,
        stableAppPath: normalizedStableAppPath,
        installed: false,
        replaced: false,
      };
    }

    if (stableExists) {
      input.terminateRunningHelper?.(normalizedStableAppPath);
    }
    installStableAppBundle({
      sourceAppPath: normalizedSourceAppPath,
      stableAppPath: normalizedStableAppPath,
      stableAppDir,
    });
    ensureExecutable(stableLauncherPath);
    try {
      FS.writeFileSync(fingerprintPath, `${sourceFingerprint}\n`);
    } catch {
      // The install itself succeeded, so the fresh stable copy is usable now;
      // a missing manifest only costs a reinstall on the next launch.
    }
  } catch (error) {
    return {
      status: "fallback",
      launcherPath: input.bundledLauncherPath,
      sourceAppPath: normalizedSourceAppPath,
      stableAppPath: normalizedStableAppPath,
      installed: false,
      replaced: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    status: "ready",
    launcherPath: stableLauncherPath,
    sourceAppPath: normalizedSourceAppPath,
    stableAppPath: normalizedStableAppPath,
    installed: true,
    replaced: stableExists,
  };
}

export function terminateRunningStableWandyHelper(appPath: string): void {
  const executablePath = Path.join(appPath, WANDY_EXECUTABLE_RELATIVE_PATH);
  ChildProcess.spawnSync("pkill", ["-f", executablePath], { stdio: "ignore" });
}

export function collectRunningWandyProcessIds(
  psOutput: string,
  appPaths: readonly string[],
): number[] {
  const executablePaths = appPaths
    .map((appPath) => Path.join(Path.resolve(appPath), WANDY_EXECUTABLE_RELATIVE_PATH))
    .filter((executablePath, index, all) => all.indexOf(executablePath) === index);
  if (executablePaths.length === 0) {
    return [];
  }

  const processIds: number[] = [];
  for (const line of psOutput.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const command = match[2];
    if (!executablePaths.some((executablePath) => command.includes(executablePath))) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(pid) && pid > 0) {
      processIds.push(pid);
    }
  }

  return processIds;
}

// Scoped to this install's own app bundles so concurrent Synara instances
// (or a dev build next to a packaged build) never kill each other's helpers.
export function terminateRunningWandyProcesses(appPaths: readonly string[]): void {
  const ps = ChildProcess.spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const processIds = collectRunningWandyProcessIds(ps.stdout ?? "", appPaths);
  if (processIds.length === 0) {
    return;
  }

  ChildProcess.spawnSync("kill", ["-TERM", ...processIds.map(String)], { stdio: "ignore" });
}

function installStableAppBundle(input: {
  readonly sourceAppPath: string;
  readonly stableAppPath: string;
  readonly stableAppDir: string;
}): void {
  const temporaryAppPath = `${input.stableAppPath}.tmp-${process.pid}-${Date.now()}`;
  FS.rmSync(temporaryAppPath, { recursive: true, force: true });
  FS.mkdirSync(input.stableAppDir, { recursive: true });

  try {
    FS.cpSync(input.sourceAppPath, temporaryAppPath, {
      recursive: true,
      force: true,
      dereference: false,
      errorOnExist: false,
    });
    FS.rmSync(input.stableAppPath, { recursive: true, force: true });
    FS.renameSync(temporaryAppPath, input.stableAppPath);
  } catch (error) {
    FS.rmSync(temporaryAppPath, { recursive: true, force: true });
    throw error;
  }
}

function readFingerprintRecord(fingerprintPath: string): string | null {
  try {
    const value = FS.readFileSync(fingerprintPath, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function ensureExecutable(filePath: string): void {
  try {
    const mode = FS.statSync(filePath).mode;
    FS.chmodSync(filePath, mode | 0o755);
  } catch {
    // The caller will fail fast when it tries to launch the helper.
  }
}

// Metadata fingerprint (path + size + mtime + symlink target) of the source
// bundle. Content hashing re-read every byte on the Electron main thread at
// each launch; the source bundle is immutable per install, so metadata is a
// faithful staleness signal at the cost of a few lstat calls.
function fingerprintDirectory(rootPath: string): string {
  const hash = Crypto.createHash("sha256");
  for (const filePath of listFiles(rootPath)) {
    const relativePath = Path.relative(rootPath, filePath);
    const stats = FS.lstatSync(filePath);
    hash.update(relativePath);
    hash.update("\0");

    if (stats.isSymbolicLink()) {
      hash.update("symlink");
      hash.update("\0");
      hash.update(FS.readlinkSync(filePath));
    } else {
      hash.update("file");
      hash.update("\0");
      hash.update(String(stats.size));
      hash.update("\0");
      hash.update(String(stats.mtimeMs));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listFiles(rootPath: string): string[] {
  const files: string[] = [];

  function visit(directoryPath: string): void {
    const entries = FS.readdirSync(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = Path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(entryPath);
      }
    }
  }

  visit(rootPath);
  return files.toSorted((left, right) => left.localeCompare(right));
}
