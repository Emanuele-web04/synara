// FILE: syncShellEnvironment.ts
// Purpose: Hydrates Electron's inherited env with values from the user's login shell.
// Exports: syncShellEnvironment for desktop startup.

import {
  isPathName,
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLaunchctl,
  readEnvironmentFromLoginShell,
  readWindowsPersistentEnvironment,
  type ShellEnvironmentReader,
  type WindowsEnvironmentReader,
} from "@synara/shared/shell";

const LOGIN_SHELL_ENV_NAMES = [
  "PATH",
  "SSH_AUTH_SOCK",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

function logShellEnvironmentWarning(message: string, error?: unknown): void {
  console.warn(`[desktop] ${message}`, error instanceof Error ? error.message : (error ?? ""));
}

// Windows GUI processes inherit a (possibly stale) environment block instead of a login
// shell. Hydrate PATH and any missing variables from the persisted registry environment so
// CLI providers resolve the same config the user's terminal sees (e.g. CLAUDE_CONFIG_DIR).
function syncWindowsEnvironment(
  env: NodeJS.ProcessEnv,
  readWindowsEnvironment: WindowsEnvironmentReader,
  logWarning: (message: string, error?: unknown) => void,
): void {
  try {
    const persisted = readWindowsEnvironment();

    const mergedPath = mergePathEntries(persisted.PATH, env.PATH, "win32");
    if (mergedPath) {
      env.PATH = mergedPath;
    }

    for (const [name, value] of Object.entries(persisted)) {
      if (isPathName(name)) continue;
      if (value && env[name] === undefined) {
        env[name] = value;
      }
    }
  } catch (error) {
    logWarning("Failed to synchronize the desktop Windows environment.", error);
  }
}

export function syncShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    readEnvironment?: ShellEnvironmentReader;
    readLaunchctlPath?: typeof readPathFromLaunchctl;
    readWindowsEnvironment?: WindowsEnvironmentReader;
    userShell?: string;
    logWarning?: (message: string, error?: unknown) => void;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  const logWarning = options.logWarning ?? logShellEnvironmentWarning;

  if (platform === "win32") {
    syncWindowsEnvironment(
      env,
      options.readWindowsEnvironment ?? readWindowsPersistentEnvironment,
      logWarning,
    );
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  const readEnvironment = options.readEnvironment ?? readEnvironmentFromLoginShell;
  const shellEnvironment: Partial<Record<string, string>> = {};

  try {
    for (const shell of listLoginShellCandidates(platform, env.SHELL, options.userShell)) {
      try {
        Object.assign(shellEnvironment, readEnvironment(shell, LOGIN_SHELL_ENV_NAMES));
        if (shellEnvironment.PATH) {
          break;
        }
      } catch (error) {
        logWarning(`Failed to read login shell environment from ${shell}.`, error);
      }
    }

    const launchctlPath =
      platform === "darwin" && !shellEnvironment.PATH
        ? (options.readLaunchctlPath ?? readPathFromLaunchctl)()
        : undefined;
    const mergedPath = mergePathEntries(shellEnvironment.PATH ?? launchctlPath, env.PATH, platform);
    if (mergedPath) {
      env.PATH = mergedPath;
    }

    if (!env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }

    for (const name of [
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ] as const) {
      if (!env[name] && shellEnvironment[name]) {
        env[name] = shellEnvironment[name];
      }
    }
  } catch (error) {
    logWarning("Failed to synchronize the desktop shell environment.", error);
  }
}
