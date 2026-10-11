// FILE: os-jank.ts
// Purpose: Smooths over shell/path differences between packaged app launches and login shells.
// Exports: PATH hydration plus base-dir helpers used by server startup.

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

  // Startup blocks here: the server does not begin listening until the probe returns,
  // and `-ilc` sources the user's whole interactive rc (~1s). When the desktop shell
  // already ran it and handed us the resulting PATH, repeating it buys nothing and
  // doubles cold start. The marker — not merely a populated PATH — is what proves it.
  if (isShellEnvironmentHydrated(env)) return;

  const logWarning = options.logWarning ?? logPathHydrationWarning;

  try {
    // launchctl stays a last resort, never a fast path: `launchctl getenv PATH` is a
    // launchd-session value that something published once (often a login-item plist with a
    // hardcoded string), so it can be arbitrarily stale, while the login-shell probe is the
    // PATH the user actually has in their terminal. With the probe cached below, preferring
    // launchctl would trade a sub-millisecond file read for a wrong PATH — and a spawn.
    const readLaunchctlFallbackPath = (): string | undefined =>
      platform === "darwin" ? (options.readLaunchctlPath ?? readPathFromLaunchctl)() : undefined;

    // Cached by default: the probe result is persisted under the Synara home and reused
    // until the shell, the user, or any of its startup files changes.
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
