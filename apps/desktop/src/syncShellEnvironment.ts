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

/**
 * Outcome of a hydration pass.
 *
 * `pathHydrated` is true only when PATH came from the user's real environment (login
 * shell, launchctl, or the Windows registry). Merging the inherited PATH with nothing
 * does not count: child processes use this flag to decide whether they may skip their
 * own probe, so a failed probe here must let them run theirs.
 */
export interface ShellEnvironmentSyncResult {
  readonly pathHydrated: boolean;
}

// Windows GUI processes inherit a (possibly stale) environment block instead of a login
// shell. Hydrate PATH and any missing variables from the persisted registry environment so
// CLI providers resolve the same config the user's terminal sees (e.g. CLAUDE_CONFIG_DIR).
function syncWindowsEnvironment(
  env: NodeJS.ProcessEnv,
  readWindowsEnvironment: WindowsEnvironmentReader,
  logWarning: (message: string, error?: unknown) => void,
): ShellEnvironmentSyncResult {
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

    return { pathHydrated: Boolean(persisted.PATH) };
  } catch (error) {
    logWarning("Failed to synchronize the desktop Windows environment.", error);
    return { pathHydrated: false };
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
): ShellEnvironmentSyncResult {
  const platform = options.platform ?? process.platform;
  const logWarning = options.logWarning ?? logShellEnvironmentWarning;

  if (platform === "win32") {
    return syncWindowsEnvironment(
      env,
      options.readWindowsEnvironment ?? readWindowsPersistentEnvironment,
      logWarning,
    );
  }

  if (platform !== "darwin" && platform !== "linux") return { pathHydrated: false };

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
    const resolvedPath = shellEnvironment.PATH ?? launchctlPath;
    const mergedPath = mergePathEntries(resolvedPath, env.PATH, platform);
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

    return { pathHydrated: Boolean(resolvedPath) };
  } catch (error) {
    logWarning("Failed to synchronize the desktop shell environment.", error);
    return { pathHydrated: false };
  }
}
