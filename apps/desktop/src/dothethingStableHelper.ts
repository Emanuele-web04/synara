import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

const DOTHETHING_APP_BUNDLE_NAME = "Do The Thing.app";
const DOTHETHING_EXECUTABLE_RELATIVE_PATH = Path.join("Contents", "MacOS", "DoTheThing");

export type EnsureStableDoTheThingHelperResult = {
  readonly status: "ready" | "fallback";
  readonly launcherPath: string | null;
  readonly sourceAppPath: string | null;
  readonly stableAppPath: string;
  readonly installed: boolean;
  readonly replaced: boolean;
  readonly reason?: string;
};

export type EnsureStableDoTheThingHelperInput = {
  readonly bundledLauncherPath: string | null;
  readonly stableAppDir: string;
  readonly platform?: NodeJS.Platform;
  readonly terminateRunningHelper?: (appPath: string) => void;
};

export function resolveDoTheThingAppBundlePathFromLauncher(launcherPath: string): string | null {
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

export function ensureStableDoTheThingHelper(
  input: EnsureStableDoTheThingHelperInput,
): EnsureStableDoTheThingHelperResult {
  const stableAppPath = Path.join(input.stableAppDir, DOTHETHING_APP_BUNDLE_NAME);
  const stableLauncherPath = Path.join(stableAppPath, DOTHETHING_EXECUTABLE_RELATIVE_PATH);
  const platform = input.platform ?? process.platform;

  if (platform !== "darwin") {
    return {
      status: "fallback",
      launcherPath: input.bundledLauncherPath,
      sourceAppPath: null,
      stableAppPath,
      installed: false,
      replaced: false,
      reason: "Stable Do The Thing helper is only used on macOS.",
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
      reason: "Bundled Do The Thing launcher was not found.",
    };
  }

  const sourceAppPath = resolveDoTheThingAppBundlePathFromLauncher(input.bundledLauncherPath);
  if (
    !sourceAppPath ||
    !FS.existsSync(Path.join(sourceAppPath, DOTHETHING_EXECUTABLE_RELATIVE_PATH))
  ) {
    return {
      status: "fallback",
      launcherPath: input.bundledLauncherPath,
      sourceAppPath,
      stableAppPath,
      installed: false,
      replaced: false,
      reason: "Bundled Do The Thing launcher is not inside a valid app bundle.",
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

  const sourceFingerprint = fingerprintDirectory(normalizedSourceAppPath);
  const stableExists = FS.existsSync(normalizedStableAppPath);
  const stableFingerprint = stableExists ? fingerprintDirectory(normalizedStableAppPath) : null;
  const needsInstall = sourceFingerprint !== stableFingerprint;

  if (!needsInstall) {
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

  try {
    if (stableExists) {
      input.terminateRunningHelper?.(normalizedStableAppPath);
    }
    installStableAppBundle({
      sourceAppPath: normalizedSourceAppPath,
      stableAppPath: normalizedStableAppPath,
      stableAppDir: Path.resolve(input.stableAppDir),
    });
    ensureExecutable(stableLauncherPath);
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

export function terminateRunningStableDoTheThingHelper(appPath: string): void {
  const executablePath = Path.join(appPath, DOTHETHING_EXECUTABLE_RELATIVE_PATH);
  ChildProcess.spawnSync("pkill", ["-f", executablePath], { stdio: "ignore" });
}

export function collectRunningDoTheThingProcessIds(psOutput: string): number[] {
  const processIds: number[] = [];
  const executableSuffix = `${Path.sep}${DOTHETHING_APP_BUNDLE_NAME}${Path.sep}${DOTHETHING_EXECUTABLE_RELATIVE_PATH}`;

  for (const line of psOutput.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match?.[1] || !match[2]?.includes(executableSuffix)) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(pid) && pid > 0) {
      processIds.push(pid);
    }
  }

  return processIds;
}

export function terminateRunningDoTheThingProcesses(): void {
  const ps = ChildProcess.spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const processIds = collectRunningDoTheThingProcessIds(ps.stdout ?? "");
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

function ensureExecutable(filePath: string): void {
  try {
    const mode = FS.statSync(filePath).mode;
    FS.chmodSync(filePath, mode | 0o755);
  } catch {
    // The caller will fail fast when it tries to launch the helper.
  }
}

function fingerprintDirectory(rootPath: string): string {
  const hash = Crypto.createHash("sha256");
  for (const filePath of listFiles(rootPath)) {
    const relativePath = Path.relative(rootPath, filePath);
    const stats = FS.lstatSync(filePath);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(stats.mode));
    hash.update("\0");

    if (stats.isSymbolicLink()) {
      hash.update("symlink");
      hash.update("\0");
      hash.update(FS.readlinkSync(filePath));
    } else {
      hash.update("file");
      hash.update("\0");
      hash.update(FS.readFileSync(filePath));
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
