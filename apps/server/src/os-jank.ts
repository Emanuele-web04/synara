import { Effect } from "effect";
import {
  isShellEnvironmentHydrated,
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLaunchctl,
  readPathFromLoginShell,
} from "@synara/shared/shell";
import { createCachedLoginShellPathReader } from "@synara/shared/loginShellEnvironment";
import {
  expandHomePath as expandHomePathSync,
  resolveSynaraHomeDirectory,
} from "@synara/shared/synaraHome";

function logPathHydrationWarning(message: string, error?: unknown): void {
  console.warn(`[server] ${message}`, error instanceof Error ? error.message : (error ?? ""));
}

export function fixPath(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    readPath?: typeof readPathFromLoginShell;
    readLaunchctlPath?: typeof readPathFromLaunchctl;
    userShell?: string;
    logWarning?: (message: string, error?: unknown) => void;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return;

  const env = options.env ?? process.env;

  // startup blocks here and `-ilc` sources the whole interactive rc (~1s) — when the desktop shell already ran it and handed over the PATH, repeating doubles cold start; the marker, not merely a populated PATH, is what proves it
  if (isShellEnvironmentHydrated(env)) return;

  const logWarning = options.logWarning ?? logPathHydrationWarning;

  try {
    // launchctl is a last resort never a fast path — its value can be arbitrarily stale while the login-shell probe is the PATH the user actually has; preferring launchctl trades a sub-ms file read for a wrong PATH and a spawn
    const readLaunchctlFallbackPath = (): string | undefined =>
      platform === "darwin" ? (options.readLaunchctlPath ?? readPathFromLaunchctl)() : undefined;

    // cached by default — persisted under the Synara home and reused until the shell, user, or startup files change
    const readPath = options.readPath ?? createCachedLoginShellPathReader({ env, platform });

    let shellPath: string | undefined;
    for (const shell of listLoginShellCandidates(platform, env.SHELL, options.userShell)) {
      try {
        shellPath = readPath(shell);
      } catch (error) {
        logWarning(`Failed to read PATH from login shell ${shell}.`, error);
      }

      if (shellPath) {
        break;
      }
    }

    const mergedPath = mergePathEntries(
      shellPath || readLaunchctlFallbackPath(),
      env.PATH,
      platform,
    );
    if (mergedPath) {
      env.PATH = mergedPath;
    }
  } catch (error) {
    logWarning("Failed to hydrate PATH from the user environment.", error);
  }
}

export const expandHomePath = (input: string): Effect.Effect<string> =>
  Effect.succeed(expandHomePathSync(input));

export const resolveBaseDir = (raw: string | undefined): Effect.Effect<string> =>
  Effect.succeed(resolveSynaraHomeDirectory({ configuredHome: raw }));
