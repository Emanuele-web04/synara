import {
  isPathName,
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLaunchctl,
  readWindowsPersistentEnvironment,
  type ShellEnvironmentReader,
  type WindowsEnvironmentReader,
} from "@synara/shared/shell";
import {
  createCachedLoginShellEnvironmentReader,
  LOGIN_SHELL_ENVIRONMENT_NAMES,
} from "@synara/shared/loginShellEnvironment";

function logShellEnvironmentWarning(message: string, error?: unknown): void {
  console.warn(`[desktop] ${message}`, error instanceof Error ? error.message : (error ?? ""));
}

// pathHydrated is true only when PATH came from the user's real environment — merging the inherited PATH with nothing doesn't count; children use this flag to decide whether to skip their own probe, so a failed probe must let them run theirs
export interface ShellEnvironmentSyncResult {
  readonly pathHydrated: boolean;
}

// Windows GUI processes inherit a possibly-stale env block instead of a login shell — hydrate PATH and missing vars from the persisted registry env so CLI providers resolve the user's real config
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

  // cached by default — the probe is the most expensive thing on the pre-whenReady path and its answer only changes when the shell, user, or startup files do
  const readEnvironment =
    options.readEnvironment ?? createCachedLoginShellEnvironmentReader({ env, platform });
  const shellEnvironment: Partial<Record<string, string>> = {};

  try {
    for (const shell of listLoginShellCandidates(platform, env.SHELL, options.userShell)) {
      try {
        Object.assign(shellEnvironment, readEnvironment(shell, LOGIN_SHELL_ENVIRONMENT_NAMES));
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
