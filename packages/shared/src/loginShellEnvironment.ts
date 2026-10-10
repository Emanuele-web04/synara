import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { readEnvironmentFromLoginShell, type ShellEnvironmentReader } from "./shell";
import { resolveSynaraHomeDirectory } from "./synaraHome";

/** one canonical set lets the backend (PATH only) and the desktop shell (socket + Homebrew/XDG roots) share a cache entry — whoever probes first pays for all */
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

/** a mismatch is a miss, not a parse error — an upgrade can never resurrect a stale PATH */
const CACHE_VERSION = 1;

/** the fingerprint only sees rc files read directly at default locations — transitively sourced files can change PATH without invalidating the key; one slow start per week bounds the staleness */
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

/** only existing files are fingerprinted and the list is part of the key — a file appearing/disappearing invalidates the entry like an edit */
function listShellStartupFiles(shell: string, homeDirectory: string): ReadonlyArray<string> {
  const home = (...segments: ReadonlyArray<string>): string =>
    Path.join(homeDirectory, ...segments);
  const shellName = Path.basename(shell);

  if (shellName === "zsh") {
    return [
      // Debian/Ubuntu/Fedora build zsh with --enable-etcdir=/etc/zsh — both layouts tracked
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
  // an unrecognized shell still reads the POSIX profiles often enough to track; the age ceiling covers the rest
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

/** OS.homedir() throws with neither HOME nor a passwd entry (containers, sandboxed CI) — the desktop builds this reader pre-whenReady outside any try, so unresolvable home = uncached, never throw */
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
  // the interpreter is fingerprinted too — a shell upgrade can change defaults without touching rc files
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
  // any failure here must degrade to "probe again" — startup can never fail because of a cache
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
    // rename into place so a concurrent reader never observes a half-written entry
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
        // the partial may never have been created — nothing to reclaim
      }
      throw cause;
    }
  } catch {
    // a cache we can't persist only costs the next start a probe
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

/** session-scoped, not shell-config-scoped: prefer the inherited socket; a cached path is reusable only while it exists; an absent cached value is valid so users without an agent skip the probe */
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
  /** null disables persistence entirely (tests) */
  readonly cachePath?: string | null;
  readonly probe?: ShellEnvironmentReader;
  readonly now?: () => number;
}

/** only a probe that produced a PATH is cached — an empty answer is a failure to retry, not a result */
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
    // without a cache there's nothing to key — skip the fingerprint stats too
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

/** PATH-only view shaped like readPathFromLoginShell; still probes+caches the full set so the desktop and backend share entries */
export function createCachedLoginShellPathReader(
  options: CachedLoginShellEnvironmentOptions = {},
): (shell: string, execFile?: Parameters<ShellEnvironmentReader>[2]) => string | undefined {
  const read = createCachedLoginShellEnvironmentReader(options);
  return (shell, execFile) => read(shell, ["PATH"], execFile).PATH;
}
