// FILE: loginShellEnvironment.ts
// Purpose: Caches the login-shell environment probe on disk so cold starts stop paying
// ~1s to source the user's interactive rc on every launch.
// Exports: canonical probe names plus cached reader factories used by the server and desktop.

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { readEnvironmentFromLoginShell, type ShellEnvironmentReader } from "./shell";
import { resolveSynaraHomeDirectory } from "./synaraHome";

/**
 * The variables every probe captures, regardless of what the caller asked for.
 *
 * One canonical set is what lets the backend (which only needs PATH) and the desktop
 * shell (which also needs the agent socket and Homebrew/XDG roots) share a single cache
 * entry: whoever probes first pays for all of them, and the other reads the file.
 */
export const LOGIN_SHELL_ENVIRONMENT_NAMES = [
  "PATH",
  "SSH_AUTH_SOCK",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

export const LOGIN_SHELL_ENVIRONMENT_CACHE_FILE_NAME = "login-shell-environment.json";

/**
 * Bumped whenever the cached shape or the probe's meaning changes; a mismatch is treated
 * as a miss rather than a parse error, so an upgrade can never resurrect a stale PATH.
 */
const CACHE_VERSION = 1;

/**
 * Ceiling on how long a valid entry may be reused.
 *
 * The fingerprint below only sees the rc files a shell reads *directly* at their default
 * locations. Anything sourced in turn (oh-my-zsh plugins, `/etc/profile.d/*`, `conf.d`
 * fragments) or relocated by the shell's own configuration (`ZDOTDIR`, `XDG_CONFIG_HOME`)
 * can change PATH without invalidating the key — those are deliberately not read from this
 * process's env, which a GUI launch and a terminal launch disagree about, and would
 * therefore thrash the shared entry. One slow start per week is a cheap upper bound on how
 * long a genuinely stale PATH can survive.
 */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export function loginShellEnvironmentCachePath(
  options: { readonly env?: NodeJS.ProcessEnv; readonly homeDirectory?: string } = {},
): string {
  return Path.join(
    resolveSynaraHomeDirectory(options),
    "cache",
    LOGIN_SHELL_ENVIRONMENT_CACHE_FILE_NAME,
  );
}

interface StartupFileFingerprint {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}

interface LoginShellEnvironmentCacheKey {
  readonly version: number;
  readonly platform: NodeJS.Platform;
  readonly shell: string;
  readonly uid: number | null;
  readonly homeDirectory: string;
  readonly startupFiles: ReadonlyArray<StartupFileFingerprint>;
}

interface LoginShellEnvironmentCacheEntry {
  readonly key: LoginShellEnvironmentCacheKey;
  readonly capturedAtMs: number;
  readonly names: ReadonlyArray<string>;
  readonly environment: Record<string, string>;
}

/**
 * Startup files that can change PATH for a given shell.
 *
 * Only files that exist are fingerprinted, and the resulting list is part of the cache
 * key — so a file appearing or disappearing invalidates the entry just like an edit does.
 */
function listShellStartupFiles(shell: string, homeDirectory: string): ReadonlyArray<string> {
  const home = (...segments: ReadonlyArray<string>): string =>
    Path.join(homeDirectory, ...segments);
  const shellName = Path.basename(shell);

  if (shellName === "zsh") {
    return [
      // macOS/Arch put the system files directly in /etc; Debian, Ubuntu and Fedora build
      // zsh with `--enable-etcdir=/etc/zsh`, so both layouts have to be tracked.
      "/etc/zshenv",
      "/etc/zprofile",
      "/etc/zshrc",
      "/etc/zlogin",
      "/etc/zsh/zshenv",
      "/etc/zsh/zprofile",
      "/etc/zsh/zshrc",
      "/etc/zsh/zlogin",
      home(".zshenv"),
      home(".zprofile"),
      home(".zshrc"),
      home(".zlogin"),
    ];
  }
  if (shellName === "bash" || shellName === "sh") {
    return [
      "/etc/profile",
      "/etc/bashrc",
      "/etc/bash.bashrc",
      home(".bash_profile"),
      home(".bash_login"),
      home(".bashrc"),
      home(".profile"),
    ];
  }
  if (shellName === "fish") {
    return ["/etc/fish/config.fish", home(".config", "fish", "config.fish")];
  }
  // An unrecognized shell still reads the POSIX profiles often enough to be worth
  // tracking; the age ceiling covers whatever else it sources.
  return ["/etc/profile", home(".profile")];
}

function fingerprintFile(filePath: string): StartupFileFingerprint | null {
  try {
    const stat = FS.statSync(filePath);
    if (!stat.isFile()) return null;
    return { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/**
 * `OS.homedir()` throws when the process has neither `HOME` nor a passwd entry to fall back
 * on (containers, sandboxed CI, some service accounts). The desktop builds this reader on
 * the pre-`whenReady()` path outside any try block, so a throw here would take down boot:
 * a home we cannot resolve just means running uncached.
 */
function readHomeDirectory(): string | null {
  try {
    const home = OS.homedir();
    return typeof home === "string" && home.length > 0 ? home : null;
  } catch {
    return null;
  }
}

function readUid(): number | null {
  try {
    const { uid } = OS.userInfo();
    return typeof uid === "number" && uid >= 0 ? uid : null;
  } catch {
    return null;
  }
}

function computeCacheKey(input: {
  readonly platform: NodeJS.Platform;
  readonly shell: string;
  readonly homeDirectory: string;
}): LoginShellEnvironmentCacheKey {
  // The interpreter itself is fingerprinted alongside its rc files: a shell upgrade can
  // change the defaults the rc files build on without touching any of them.
  const startupFiles = [input.shell, ...listShellStartupFiles(input.shell, input.homeDirectory)]
    .map(fingerprintFile)
    .filter((fingerprint): fingerprint is StartupFileFingerprint => fingerprint !== null);

  return {
    version: CACHE_VERSION,
    platform: input.platform,
    shell: input.shell,
    uid: readUid(),
    homeDirectory: input.homeDirectory,
    startupFiles,
  };
}

function cacheKeysMatch(
  left: LoginShellEnvironmentCacheKey,
  right: LoginShellEnvironmentCacheKey,
): boolean {
  if (
    left.version !== right.version ||
    left.platform !== right.platform ||
    left.shell !== right.shell ||
    left.uid !== right.uid ||
    left.homeDirectory !== right.homeDirectory ||
    left.startupFiles.length !== right.startupFiles.length
  ) {
    return false;
  }
  return left.startupFiles.every((file, index) => {
    const other = right.startupFiles[index];
    return (
      other !== undefined &&
      file.path === other.path &&
      file.mtimeMs === other.mtimeMs &&
      file.size === other.size
    );
  });
}

function parseCacheEntry(text: string): LoginShellEnvironmentCacheEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const candidate = parsed as Partial<LoginShellEnvironmentCacheEntry>;
  const key = candidate.key;
  if (
    typeof key !== "object" ||
    key === null ||
    typeof key.version !== "number" ||
    typeof key.shell !== "string" ||
    typeof key.homeDirectory !== "string" ||
    !Array.isArray(key.startupFiles) ||
    typeof candidate.capturedAtMs !== "number" ||
    !Array.isArray(candidate.names) ||
    typeof candidate.environment !== "object" ||
    candidate.environment === null
  ) {
    return null;
  }
  if (
    !key.startupFiles.every(
      (file: unknown): file is StartupFileFingerprint =>
        typeof file === "object" &&
        file !== null &&
        typeof (file as StartupFileFingerprint).path === "string" &&
        typeof (file as StartupFileFingerprint).mtimeMs === "number" &&
        typeof (file as StartupFileFingerprint).size === "number",
    )
  ) {
    return null;
  }
  if (!candidate.names.every((name: unknown): name is string => typeof name === "string")) {
    return null;
  }

  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(candidate.environment)) {
    if (typeof value === "string") {
      environment[name] = value;
    }
  }

  return {
    key: key as LoginShellEnvironmentCacheKey,
    capturedAtMs: candidate.capturedAtMs,
    names: candidate.names,
    environment,
  };
}

function readCacheEntry(cachePath: string): LoginShellEnvironmentCacheEntry | null {
  // Any failure here — missing file, truncated write, unreadable permissions, garbage
  // JSON — must degrade to "probe again". Startup can never fail because of a cache.
  try {
    return parseCacheEntry(FS.readFileSync(cachePath, "utf8"));
  } catch {
    return null;
  }
}

function writeCacheEntry(cachePath: string, entry: LoginShellEnvironmentCacheEntry): void {
  try {
    const directory = Path.dirname(cachePath);
    FS.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Rename into place so a concurrent reader never observes a half-written entry.
    const temporaryPath = `${cachePath}.${process.pid}.partial`;
    try {
      FS.writeFileSync(temporaryPath, `${JSON.stringify(entry)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      FS.renameSync(temporaryPath, cachePath);
    } catch (cause) {
      try {
        FS.unlinkSync(temporaryPath);
      } catch {
        // The partial may never have been created; nothing to reclaim.
      }
      throw cause;
    }
  } catch {
    // A cache we cannot persist only costs the next start a probe.
  }
}

function unionNames(
  base: ReadonlyArray<string>,
  extra: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const names = [...base];
  for (const name of extra) {
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

function pickNames(
  environment: Partial<Record<string, string>>,
  names: ReadonlyArray<string>,
): Partial<Record<string, string>> {
  const picked: Partial<Record<string, string>> = {};
  for (const name of names) {
    const value = environment[name];
    if (value !== undefined) {
      picked[name] = value;
    }
  }
  return picked;
}

function currentSshAuthSocket(env: NodeJS.ProcessEnv): string | undefined {
  const socketPath = env.SSH_AUTH_SOCK?.trim();
  return socketPath ? socketPath : undefined;
}

/**
 * SSH agent sockets are session-scoped rather than shell-configuration-scoped.
 *
 * Prefer a socket inherited by the current process over the cached value. If no
 * current value exists, a cached path is reusable only while it still exists;
 * otherwise the login-shell probe must run again to discover the new session's
 * socket. An absent cached value remains a valid result so users without an SSH
 * agent do not pay the login-shell cost on every launch.
 */
function pickReusableCachedNames(
  entry: LoginShellEnvironmentCacheEntry,
  names: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Partial<Record<string, string>> | null {
  const picked = pickNames(entry.environment, names);
  if (!names.includes("SSH_AUTH_SOCK")) {
    return picked;
  }

  const currentSocket = currentSshAuthSocket(env);
  if (currentSocket !== undefined) {
    picked.SSH_AUTH_SOCK = currentSocket;
    return picked;
  }

  const cachedSocket = picked.SSH_AUTH_SOCK;
  if (cachedSocket !== undefined && !FS.existsSync(cachedSocket)) {
    return null;
  }
  return picked;
}

export interface CachedLoginShellEnvironmentOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  /** Explicit cache file; `null` disables persistence entirely (used by tests). */
  readonly cachePath?: string | null;
  readonly probe?: ShellEnvironmentReader;
  readonly now?: () => number;
}

/**
 * Wraps the login-shell probe with an on-disk cache.
 *
 * The returned reader has the same contract as {@link readEnvironmentFromLoginShell}, so
 * it drops straight into the existing candidate-shell loops. On a hit nothing is spawned;
 * on a miss the probe runs exactly as before (same 5s timeout, same error propagation) and
 * its result is persisted. Only a probe that actually produced a PATH is cached — a shell
 * that answered with nothing is a failure to retry, not a result to remember.
 */
export function createCachedLoginShellEnvironmentReader(
  options: CachedLoginShellEnvironmentOptions = {},
): ShellEnvironmentReader {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? readHomeDirectory();
  const probe = options.probe ?? readEnvironmentFromLoginShell;
  const now = options.now ?? Date.now;
  const cachePath =
    options.cachePath === undefined
      ? homeDirectory === null
        ? null
        : loginShellEnvironmentCachePath({ env, homeDirectory })
      : options.cachePath;

  return (shell, names, execFile) => {
    const probeNames = unionNames(LOGIN_SHELL_ENVIRONMENT_NAMES, names);
    // Without a cache there is nothing to key, so the fingerprint's file stats are skipped too.
    const key =
      cachePath === null || homeDirectory === null
        ? null
        : computeCacheKey({ platform, shell, homeDirectory });

    if (cachePath !== null && key !== null) {
      const entry = readCacheEntry(cachePath);
      if (
        entry !== null &&
        cacheKeysMatch(entry.key, key) &&
        now() - entry.capturedAtMs < CACHE_MAX_AGE_MS &&
        names.every((name) => entry.names.includes(name))
      ) {
        const cachedEnvironment = pickReusableCachedNames(entry, names, env);
        if (cachedEnvironment !== null) {
          return cachedEnvironment;
        }
      }
    }

    const environment = probe(shell, probeNames, execFile);

    if (cachePath !== null && key !== null && environment.PATH !== undefined) {
      const captured: Record<string, string> = {};
      for (const [name, value] of Object.entries(environment)) {
        if (value !== undefined) {
          captured[name] = value;
        }
      }
      writeCacheEntry(cachePath, {
        key,
        capturedAtMs: now(),
        names: probeNames,
        environment: captured,
      });
    }

    return pickNames(environment, names);
  };
}

/**
 * PATH-only view of {@link createCachedLoginShellEnvironmentReader}, shaped like
 * `readPathFromLoginShell` for callers that hydrate nothing else. It still probes and
 * caches the full canonical set, so the desktop shell can reuse whatever the backend
 * captured and vice versa.
 */
export function createCachedLoginShellPathReader(
  options: CachedLoginShellEnvironmentOptions = {},
): (shell: string, execFile?: Parameters<ShellEnvironmentReader>[2]) => string | undefined {
  const read = createCachedLoginShellEnvironmentReader(options);
  return (shell, execFile) => read(shell, ["PATH"], execFile).PATH;
}
